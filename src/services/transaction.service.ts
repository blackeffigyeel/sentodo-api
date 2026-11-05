import type { Account, Profile, Transaction, TransactionStatus, TransactionType } from '../domain/entities.model';
import { COST_SCHEDULE } from '../domain/pricing.rules';
import { ConflictError, ForbiddenError, NotFoundError, ServiceUnavailableError } from '../errors/app.errors';
import type { JobQueue, TransactionJob } from '../queues/queue.types';
import type { Repositories } from '../repositories/interfaces/repositories.interface';
import { generateReference } from '../utils/crypto.util';
import { addKobo, assertKobo, subtractKobo, type Kobo } from '../utils/money.util';
import { adjustBalance } from './ledger.helper';
import type { SettlementService } from './settlement.service';

/** Everything needed to take money from an account and queue the work. */
export interface SubmitTransactionInput {
  profile: Profile;
  account: Account;
  type: TransactionType;
  amount: Kobo;
  fee?: Kobo;
  discount?: Kobo;
  feeWaived?: boolean;
  idempotencyKey?: string;
  counterpartyAccountId?: string;
  counterpartyName?: string;
  counterpartyBank?: string;
  provider?: string;
  narration?: string;
  metadata?: Record<string, unknown>;
  /** Ledger description for the debit. */
  description: string;
}

/**
 * The shared "debit now, settle later" pipeline used by transfers and bill payments.
 *
 * In one database transaction it records the transaction, debits the sender with optimistic
 * locking, writes the ledger entry and (for free transfers) the cost record. After the commit
 * the transaction is queued, so the HTTP response returns immediately with status PROCESSING.
 */
export class TransactionService {
  constructor(
    private readonly repositories: Repositories,
    private readonly queue: JobQueue<TransactionJob>,
    private readonly settlement: SettlementService,
  ) {}

  /**
   * Money may only leave an account once the profile is active and its identity is verified.
   * @param {Profile} profile - The acting profile.
   * @throws {ForbiddenError} If the profile may not transact.
   */
  assertCanTransact(profile: Profile): void {
    if (profile.status !== 'ACTIVE') throw new ForbiddenError('This profile has been suspended');
    if (!profile.identityVerifiedAt) throw new ForbiddenError('Verify your identity before making transactions');
  }

  /**
   * Looks up an earlier request made with the same idempotency key.
   * @param {string} profileId - The acting profile.
   * @param {string | undefined} key - The idempotency key, if the client sent one.
   * @returns {Promise<Transaction | null>} The earlier transaction, if any.
   */
  async findByIdempotencyKey(profileId: string, key: string | undefined): Promise<Transaction | null> {
    return key ? this.repositories.transactions.findByIdempotencyKey(profileId, key) : null;
  }

  /**
   * Debits the account and queues settlement.
   * @param {SubmitTransactionInput} input - The transaction details.
   * @returns {Promise<Transaction>} The transaction in PROCESSING state.
   * @throws {InsufficientFundsError} If the account cannot cover the total.
   * @throws {ServiceUnavailableError} If the job could not be queued (the debit is refunded first).
   */
  async submit(input: SubmitTransactionInput): Promise<Transaction> {
    const fee = assertKobo(input.fee ?? 0);
    const discount = assertKobo(input.discount ?? 0);
    const totalDebit = subtractKobo(addKobo(input.amount, fee), discount);

    let transaction: Transaction;
    try {
      transaction = await this.repositories.unitOfWork.run(async (repos) => {
        const created = await repos.transactions.create({
          reference: generateReference(),
          idempotencyKey: input.idempotencyKey,
          profileId: input.profile.id,
          accountId: input.account.id,
          type: input.type,
          status: 'PROCESSING',
          amount: input.amount,
          fee,
          discount,
          totalDebit,
          feeWaived: input.feeWaived ?? false,
          counterpartyAccountId: input.counterpartyAccountId,
          counterpartyName: input.counterpartyName,
          counterpartyBank: input.counterpartyBank,
          provider: input.provider,
          narration: input.narration,
          metadata: input.metadata,
        });
        await adjustBalance(repos, input.account.id, totalDebit, {
          transactionId: created.id,
          direction: 'DEBIT',
          description: input.description,
        });
        if (input.feeWaived) {
          await repos.costs.add({
            type: 'FREE_TRANSFER',
            amount: COST_SCHEDULE.FREE_TRANSFER,
            profileId: input.profile.id,
            reference: created.reference,
          });
        }
        return created;
      });
    } catch (error) {
      // A concurrent request with the same idempotency key won the race: return its result.
      if (error instanceof ConflictError && input.idempotencyKey) {
        const existing = await this.findByIdempotencyKey(input.profile.id, input.idempotencyKey);
        if (existing) return existing;
      }
      throw error;
    }

    try {
      await this.queue.add({ transactionId: transaction.id }, { jobId: transaction.id });
    } catch (error) {
      await this.settlement.failAndRefund(transaction.id, 'The transaction could not be queued');
      throw new ServiceUnavailableError('We could not process your transaction right now. You have not been charged.');
    }
    return transaction;
  }

  /**
   * @param {string} profileId - The owner.
   * @param {string} id - A transaction id or reference.
   * @returns {Promise<Transaction>} The transaction.
   * @throws {NotFoundError} If it does not exist or belongs to someone else.
   */
  async getOwned(profileId: string, id: string): Promise<Transaction> {
    const found =
      (await this.repositories.transactions.findById(id).catch(() => null)) ??
      (await this.repositories.transactions.findByReference(id));
    if (!found || found.profileId !== profileId) throw new NotFoundError('Transaction not found');
    return found;
  }

  /**
   * Lists a profile's transactions, newest first, with cursor pagination.
   * @param {object} query - Filters.
   * @returns {Promise<Transaction[]>} The page of transactions.
   */
  list(query: {
    profileId: string;
    accountId?: string;
    type?: TransactionType;
    status?: TransactionStatus;
    limit: number;
    before?: Date;
  }): Promise<Transaction[]> {
    return this.repositories.transactions.list(query);
  }
}
