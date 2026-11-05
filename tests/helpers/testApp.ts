import type { Express } from 'express';
import request from 'supertest';
import { createContainer, type AppContainer } from '../../src/app.container';
import { loadConfig } from '../../src/config/app.config';
import { RecordingEmailSender } from '../../src/integrations/mailer.integration';
import { createMockProviderRegistry } from '../../src/providers/mock/mock.providers';
import { InMemoryJobQueue, type EmailJob, type TransactionJob } from '../../src/queues/queue.types';
import { createRateLimiter } from '../../src/rateLimit/rateLimit.factory';
import { POLICIES, type PolicyName } from '../../src/rateLimit/rateLimit.policies';
import type { LimiterRegistry } from '../../src/rateLimit/rateLimit.registry';
import type { RateLimitPolicy } from '../../src/rateLimit/rateLimit.types';
import { createMemoryRepositories } from '../../src/repositories/memory/memory.repositories';
import { createApp } from '../../src/express.app';
import { silentLogger } from '../../src/utils/logger.util';

export const SERVICE_TOKEN = 'test-service-token-0123456789';

/** A person who can pass identity verification, using the mock BVN registry. */
export const PEOPLE = [
  { firstName: 'Adaeze', lastName: 'Okonkwo', bvn: '22222222221', phone: '08031234567', email: 'adaeze@example.com' },
  { firstName: 'Tunde', lastName: 'Bakare', bvn: '22222222222', phone: '08122223333', email: 'tunde@example.com' },
  { firstName: 'Fatima', lastName: 'Bello', bvn: '22222222223', phone: '09012345678', email: 'fatima@example.com' },
] as const;

export interface TestContext {
  app: Express;
  container: AppContainer;
  repositories: ReturnType<typeof createMemoryRepositories>;
  emails: RecordingEmailSender;
  transactionQueue: InMemoryJobQueue<TransactionJob>;
  emailQueue: InMemoryJobQueue<EmailJob>;
  /** Delivers queued emails and settles queued transactions. */
  drain(): Promise<void>;
}

/** Limits large enough that functional tests never trip them. */
export function generousLimiters(overrides: Partial<Record<PolicyName, Partial<RateLimitPolicy>>> = {}): LimiterRegistry {
  const entries = (Object.keys(POLICIES) as PolicyName[]).map((name) => {
    const policy: RateLimitPolicy = { ...POLICIES[name], limit: 100_000, burst: 100_000, ...overrides[name] };
    return [name, { policy, limiter: createRateLimiter({ algorithm: 'token-bucket', store: 'memory', policy }) }] as const;
  });
  return Object.fromEntries(entries) as LimiterRegistry;
}

/**
 * Builds a complete application backed by in-memory repositories, queues and mock providers.
 * @param {object} [options] - Optional overrides.
 * @param {Partial<Record<PolicyName, Partial<RateLimitPolicy>>>} [options.limits] - Tighter limits for rate-limit tests.
 * @returns {Promise<TestContext>} The app and its collaborators.
 */
export async function createTestContext(
  options: { limits?: Partial<Record<PolicyName, Partial<RateLimitPolicy>>>; failingPolicies?: PolicyName[] } = {},
): Promise<TestContext> {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://unused',
    MONGODB_URI: 'mongodb://unused',
    REDIS_URL: 'redis://unused',
    JWT_SECRET: 'test-jwt-secret-0123456789',
    ADMIN_SERVICE_TOKEN: SERVICE_TOKEN,
    MOCK_PHONE_CODES: '123456,654321',
    LOG_LEVEL: 'silent',
  });
  const limiters = generousLimiters(options.limits);
  for (const name of options.failingPolicies ?? []) {
    limiters[name].limiter = {
      algorithm: 'token-bucket',
      consume: async () => {
        throw new Error('Redis is down');
      },
    };
  }
  const repositories = createMemoryRepositories();
  const emails = new RecordingEmailSender();
  const transactionQueue = new InMemoryJobQueue<TransactionJob>();
  const emailQueue = new InMemoryJobQueue<EmailJob>();

  const container = await createContainer({
    config,
    logger: silentLogger,
    repositories,
    queues: { transactions: transactionQueue, emails: emailQueue },
    providers: createMockProviderRegistry({ mockPhoneCodes: config.mockPhoneCodes }),
    emailSender: emails,
    healthChecks: { memory: async () => true },
    overrides: { limiters, bcryptRounds: 4, commandCentreCacheTtlMs: 0 },
  });

  transactionQueue.setHandler(({ transactionId }) => container.settlement.settle(transactionId));
  emailQueue.setHandler((message) => emails.send(message));

  return {
    app: createApp(container),
    container,
    repositories,
    emails,
    transactionQueue,
    emailQueue,
    drain: async () => {
      await emailQueue.drain();
      await transactionQueue.drain();
    },
  };
}

/** A signed-in profile ready to transact. */
export interface TestUser {
  token: string;
  profileId: string;
  accountId: string;
  accountNumber: string;
  email: string;
}

/**
 * Registers, verifies and signs in a profile through the real HTTP endpoints.
 * @param {TestContext} ctx - The test context.
 * @param {object} [options] - Options.
 * @param {number} [options.person=0] - Index into {@link PEOPLE}.
 * @param {boolean} [options.corporate=false] - Register a corporate profile instead of an individual.
 * @param {boolean} [options.verifyIdentity=true] - Whether to complete BVN verification.
 * @param {number} [options.fundKobo=0] - Amount to credit with sandbox funding.
 * @returns {Promise<TestUser>} The user.
 */
export async function registerProfile(
  ctx: TestContext,
  options: { person?: number; corporate?: boolean; verifyIdentity?: boolean; fundKobo?: number } = {},
): Promise<TestUser> {
  const person = PEOPLE[options.person ?? 0];
  const password = 'Password123';
  const body = options.corporate
    ? { type: 'CORPORATE', email: person.email, phone: person.phone, password, businessName: `${person.lastName} Ventures Ltd` }
    : { type: 'INDIVIDUAL', email: person.email, phone: person.phone, password, firstName: person.firstName, lastName: person.lastName };

  await request(ctx.app).post('/api/v1/auth/register').send(body).expect(201);
  await ctx.drain();

  const message = [...ctx.emails.sent].reverse().find((sent) => sent.to === person.email);
  const code = message?.text.match(/code is (\d{6})/)?.[1];
  if (!code) throw new Error('Verification email was not sent');

  await request(ctx.app).post('/api/v1/auth/verify-email').send({ email: person.email, code }).expect(200);
  await request(ctx.app).post('/api/v1/auth/verify-phone').send({ phone: person.phone, code: '123456' }).expect(200);

  const login = await request(ctx.app).post('/api/v1/auth/login').send({ email: person.email, password }).expect(200);
  const token = login.body.data.accessToken as string;
  const profileId = login.body.data.profile.id as string;

  if (options.verifyIdentity !== false) {
    await request(ctx.app).post('/api/v1/profiles/me/identity').set('Authorization', `Bearer ${token}`).send({ bvn: person.bvn }).expect(200);
  }

  const accounts = await request(ctx.app).get('/api/v1/accounts').set('Authorization', `Bearer ${token}`).expect(200);
  const account = accounts.body.data.accounts[0] as { id: string; accountNumber: string };

  if (options.fundKobo) {
    await ctx.container.commandCentre.setState('sandbox-funding', true, { updatedBy: 'test' });
    await request(ctx.app)
      .post(`/api/v1/accounts/${account.id}/fund`)
      .set('Authorization', `Bearer ${token}`)
      .send({ amount: options.fundKobo })
      .expect(200);
  }
  return { token, profileId, accountId: account.id, accountNumber: account.accountNumber, email: person.email };
}

/** Registers an individual profile. See {@link registerProfile}. */
export const registerIndividual = (
  ctx: TestContext,
  options: { person?: number; verifyIdentity?: boolean; fundKobo?: number } = {},
): Promise<TestUser> => registerProfile(ctx, options);

/** Registers a corporate profile. See {@link registerProfile}. */
export const registerCorporate = (
  ctx: TestContext,
  options: { person?: number; verifyIdentity?: boolean; fundKobo?: number } = {},
): Promise<TestUser> => registerProfile(ctx, { person: 2, ...options, corporate: true });

/** Shorthand for an authorised supertest agent call. */
export const bearer = (token: string): { Authorization: string } => ({ Authorization: `Bearer ${token}` });

/** Reads an account's balance in kobo straight from the repository. */
export async function balanceOf(ctx: TestContext, accountId: string): Promise<number> {
  const account = await ctx.repositories.accounts.findById(accountId);
  if (!account) throw new Error('Account not found');
  return account.balance;
}
