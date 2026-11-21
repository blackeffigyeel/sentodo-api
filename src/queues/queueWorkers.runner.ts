import type { Redis } from 'ioredis';
import { startWorker, type RunningWorker } from '../integrations/queue.integration';
import type { Logger } from '../utils/logger.util';
import { QUEUE_NAMES, type EmailJob, type TransactionJob } from './queue.types';

/** What the queue workers need to do their jobs. */
export interface QueueWorkerOptions {
  /** A BullMQ-compatible Redis connection (`maxRetriesPerRequest: null`). It is duplicated per worker. */
  redis: Redis;
  /** Settles one transaction. Throwing triggers a retry. */
  settleTransaction: (transactionId: string) => Promise<unknown>;
  /** Sends one queued email. Throwing triggers a retry. */
  sendEmail: (message: EmailJob) => Promise<unknown>;
  /** Jobs processed in parallel per queue. */
  concurrency: number;
  logger: Logger;
}

/**
 * Starts the transaction-settlement and email workers.
 * Shared by the standalone worker process (`queue.worker.ts`) and by the API when `RUN_WORKER_IN_API=true`,
 * so both run exactly the same job handling.
 * @param {QueueWorkerOptions} options - Connection, handlers, concurrency and logger.
 * @returns {RunningWorker} A handle that stops both workers gracefully (finishing active jobs).
 */
export function startQueueWorkers(options: QueueWorkerOptions): RunningWorker {
  const { redis, settleTransaction, sendEmail, concurrency, logger } = options;
  const workers: RunningWorker[] = [
    startWorker<TransactionJob>(QUEUE_NAMES.transactions, redis, ({ transactionId }) => settleTransaction(transactionId).then(() => undefined), concurrency, logger),
    startWorker<EmailJob>(QUEUE_NAMES.emails, redis, (message) => sendEmail(message).then(() => undefined), concurrency, logger),
  ];
  logger.info('Queue workers started', { concurrency });
  return {
    close: async () => {
      await Promise.allSettled(workers.map((worker) => worker.close()));
    },
  };
}
