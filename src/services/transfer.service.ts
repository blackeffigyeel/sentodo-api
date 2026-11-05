import type { Profile, Transaction } from '../domain/entities.model';
import { calculateTransferFee, type TransferFee } from '../domain/pricing.rules';
import { BadRequestError } from '../errors/app.errors';
import type { Repositories } from '../repositories/interfaces/repositories.interface';
import { assertPositiveKobo, type Kobo } from '../utils/money.util';
import { startOfLagosMonth } from '../utils/nigeria.util';
import type { AccountService } from './account.service';
import type { AppCommandCentre } from './commandCentre.service';
import type { TransactionService } from './transaction.service';

/** Smallest transfer: NGN 1. */
export const MIN_TRANSFER: Kobo = 100;
/** Largest single transfer: NGN 5,000,000. */
export const MAX_TRANSFER: Kobo = 500_000_000;

/** A validated transfer request. */
export interface TransferInput {
  fromAccountId: string;
  bankCode: string;
  accountNumber: string;
  amount: Kobo;
  narration?: string;
  idempotencyKey?: string;
}

/** A fee quote, so clients can show the cost before confirming. */
export interface TransferQuote {
  amount: Kobo;
  fee: TransferFee;
  totalDebit: Kobo;
  freeTransfersRemaining: number;
  recipient: { accountName: string; bankName: string; isSentodo: boolean };
}

/** P2P and interbank transfers. A Sentodo recipient makes the transfer p2p automatically. */
export class TransferService {
  constructor(
    private readonly repositories: Repositories,
    private readonly accounts: AccountService,
    private readonly transactions: TransactionService,
    private readonly commandCentre: AppCommandCentre,
    private readonly freeAllowance: Record<Profile['type'], number>,
  ) {}

  private async freeTransfersUsed(profile: Profile): Promise<number> {
    return this.repositories.transactions.countFreeTransfersSince(profile.id, startOfLagosMonth());
  }

  /**
   * Resolves the recipient and prices the transfer without moving money.
   * @param {Profile} profile - The sender.
   * @param {Omit<TransferInput, 'idempotencyKey' | 'narration'>} input - The transfer details.
   * @returns {Promise<TransferQuote>} The fee, total and recipient.
   */
  async quote(profile: Profile, input: Omit<TransferInput, 'idempotencyKey' | 'narration'>): Promise<TransferQuote> {
    assertPositiveKobo(input.amount);
    this.assertAmountInRange(input.amount);
    await this.accounts.getOwned(profile.id, input.fromAccountId);
    const recipient = await this.accounts.resolveRecipient(input.bankCode, input.accountNumber);
    await this.commandCentre.assertFeature(recipient.isSentodo ? 'transfers.p2p' : 'transfers.external');

    const used = await this.freeTransfersUsed(profile);
    const fee = calculateTransferFee(input.amount, used, profile.type);
    return {
      amount: input.amount,
      fee,
      totalDebit: input.amount + fee.total,
      freeTransfersRemaining: Math.max(0, this.freeAllowance[profile.type] - used - (fee.waived ? 1 : 0)),
      recipient: { accountName: recipient.accountName, bankName: recipient.bankName, isSentodo: recipient.isSentodo },
    };
  }

  private assertAmountInRange(amount: Kobo): void {
    if (amount < MIN_TRANSFER) throw new BadRequestError('The minimum transfer is NGN 1.00');
    if (amount > MAX_TRANSFER) throw new BadRequestError('The maximum single transfer is NGN 5,000,000.00');
  }

  /**
   * Starts a transfer. The sender is debited immediately; the recipient is credited (or the
   * other bank called) by the queue worker.
   * @param {Profile} profile - The sender.
   * @param {TransferInput} input - The transfer details.
   * @returns {Promise<Transaction>} The transaction in PROCESSING state.
   */
  async initiate(profile: Profile, input: TransferInput): Promise<Transaction> {
    this.transactions.assertCanTransact(profile);
    const repeat = await this.transactions.findByIdempotencyKey(profile.id, input.idempotencyKey);
    if (repeat) return repeat;

    assertPositiveKobo(input.amount);
    this.assertAmountInRange(input.amount);
    const account = await this.accounts.getOwned(profile.id, input.fromAccountId);
    const recipient = await this.accounts.resolveRecipient(input.bankCode, input.accountNumber);
    await this.commandCentre.assertFeature(recipient.isSentodo ? 'transfers.p2p' : 'transfers.external');

    let counterpartyAccountId: string | undefined;
    if (recipient.isSentodo) {
      const target = await this.repositories.accounts.findByAccountNumber(input.accountNumber);
      if (!target) throw new BadRequestError('Recipient account not found');
      if (target.id === account.id) throw new BadRequestError('You cannot transfer to the same account');
      counterpartyAccountId = target.id;
    }

    const used = await this.freeTransfersUsed(profile);
    const fee = calculateTransferFee(input.amount, used, profile.type);

    return this.transactions.submit({
      profile,
      account,
      type: recipient.isSentodo ? 'P2P_TRANSFER' : 'EXTERNAL_TRANSFER',
      amount: input.amount,
      fee: fee.total,
      feeWaived: fee.waived,
      idempotencyKey: input.idempotencyKey,
      counterpartyAccountId,
      counterpartyName: recipient.accountName,
      counterpartyBank: recipient.bankName,
      narration: input.narration,
      metadata: { bankCode: recipient.bankCode, accountNumber: recipient.accountNumber, fee },
      description: `Transfer to ${recipient.accountName}`,
    });
  }
}
