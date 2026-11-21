import type { Server } from 'http';
import 'dotenv/config';
import { createContainer } from './app.container';
import { loadConfig } from './config/app.config';
import { createApp } from './express.app';
import { NodemailerEmailSender } from './integrations/mailer.integration';
import { connectMongo, pingMongo } from './integrations/mongo.integration';
import { connectPrisma, pingPrisma } from './integrations/prisma.integration';
import { BullJobQueue, type RunningWorker } from './integrations/queue.integration';
import { connectRedis, pingRedis } from './integrations/redis.integration';
import { createMockProviderRegistry } from './providers/mock/mock.providers';
import { QUEUE_NAMES, type EmailJob, type TransactionJob } from './queues/queue.types';
import { startQueueWorkers } from './queues/queueWorkers.runner';
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

/**
 * Starts the HTTP API. Queued jobs are processed by `queue.worker.ts`, or by this process itself
 * when `RUN_WORKER_IN_API=true` (single-service hosting).
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  const prisma = await connectPrisma(config.database, logger);
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

  const emailSender = new NodemailerEmailSender(config.smtp, logger);
  const container = await createContainer({
    config,
    logger,
    repositories,
    queues: { transactions: transactionQueue, emails: emailQueue },
    providers: createMockProviderRegistry({ mockPhoneCodes: config.mockPhoneCodes, latencyMs: 150 }),
    emailSender,
    redis,
    healthChecks: {
      postgresql: () => pingPrisma(prisma),
      mongodb: () => pingMongo(mongo),
      redis: () => pingRedis(redis),
    },
  });

  let workers: RunningWorker | undefined;
  if (config.runWorkerInApi) {
    workers = startQueueWorkers({
      redis,
      settleTransaction: (transactionId) => container.settlement.settle(transactionId),
      sendEmail: (message) => emailSender.send(message),
      concurrency: config.queueConcurrency,
      logger,
    });
  }

  const server: Server = createApp(container).listen(config.port, () => {
    logger.info('Sentodo API listening', { port: config.port, docs: `/docs` });
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('Shutting down', { signal });
    server.close();
    // Stop taking jobs and let active ones finish before the connections they use are closed.
    await workers?.close();
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
