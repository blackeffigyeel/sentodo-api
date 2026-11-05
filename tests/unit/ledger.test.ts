import { ConcurrencyConflictError, InsufficientFundsError, NotFoundError, UnprocessableError } from '../../src/errors/app.errors';
import type { TransactionalRepositories } from '../../src/repositories/interfaces/repositories.interface';
import { createMemoryRepositories } from '../../src/repositories/memory/memory.repositories';
import { adjustBalance, MAX_LOCK_ATTEMPTS } from '../../src/services/ledger.helper';

async function setup(balance = 10_000) {
  const repositories = createMemoryRepositories();
  const account = await repositories.accounts.create({ accountNumber: '0123456789', profileId: 'p1', name: 'Test' });
  const funded = balance > 0 ? await repositories.accounts.updateBalance(account.id, account.version, balance) : account;
  return { repositories, account: funded };
}

/** Wraps repositories so the first `failures` balance writes lose the optimistic-locking race. */
function withConflicts(base: TransactionalRepositories, failures: number): { repositories: TransactionalRepositories; attempts: () => number } {
  let attempts = 0;
  const accounts = Object.create(base.accounts) as typeof base.accounts;
  accounts.updateBalance = async (id, version, balance) => {
    attempts += 1;
    if (attempts <= failures) throw new ConcurrencyConflictError();
    return base.accounts.updateBalance(id, version, balance);
  };
  return { repositories: { ...base, accounts }, attempts: () => attempts };
}

describe('adjustBalance (optimistic locking)', () => {
  it('debits, increments the version and writes a ledger entry', async () => {
    const { repositories, account } = await setup();
    const updated = await adjustBalance(repositories, account.id, 2_500, { transactionId: 't1', direction: 'DEBIT', description: 'Test' });
    expect(updated.balance).toBe(7_500);
    expect(updated.version).toBe(account.version + 1);
    const entries = await repositories.ledger.listByAccount(account.id, 10);
    expect(entries).toEqual([expect.objectContaining({ direction: 'DEBIT', amount: 2_500, balanceAfter: 7_500, transactionId: 't1' })]);
  });

  it('credits', async () => {
    const { repositories, account } = await setup(0);
    const updated = await adjustBalance(repositories, account.id, 900, { transactionId: 't1', direction: 'CREDIT', description: 'Test' });
    expect(updated.balance).toBe(900);
  });

  it('rejects overdrafts without changing anything', async () => {
    const { repositories, account } = await setup(1_000);
    await expect(adjustBalance(repositories, account.id, 1_001, { transactionId: 't', direction: 'DEBIT', description: 'x' })).rejects.toThrow(
      InsufficientFundsError,
    );
    expect((await repositories.accounts.findById(account.id))?.balance).toBe(1_000);
    expect(await repositories.ledger.listByAccount(account.id, 10)).toHaveLength(0);
  });

  it('rejects debits on frozen accounts but allows credits (so refunds always work)', async () => {
    const { repositories, account } = await setup(1_000);
    repositories.db.accounts.set(account.id, { ...account, status: 'FROZEN' });
    await expect(adjustBalance(repositories, account.id, 100, { transactionId: 't', direction: 'DEBIT', description: 'x' })).rejects.toThrow(UnprocessableError);
    await expect(adjustBalance(repositories, account.id, 100, { transactionId: 't', direction: 'CREDIT', description: 'x' })).resolves.toMatchObject({ balance: 1_100 });
  });

  it('rejects unknown accounts and non-positive amounts', async () => {
    const { repositories } = await setup();
    await expect(adjustBalance(repositories, 'missing', 1, { transactionId: 't', direction: 'CREDIT', description: 'x' })).rejects.toThrow(NotFoundError);
    const { repositories: r2, account } = await setup();
    await expect(adjustBalance(r2, account.id, 0, { transactionId: 't', direction: 'CREDIT', description: 'x' })).rejects.toThrow(UnprocessableError);
  });

  it('retries after losing the race and then succeeds', async () => {
    const { repositories, account } = await setup();
    const wrapped = withConflicts(repositories, 2);
    const updated = await adjustBalance(wrapped.repositories, account.id, 1_000, { transactionId: 't', direction: 'DEBIT', description: 'x' });
    expect(updated.balance).toBe(9_000);
    expect(wrapped.attempts()).toBe(3);
  });

  it('gives up with a concurrency conflict after the maximum attempts', async () => {
    const { repositories, account } = await setup();
    const wrapped = withConflicts(repositories, 99);
    await expect(
      adjustBalance(wrapped.repositories, account.id, 1_000, { transactionId: 't', direction: 'DEBIT', description: 'x' }),
    ).rejects.toThrow(ConcurrencyConflictError);
    expect(wrapped.attempts()).toBe(MAX_LOCK_ATTEMPTS);
    expect((await repositories.accounts.findById(account.id))?.balance).toBe(10_000);
  });

  it('lets moderately contended writers all succeed', async () => {
    const { repositories, account } = await setup(100_000);
    await Promise.all(
      Array.from({ length: 6 }, (_, i) => adjustBalance(repositories, account.id, 1_000, { transactionId: `t${i}`, direction: 'DEBIT', description: 'x' })),
    );
    expect((await repositories.accounts.findById(account.id))?.balance).toBe(94_000);
  });

  it('never loses an update under heavy contention: the balance always equals the successful writes', async () => {
    const { repositories, account } = await setup(100_000);
    const results = await Promise.allSettled(
      Array.from({ length: 40 }, (_, i) => adjustBalance(repositories, account.id, 1_000, { transactionId: `t${i}`, direction: 'DEBIT', description: 'x' })),
    );
    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    for (const result of results) {
      if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(ConcurrencyConflictError);
    }
    expect(succeeded).toBeGreaterThan(0);
    expect((await repositories.accounts.findById(account.id))?.balance).toBe(100_000 - succeeded * 1_000);
    expect(await repositories.ledger.listByAccount(account.id, 100)).toHaveLength(succeeded);
  });
});

describe('memory unit of work', () => {
  it('rolls back every write when the callback throws', async () => {
    const { repositories, account } = await setup(5_000);
    await expect(
      repositories.unitOfWork.run(async (repos) => {
        await adjustBalance(repos, account.id, 1_000, { transactionId: 't', direction: 'DEBIT', description: 'x' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect((await repositories.accounts.findById(account.id))?.balance).toBe(5_000);
    expect(await repositories.ledger.listByAccount(account.id, 10)).toHaveLength(0);
  });

  it('commits when the callback succeeds', async () => {
    const { repositories, account } = await setup(5_000);
    await repositories.unitOfWork.run((repos) => adjustBalance(repos, account.id, 1_000, { transactionId: 't', direction: 'DEBIT', description: 'x' }));
    expect((await repositories.accounts.findById(account.id))?.balance).toBe(4_000);
  });
});
