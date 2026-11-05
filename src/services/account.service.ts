import { SENTODO_BANK, BANKS } from '../data/catalogue.data';
import type { Account, Profile } from '../domain/entities.model';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../errors/app.errors';
import type { ProviderRegistry } from '../providers/mock/mock.providers';
import type { AccountRepository, Repositories } from '../repositories/interfaces/repositories.interface';
import { generateReference } from '../utils/crypto.util';
import { assertPositiveKobo, type Kobo } from '../utils/money.util';
import { generateAccountNumber } from '../utils/nigeria.util';
import type { AppCommandCentre } from './commandCentre.service';
import { adjustBalance } from './ledger.helper';
import { displayName } from './views.mapper';

/** The most accounts one profile may hold. */
export const MAX_ACCOUNTS_PER_PROFILE = 5;

/** The largest single sandbox funding, in kobo (NGN 1,000,000). */
export const MAX_SANDBOX_FUNDING: Kobo = 100_000_000;

/** A resolved transfer recipient. */
export interface ResolvedRecipient {
  accountNumber: string;
  accountName: string;
  bankCode: string;
  bankName: string;
  /** True when the recipient is a Sentodo account (the transfer will be treated as p2p). */
  isSentodo: boolean;
}

/** Account opening, lookup and recipient resolution. */
export class AccountService {
  constructor(
    private readonly repositories: Repositories,
    private readonly providers: ProviderRegistry,
    private readonly commandCentre: AppCommandCentre,
  ) {}

  /**
   * Creates an account with a freshly generated 10-digit number. Retries on the (unlikely) event
   * of a collision, which the repository reports as a ConflictError.
   * @param {string} profileId - The owner.
   * @param {string} name - The account name.
   * @returns {Promise<Account>} The new account.
   */
  async openAccount(profileId: string, name: string): Promise<Account> {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        return await this.repositories.accounts.create({ accountNumber: generateAccountNumber(), profileId, name });
      } catch (error) {
        if (error instanceof ConflictError && attempt < 5) continue;
        throw error;
      }
    }
    throw new ConflictError('Unable to allocate an account number');
  }

  /**
   * Opens an additional account for a verified profile.
   * @param {Profile} profile - The authenticated profile.
   * @param {string | undefined} name - Optional account name; defaults to the profile's display name.
   * @returns {Promise<Account>} The new account.
   */
  async createForProfile(profile: Profile, name?: string): Promise<Account> {
    await this.commandCentre.assertFeature('account-creation');
    if (!profile.emailVerifiedAt || !profile.phoneVerifiedAt) {
      throw new ForbiddenError('Verify your email and phone number before opening an account');
    }
    const existing = await this.repositories.accounts.listByProfile(profile.id);
    if (existing.length >= MAX_ACCOUNTS_PER_PROFILE) {
      throw new BadRequestError(`A profile can hold at most ${MAX_ACCOUNTS_PER_PROFILE} accounts`);
    }
    return this.openAccount(profile.id, name ?? displayName(profile));
  }

  /** @returns {Promise<Account[]>} Every account the profile owns. */
  listForProfile(profileId: string): Promise<Account[]> {
    return this.repositories.accounts.listByProfile(profileId);
  }

  /**
   * Loads an account owned by the profile. Accounts of other profiles are reported as not found,
   * so their existence is not revealed.
   * @param {string} profileId - The owner.
   * @param {string} accountId - The account id.
   * @returns {Promise<Account>} The account.
   * @throws {NotFoundError} If it does not exist or belongs to someone else.
   */
  async getOwned(profileId: string, accountId: string): Promise<Account> {
    const account = await this.repositories.accounts.findById(accountId);
    if (!account || account.profileId !== profileId) throw new NotFoundError('Account not found');
    return account;
  }

  /**
   * Resolves a destination account to its holder's name. Sentodo accounts are looked up locally;
   * other banks go through the transfer provider.
   * @param {string} bankCode - The destination bank code.
   * @param {string} accountNumber - The 10-digit account number.
   * @returns {Promise<ResolvedRecipient>} The recipient details.
   */
  async resolveRecipient(bankCode: string, accountNumber: string): Promise<ResolvedRecipient> {
    const bank = BANKS.find((candidate) => candidate.code === bankCode);
    if (!bank) throw new BadRequestError('Unknown bank code');

    if (bank.code === SENTODO_BANK.code) {
      const account = await this.repositories.accounts.findByAccountNumber(accountNumber);
      if (!account || account.status !== 'ACTIVE') throw new NotFoundError('Recipient account not found');
      return { accountNumber, accountName: account.name, bankCode: bank.code, bankName: bank.name, isSentodo: true };
    }

    await this.commandCentre.assertFeature('transfers.external');
    await this.commandCentre.assertProvider(this.providers.transfer.id);
    const { accountName } = await this.providers.transfer.resolveAccount(bank.code, accountNumber);
    return { accountNumber, accountName, bankCode: bank.code, bankName: bank.name, isSentodo: false };
  }

  /**
   * Credits an account with test money. Only available while the command centre has
   * "sandbox-funding" switched on (off by default), so it cannot be used in production by accident.
   * @param {Profile} profile - The owner.
   * @param {string} accountId - The account to fund.
   * @param {Kobo} amount - The amount in kobo.
   * @returns {Promise<Account>} The updated account.
   */
  async sandboxFund(profile: Profile, accountId: string, amount: Kobo): Promise<Account> {
    await this.commandCentre.assertFeature('sandbox-funding');
    assertPositiveKobo(amount);
    if (amount > MAX_SANDBOX_FUNDING) throw new BadRequestError('Amount exceeds the sandbox funding limit');
    const account = await this.getOwned(profile.id, accountId);

    return this.repositories.unitOfWork.run(async (repos) => {
      const transaction = await repos.transactions.create({
        reference: generateReference(),
        profileId: profile.id,
        accountId: account.id,
        type: 'FUNDING',
        status: 'SUCCESS',
        amount,
        fee: 0,
        discount: 0,
        totalDebit: 0,
        feeWaived: false,
        narration: 'Sandbox funding',
      });
      return adjustBalance(repos, account.id, amount, {
        transactionId: transaction.id,
        direction: 'CREDIT',
        description: 'Sandbox funding',
      });
    });
  }
}

export type { AccountRepository };
