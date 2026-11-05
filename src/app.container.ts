import type { AppConfig } from './config/app.config';
import type { EmailSender } from './integrations/mailer.integration';
import type { ProviderRegistry } from './providers/mock/mock.providers';
import type { Queues } from './queues/queue.types';
import { createLimiterRegistry, type LimiterRegistry } from './rateLimit/rateLimit.registry';
import type { Repositories } from './repositories/interfaces/repositories.interface';
import type { Redis } from 'ioredis';
import { FREE_TRANSFERS_PER_MONTH } from './domain/pricing.rules';
import { AccountService } from './services/account.service';
import { ApiKeyService } from './services/apiKey.service';
import { AuthService } from './services/auth.service';
import { BillService } from './services/bill.service';
import { AppCommandCentre } from './services/commandCentre.service';
import { ProfileService } from './services/profile.service';
import { SettlementService } from './services/settlement.service';
import { TokenService } from './services/token.service';
import { TransactionService } from './services/transaction.service';
import { TransferService } from './services/transfer.service';
import type { Logger } from './utils/logger.util';

/** Infrastructure the application is wired from. Production and tests supply different ones. */
export interface AppInfrastructure {
  config: AppConfig;
  logger: Logger;
  repositories: Repositories;
  queues: Queues;
  providers: ProviderRegistry;
  emailSender: EmailSender;
  /** Present when the redis rate-limit store is used. */
  redis?: Redis;
  /** Readiness probes, keyed by dependency name. */
  healthChecks: Record<string, () => Promise<boolean>>;
  /** Overrides, mainly for tests. */
  overrides?: {
    limiters?: LimiterRegistry;
    bcryptRounds?: number;
    commandCentreCacheTtlMs?: number;
  };
}

/** Every constructed service, ready for the HTTP layer and the workers. */
export interface AppContainer extends AppInfrastructure {
  limiters: LimiterRegistry;
  tokens: TokenService;
  commandCentre: AppCommandCentre;
  settlement: SettlementService;
  accounts: AccountService;
  auth: AuthService;
  profiles: ProfileService;
  transactions: TransactionService;
  transfers: TransferService;
  bills: BillService;
  apiKeys: ApiKeyService;
}

/**
 * Composition root: the only place where concrete classes are wired together (Dependency
 * Inversion). Services receive abstractions, so swapping a repository, queue or provider is a
 * change here and nowhere else.
 * @param {AppInfrastructure} infrastructure - Config, repositories, queues and providers.
 * @returns {Promise<AppContainer>} The wired container, with the command centre seeded.
 */
export async function createContainer(infrastructure: AppInfrastructure): Promise<AppContainer> {
  const { config, repositories, queues, providers } = infrastructure;

  const limiters =
    infrastructure.overrides?.limiters ??
    createLimiterRegistry({ algorithm: config.rateLimit.algorithm, store: config.rateLimit.store, redis: infrastructure.redis });

  const commandCentre = new AppCommandCentre(repositories.serviceStates, providers, {
    cacheTtlMs: infrastructure.overrides?.commandCentreCacheTtlMs,
  });
  await commandCentre.initialise();

  const tokens = new TokenService(config.jwtSecret, config.jwtExpiresInSeconds);
  const settlement = new SettlementService(repositories, providers, commandCentre);
  const accounts = new AccountService(repositories, providers, commandCentre);
  const transactions = new TransactionService(repositories, queues.transactions, settlement);

  return {
    ...infrastructure,
    limiters,
    tokens,
    commandCentre,
    settlement,
    accounts,
    transactions,
    auth: new AuthService(repositories, commandCentre, tokens, accounts, queues.emails, providers.sms, {
      codeTtlSeconds: config.verificationCodeTtlSeconds,
      maxAttempts: config.verificationMaxAttempts,
      bcryptRounds: infrastructure.overrides?.bcryptRounds ?? 12,
    }),
    profiles: new ProfileService(repositories, providers.identity, commandCentre),
    transfers: new TransferService(repositories, accounts, transactions, commandCentre, FREE_TRANSFERS_PER_MONTH),
    bills: new BillService(providers, accounts, transactions, commandCentre),
    apiKeys: new ApiKeyService(repositories, commandCentre),
  };
}
