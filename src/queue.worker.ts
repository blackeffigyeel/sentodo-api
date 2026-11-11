import { createContainer } from './app.container';
import { loadConfig } from './config/app.config';
import { NodemailerEmailSender } from './integrations/mailer.integration';
import { connectMongo } from './integrations/mongo.integration';
import { connectPrisma } from './integrations/prisma.integration';
import { BullJobQueue, startWorker, type RunningWorker } from './integrations/queue.integration';
import { connectRedis } from './integrations/redis.integration';
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
import { createLogger } from './utils/logger.util';

/** Processes the transaction-settlement and email queues. Scale by running more replicas. */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const prisma = await connectPrisma(config.database, logger);
  const mongo = await connectMongo(config.mongodbUri, logger);
  const redis = await connectRedis(config.redisUrl, logger);

  const emailSender = new NodemailerEmailSender(config.smtp, logger);
  const container = await createContainer({
    config,
    logger,
    repositories: {
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
    },
    queues: {
      transactions: new BullJobQueue<TransactionJob>(QUEUE_NAMES.transactions, redis),
      emails: new BullJobQueue<EmailJob>(QUEUE_NAMES.emails, redis),
    },
    providers: createMockProviderRegistry({ mockPhoneCodes: config.mockPhoneCodes, latencyMs: 150 }),
    emailSender,
    redis,
    healthChecks: {},
  });

  const workers: RunningWorker[] = [
    startWorker<TransactionJob>(
      QUEUE_NAMES.transactions,
      redis,
      ({ transactionId }) => container.settlement.settle(transactionId),
      config.queueConcurrency,
      logger,
    ),
    startWorker<EmailJob>(QUEUE_NAMES.emails, redis, (message) => emailSender.send(message), config.queueConcurrency, logger),
  ];
  logger.info('Queue workers started');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('Worker shutting down', { signal });
    await Promise.allSettled(workers.map((worker) => worker.close()));
    await Promise.allSettled([prisma.$disconnect(), mongo.close(), redis.quit()]);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  process.stderr.write(`Fatal worker error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
