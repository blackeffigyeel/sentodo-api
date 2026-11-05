import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { createContainer } from '../../src/app.container';
import { loadConfig } from '../../src/config/app.config';
import { ConcurrencyConflictError, ConflictError, NotFoundError } from '../../src/errors/app.errors';
import { RecordingEmailSender } from '../../src/integrations/mailer.integration';
import { createMockProviderRegistry } from '../../src/providers/mock/mock.providers';
import { InMemoryJobQueue, type EmailJob, type TransactionJob } from '../../src/queues/queue.types';
import type { Repositories } from '../../src/repositories/interfaces/repositories.interface';
import { createMemoryRepositories } from '../../src/repositories/memory/memory.repositories';
import {
  PostgresAccountRepository,
  PostgresApiKeyRepository,
  PostgresCostRepository,
  PostgresLedgerRepository,
  PostgresProfileRepository,
  PostgresTransactionRepository,
  PostgresUnitOfWork,
} from '../../src/repositories/postgres/postgres.repositories';
import { createApp } from '../../src/express.app';
import { adjustBalance } from '../../src/services/ledger.helper';
import { silentLogger } from '../../src/utils/logger.util';
import { generousLimiters } from '../helpers/testApp';

/**
 * Runs the real Prisma repositories against a real PostgreSQL database that already has the
 * migration applied. Set TEST_DATABASE_URL to enable, e.g.
 *   TEST_DATABASE_URL=postgresql://sentodo@127.0.0.1:5439/sentodo_test npm test
 */
const url = process.env.TEST_DATABASE_URL;
const api = '/api/v1';

(url ? describe : describe.skip)('PostgreSQL repositories (Prisma, real database)', () => {
  let prisma: PrismaClient;
  let repos: Repositories;

  beforeAll(async () => {
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
    await prisma.$connect();
    const memory = createMemoryRepositories();
    repos = {
      profiles: new PostgresProfileRepository(prisma),
      accounts: new PostgresAccountRepository(prisma),
      transactions: new PostgresTransactionRepository(prisma),
      ledger: new PostgresLedgerRepository(prisma),
      apiKeys: new PostgresApiKeyRepository(prisma),
      costs: new PostgresCostRepository(prisma),
      unitOfWork: new PostgresUnitOfWork(prisma),
      verificationCodes: memory.verificationCodes,
      auditLogs: memory.auditLogs,
      serviceStates: memory.serviceStates,
    };
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE ledger_entries, transactions, api_keys, cost_records, accounts, profiles RESTART IDENTITY CASCADE',
    );
  });

  const newProfile = (n = 1) =>
    repos.profiles.create({ type: 'INDIVIDUAL', email: `user${n}@example.com`, phone: `0803000000${n}`, passwordHash: 'hash', firstName: 'A', lastName: 'B' });

  const newAccount = async (profileId: string, number = '0123456789', balance = 0) => {
    const account = await repos.accounts.create({ accountNumber: number, profileId, name: 'Main' });
    return balance > 0 ? repos.accounts.updateBalance(account.id, account.version, balance) : account;
  };

  describe('profiles', () => {
    it('creates, finds and updates', async () => {
      const profile = await newProfile();
      expect(profile).toMatchObject({ type: 'INDIVIDUAL', status: 'ACTIVE', emailVerifiedAt: null });
      expect((await repos.profiles.findByEmail('user1@example.com'))?.id).toBe(profile.id);
      expect((await repos.profiles.findByPhone('08030000001'))?.id).toBe(profile.id);
      const updated = await repos.profiles.update(profile.id, { emailVerifiedAt: new Date() });
      expect(updated.emailVerifiedAt).toBeInstanceOf(Date);
      expect(await repos.profiles.findById('00000000-0000-0000-0000-000000000000')).toBeNull();
    });

    it('maps unique violations to ConflictError and missing rows to NotFoundError', async () => {
      await newProfile();
      await expect(newProfile()).rejects.toThrow(ConflictError);
      await expect(repos.profiles.update('missing', { status: 'SUSPENDED' })).rejects.toThrow(NotFoundError);
    });

    it('allows one BVN hash per profile', async () => {
      const a = await newProfile(1);
      const b = await newProfile(2);
      await repos.profiles.update(a.id, { bvnHash: 'abc' });
      await expect(repos.profiles.update(b.id, { bvnHash: 'abc' })).rejects.toThrow(ConflictError);
    });
  });

  describe('accounts and optimistic locking', () => {
    it('stores balances as BigInt and returns safe integers', async () => {
      const profile = await newProfile();
      const account = await newAccount(profile.id, '0123456789', 123_456_789);
      expect(account.balance).toBe(123_456_789);
      expect(typeof account.balance).toBe('number');
      expect(account.version).toBe(1);
    });

    it('rejects a stale version with ConcurrencyConflictError and leaves the balance alone', async () => {
      const profile = await newProfile();
      const account = await newAccount(profile.id, '0123456789', 1_000);
      await repos.accounts.updateBalance(account.id, account.version, 900);
      await expect(repos.accounts.updateBalance(account.id, account.version, 500)).rejects.toThrow(ConcurrencyConflictError);
      expect((await repos.accounts.findById(account.id))?.balance).toBe(900);
      await expect(repos.accounts.updateBalance('missing', 0, 1)).rejects.toThrow(NotFoundError);
    });

    it('rejects duplicate account numbers', async () => {
      const profile = await newProfile();
      await newAccount(profile.id, '0123456789');
      await expect(newAccount(profile.id, '0123456789')).rejects.toThrow(ConflictError);
    });

    it('is protected by database CHECK constraints even if application code is wrong', async () => {
      const profile = await newProfile();
      const account = await newAccount(profile.id, '0123456789', 100);
      await expect(repos.accounts.updateBalance(account.id, account.version, -1)).rejects.toThrow();
      await expect(repos.accounts.create({ accountNumber: '12345', profileId: profile.id, name: 'Bad' })).rejects.toThrow();
    });

    it('never loses an update when many real connections race (no lost money)', async () => {
      const profile = await newProfile();
      const account = await newAccount(profile.id, '0123456789', 1_000_000);
      const tx = await repos.transactions.create({
        reference: 'REF-RACE', profileId: profile.id, accountId: account.id, type: 'AIRTIME', amount: 1, fee: 0, discount: 0, totalDebit: 1, feeWaived: false,
      });

      const results = await Promise.allSettled(
        Array.from({ length: 25 }, () =>
          repos.unitOfWork.run((r) => adjustBalance(r, account.id, 1_000, { transactionId: tx.id, direction: 'DEBIT', description: 'race' })),
        ),
      );
      const succeeded = results.filter((r) => r.status === 'fulfilled').length;
      for (const result of results) if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(ConcurrencyConflictError);

      expect(succeeded).toBeGreaterThan(0);
      const final = await repos.accounts.findById(account.id);
      expect(final?.balance).toBe(1_000_000 - succeeded * 1_000);
      expect(await repos.ledger.listByAccount(account.id, 100)).toHaveLength(succeeded);
      expect(final?.version).toBe(account.version + succeeded);
    });
  });

  describe('unit of work', () => {
    it('commits everything together', async () => {
      const profile = await newProfile();
      const account = await newAccount(profile.id, '0123456789', 5_000);
      await repos.unitOfWork.run(async (r) => {
        const tx = await r.transactions.create({ reference: 'REF-OK', profileId: profile.id, accountId: account.id, type: 'DATA', amount: 1_000, fee: 0, discount: 0, totalDebit: 1_000, feeWaived: false });
        await adjustBalance(r, account.id, 1_000, { transactionId: tx.id, direction: 'DEBIT', description: 'x' });
      });
      expect((await repos.accounts.findById(account.id))?.balance).toBe(4_000);
      expect(await repos.transactions.findByReference('REF-OK')).not.toBeNull();
    });

    it('rolls back the transaction row, balance and ledger when anything fails', async () => {
      const profile = await newProfile();
      const account = await newAccount(profile.id, '0123456789', 5_000);
      await expect(
        repos.unitOfWork.run(async (r) => {
          const tx = await r.transactions.create({ reference: 'REF-ROLL', profileId: profile.id, accountId: account.id, type: 'DATA', amount: 1_000, fee: 0, discount: 0, totalDebit: 1_000, feeWaived: false });
          await adjustBalance(r, account.id, 1_000, { transactionId: tx.id, direction: 'DEBIT', description: 'x' });
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect((await repos.accounts.findById(account.id))?.balance).toBe(5_000);
      expect(await repos.transactions.findByReference('REF-ROLL')).toBeNull();
      expect(await repos.ledger.listByAccount(account.id, 10)).toHaveLength(0);
    });
  });

  describe('transactions', () => {
    const base = (profileId: string, accountId: string, reference: string, extra: Record<string, unknown> = {}) => ({
      reference, profileId, accountId, type: 'P2P_TRANSFER' as const, amount: 1_000, fee: 0, discount: 0, totalDebit: 1_000, feeWaived: true, ...extra,
    });

    it('enforces unique references and per-profile idempotency keys', async () => {
      const profile = await newProfile();
      const account = await newAccount(profile.id);
      await repos.transactions.create(base(profile.id, account.id, 'R1', { idempotencyKey: 'key-1' }));
      await expect(repos.transactions.create(base(profile.id, account.id, 'R1'))).rejects.toThrow(ConflictError);
      await expect(repos.transactions.create(base(profile.id, account.id, 'R2', { idempotencyKey: 'key-1' }))).rejects.toThrow(ConflictError);
      // Many transactions without a key are fine.
      await repos.transactions.create(base(profile.id, account.id, 'R3'));
      await repos.transactions.create(base(profile.id, account.id, 'R4'));
      expect((await repos.transactions.findByIdempotencyKey(profile.id, 'key-1'))?.reference).toBe('R1');
    });

    it('transition() is a compare-and-set: only one caller wins', async () => {
      const profile = await newProfile();
      const account = await newAccount(profile.id);
      const tx = await repos.transactions.create(base(profile.id, account.id, 'R-CAS', { status: 'PROCESSING' }));
      const results = await Promise.all(
        Array.from({ length: 10 }, () => repos.transactions.transition(tx.id, ['PROCESSING'], 'SUCCESS', { providerReference: 'P1' })),
      );
      expect(results.filter((r) => r !== null)).toHaveLength(1);
      expect((await repos.transactions.findById(tx.id))).toMatchObject({ status: 'SUCCESS', providerReference: 'P1' });
      expect(await repos.transactions.transition(tx.id, ['PROCESSING'], 'FAILED')).toBeNull();
    });

    it('round-trips JSON metadata and counts free transfers by status and date', async () => {
      const profile = await newProfile();
      const account = await newAccount(profile.id);
      await repos.transactions.create(base(profile.id, account.id, 'F1', { metadata: { bankCode: '058', nested: { a: 1 } } }));
      await repos.transactions.create(base(profile.id, account.id, 'F2', { status: 'FAILED' }));
      await repos.transactions.create(base(profile.id, account.id, 'F3', { feeWaived: false, fee: 1_075, totalDebit: 2_075 }));
      expect((await repos.transactions.findByReference('F1'))?.metadata).toEqual({ bankCode: '058', nested: { a: 1 } });
      expect(await repos.transactions.countFreeTransfersSince(profile.id, new Date(Date.now() - 60_000))).toBe(1);
      expect(await repos.transactions.countFreeTransfersSince(profile.id, new Date(Date.now() + 60_000))).toBe(0);
    });

    it('filters, orders and paginates', async () => {
      const profile = await newProfile();
      const account = await newAccount(profile.id);
      for (let i = 0; i < 5; i += 1) {
        await repos.transactions.create(base(profile.id, account.id, `L${i}`, { type: i % 2 ? 'AIRTIME' : 'P2P_TRANSFER' }));
        await new Promise((r) => setTimeout(r, 5));
      }
      const all = await repos.transactions.list({ profileId: profile.id, limit: 10 });
      expect(all.map((t) => t.reference)).toEqual(['L4', 'L3', 'L2', 'L1', 'L0']);
      expect(await repos.transactions.list({ profileId: profile.id, type: 'AIRTIME', limit: 10 })).toHaveLength(2);
      expect((await repos.transactions.list({ profileId: profile.id, limit: 10, before: all[1].createdAt })).map((t) => t.reference)).toEqual(['L2', 'L1', 'L0']);
    });

    it('enforces positive amounts at the database level', async () => {
      const profile = await newProfile();
      const account = await newAccount(profile.id);
      await expect(repos.transactions.create(base(profile.id, account.id, 'BAD', { amount: 0 }))).rejects.toThrow();
    });
  });

  describe('api keys and costs', () => {
    it('stores arrays of allowed IPs and finds keys by hash', async () => {
      const profile = await newProfile();
      const key = await repos.apiKeys.create({ profileId: profile.id, name: 'Prod', prefix: 'sk_live_abcd', keyHash: 'h1', allowedIps: ['41.58.1.9', '2001:db8::1'] });
      expect((await repos.apiKeys.findByHash('h1'))?.allowedIps).toEqual(['41.58.1.9', '2001:db8::1']);
      const updated = await repos.apiKeys.update(key.id, { allowedIps: ['10.0.0.1'], status: 'REVOKED', revokedAt: new Date() });
      expect(updated).toMatchObject({ allowedIps: ['10.0.0.1'], status: 'REVOKED' });
      expect(await repos.apiKeys.listByProfile(profile.id)).toHaveLength(1);
    });

    it('records costs in integer kobo', async () => {
      const profile = await newProfile();
      await repos.costs.add({ type: 'IDENTITY_VERIFICATION', amount: 5_000, profileId: profile.id });
      expect(await repos.costs.listByType('IDENTITY_VERIFICATION', 10)).toEqual([expect.objectContaining({ amount: 5_000 })]);
    });
  });

  describe('whole application on PostgreSQL', () => {
    it('registers, verifies, funds, transfers p2p and settles through the queue', async () => {
      const config = loadConfig({
        NODE_ENV: 'test', DATABASE_URL: url!, MONGODB_URI: 'mongodb://unused', REDIS_URL: 'redis://unused',
        JWT_SECRET: 'test-jwt-secret-0123456789', ADMIN_SERVICE_TOKEN: 'test-service-token-0123456789', LOG_LEVEL: 'silent',
      });
      const emails = new RecordingEmailSender();
      const transactionQueue = new InMemoryJobQueue<TransactionJob>();
      const emailQueue = new InMemoryJobQueue<EmailJob>();
      const container = await createContainer({
        config, logger: silentLogger, repositories: repos,
        queues: { transactions: transactionQueue, emails: emailQueue },
        providers: createMockProviderRegistry({ mockPhoneCodes: config.mockPhoneCodes }),
        emailSender: emails, healthChecks: {},
        overrides: { limiters: generousLimiters(), bcryptRounds: 4, commandCentreCacheTtlMs: 0 },
      });
      transactionQueue.setHandler(({ transactionId }) => container.settlement.settle(transactionId));
      emailQueue.setHandler((m) => emails.send(m));
      const app = createApp(container);
      await container.commandCentre.setState('sandbox-funding', true, { updatedBy: 'test' });

      const signUp = async (first: string, last: string, email: string, phone: string, bvn: string) => {
        await request(app).post(`${api}/auth/register`).send({ type: 'INDIVIDUAL', email, phone, password: 'Password123', firstName: first, lastName: last }).expect(201);
        await emailQueue.drain();
        const code = emails.sent.filter((m) => m.to === email).pop()!.text.match(/code is (\d{6})/)![1];
        await request(app).post(`${api}/auth/verify-email`).send({ email, code }).expect(200);
        await request(app).post(`${api}/auth/verify-phone`).send({ phone, code: '123456' }).expect(200);
        const login = await request(app).post(`${api}/auth/login`).send({ email, password: 'Password123' }).expect(200);
        const token = login.body.data.accessToken as string;
        await request(app).post(`${api}/profiles/me/identity`).set('Authorization', `Bearer ${token}`).send({ bvn }).expect(200);
        const accounts = await request(app).get(`${api}/accounts`).set('Authorization', `Bearer ${token}`).expect(200);
        return { token, account: accounts.body.data.accounts[0] as { id: string; accountNumber: string } };
      };

      const alice = await signUp('Adaeze', 'Okonkwo', 'adaeze@example.com', '08031234567', '22222222221');
      const bob = await signUp('Tunde', 'Bakare', 'tunde@example.com', '08122223333', '22222222222');
      await request(app).post(`${api}/accounts/${alice.account.id}/fund`).set('Authorization', `Bearer ${alice.token}`).send({ amount: 5_000_000 }).expect(200);

      const sent = await request(app)
        .post(`${api}/transfers`).set('Authorization', `Bearer ${alice.token}`)
        .send({ fromAccountId: alice.account.id, bankCode: '090', accountNumber: bob.account.accountNumber, amount: 250_000 })
        .expect(202);
      expect(sent.body.data.transaction.status).toBe('PROCESSING');
      expect((await repos.accounts.findById(alice.account.id))?.balance).toBe(4_750_000);
      expect((await repos.accounts.findById(bob.account.id))?.balance).toBe(0);

      await transactionQueue.drain();
      expect((await repos.accounts.findById(bob.account.id))?.balance).toBe(250_000);

      // A bill the provider declines is refunded in full inside real transactions.
      await request(app).post(`${api}/bills/airtime`).set('Authorization', `Bearer ${alice.token}`)
        .send({ fromAccountId: alice.account.id, network: 'MTN', phone: '08030000000', amount: 100_000 }).expect(202);
      await transactionQueue.drain();
      expect((await repos.accounts.findById(alice.account.id))?.balance).toBe(4_750_000);

      // Money is conserved: sum of ledger credits minus debits equals the balances.
      const rows = await prisma.$queryRaw<Array<{ net: bigint }>>`
        SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0) AS net FROM ledger_entries`;
      const balances = await prisma.$queryRaw<Array<{ total: bigint }>>`SELECT COALESCE(SUM(balance), 0) AS total FROM accounts`;
      expect(Number(rows[0].net)).toBe(Number(balances[0].total));
    });
  });
});
