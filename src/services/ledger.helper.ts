import type { Account, LedgerDirection } from '../domain/entities.model';
import { ConcurrencyConflictError, InsufficientFundsError, NotFoundError, UnprocessableError } from '../errors/app.errors';
import type { TransactionalRepositories } from '../repositories/interfaces/repositories.interface';
import { assertKobo, type Kobo } from '../utils/money.util';

/** How many times a balance change is retried after losing an optimistic-locking race. */
export const MAX_LOCK_ATTEMPTS = 8;

/** Waits a short, randomised time so competing writers stop retrying in lock-step. */
const backoff = (attempt: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.random() * 4 * attempt));

/** Describes one ledger line produced by a balance change. */
export interface BalanceChange {
  transactionId: string;
  direction: LedgerDirection;
  description: string;
}

/**
 * Changes an account balance with optimistic locking and writes the matching ledger entry.
 *
 * The account is read, the new balance is calculated in integer kobo, and the write only succeeds
 * if the account's version is unchanged. Losing the race triggers a short jittered backoff, a re-read and a retry. Call this
 * inside a unit of work so the balance change, ledger entry and transaction record commit together.
 *
 * @param {TransactionalRepositories} repositories - Repositories bound to the current unit of work.
 * @param {string} accountId - The account to change.
 * @param {Kobo} amount - The positive amount to move, in kobo.
 * @param {BalanceChange} change - Direction and ledger metadata.
 * @returns {Promise<Account>} The updated account.
 * @throws {NotFoundError} If the account does not exist.
 * @throws {UnprocessableError} If a debit is attempted on an account that is not active.
 * @throws {InsufficientFundsError} If a debit would make the balance negative.
 * @throws {ConcurrencyConflictError} If every attempt lost the race.
 */
export async function adjustBalance(
  repositories: TransactionalRepositories,
  accountId: string,
  amount: Kobo,
  change: BalanceChange,
): Promise<Account> {
  assertKobo(amount);
  if (amount <= 0) throw new UnprocessableError('Amount must be greater than zero');

  for (let attempt = 1; attempt <= MAX_LOCK_ATTEMPTS; attempt += 1) {
    const account = await repositories.accounts.findById(accountId);
    if (!account) throw new NotFoundError('Account not found');

    if (change.direction === 'DEBIT') {
      if (account.status !== 'ACTIVE') throw new UnprocessableError('The account is not active');
      if (account.balance < amount) throw new InsufficientFundsError('Insufficient funds', { balance: account.balance });
    }

    const newBalance = change.direction === 'DEBIT' ? account.balance - amount : account.balance + amount;
    try {
      const updated = await repositories.accounts.updateBalance(account.id, account.version, newBalance);
      await repositories.ledger.add([
        {
          transactionId: change.transactionId,
          accountId: account.id,
          direction: change.direction,
          amount,
          balanceAfter: updated.balance,
          description: change.description,
        },
      ]);
      return updated;
    } catch (error) {
      if (error instanceof ConcurrencyConflictError && attempt < MAX_LOCK_ATTEMPTS) {
        await backoff(attempt);
        continue;
      }
      throw error;
    }
  }
  throw new ConcurrencyConflictError();
}
