import type { Server } from 'http';
import { createContainer } from './app.container';
import { loadConfig } from './config/app.config';
import { createApp } from './express.app';
import { NodemailerEmailSender } from './integrations/mailer.integration';
import { connectMongo, pingMongo } from './integrations/mongo.integration';
import { connectPrisma, pingPrisma } from './integrations/prisma.integration';
import { BullJobQueue } from './integrations/queue.integration';
import { connectRedis, pingRedis } from './integrations/redis.integration';
import { createMockProviderRegistry } from './providers/mock/mock.providers';
import { QUEUE_NAMES, type EmailJob, type TransactionJob } from './queues/queue.types';
import { MongoAuditLogRepository, MongoServiceStateRepository, MongoVerificationCodeRepository } from './repositories/mongo/mongo.repositories';
import {
  PostgresAccountRepository,
  PostgresApiKeyRepository,
  PostgresCostRepository,
  PostgresLedgerRepository,
  PostgresProfileRepository,
  PostgresTransactionRepository,
  PostgresUnitOfWork,
} from './repositories/postgres/postgres.repositories';
import type { Repositories } from './repositories/interfaces/repositories.interface';
import { createLogger } from './utils/logger.util';

/** Starts the HTTP API. Run `queue.worker.ts` separately to process queued jobs. */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  const prisma = await connectPrisma(config.databaseUrl, logger);
  const mongo = await connectMongo(config.mongodbUri, logger);
  const redis = await connectRedis(config.redisUrl, logger);

  const repositories: Repositories = {
    profiles: new PostgresProfileRepository(prisma),
    accounts: new PostgresAccountRepository(prisma),
    transactions: new PostgresTransactionRepository(prisma),
    ledger: new PostgresLedgerRepository(prisma),
    apiKeys: new PostgresApiKeyRepository(prisma),
    costs: new PostgresCostRepository(prisma),
    unitOfWork: new PostgresUnitOfWork(prisma),
    verificationCodes: new MongoVerificationCodeRepository(mongo),
    auditLogs: new MongoAuditLogRepository(mongo),
    serviceStates: new MongoServiceStateRepository(mongo),
  };

  const transactionQueue = new BullJobQueue<TransactionJob>(QUEUE_NAMES.transactions, redis);
  const emailQueue = new BullJobQueue<EmailJob>(QUEUE_NAMES.emails, redis);

  const container = await createContainer({
    config,
    logger,
    repositories,
    queues: { transactions: transactionQueue, emails: emailQueue },
    providers: createMockProviderRegistry({ mockPhoneCodes: config.mockPhoneCodes, latencyMs: 150 }),
    emailSender: new NodemailerEmailSender(config.smtp, logger),
    redis,
    healthChecks: {
      postgresql: () => pingPrisma(prisma),
      mongodb: () => pingMongo(mongo),
      redis: () => pingRedis(redis),
    },
  });

  const server: Server = createApp(container).listen(config.port, () => {
    logger.info('Sentodo API listening', { port: config.port, docs: `/docs` });
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('Shutting down', { signal });
    server.close();
    await Promise.allSettled([transactionQueue.close(), emailQueue.close(), prisma.$disconnect(), mongo.close(), redis.quit()]);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  process.stderr.write(`Fatal startup error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
