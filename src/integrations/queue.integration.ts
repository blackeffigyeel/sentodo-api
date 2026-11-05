import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { IntegrationError } from '../errors/app.errors';
import type { EnqueueOptions, JobHandler, JobQueue } from '../queues/queue.types';
import type { Logger } from '../utils/logger.util';

/**
 * BullMQ integration. Long-running work (settling transactions, sending email) is queued so
 * HTTP requests return quickly. Jobs retry with exponential backoff.
 */

/** BullMQ implementation of {@link JobQueue}. */
export class BullJobQueue<T> implements JobQueue<T> {
  private readonly queue: Queue;

  /**
   * @param {string} name - The queue name.
   * @param {Redis} connection - A Redis connection (BullMQ-compatible).
   */
  constructor(private readonly name: string, connection: Redis) {
    this.queue = new Queue(name, {
      connection: connection as unknown as ConnectionOptions,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: { count: 1_000 },
        removeOnFail: { count: 5_000 },
      },
    });
  }

  async add(payload: T, options: EnqueueOptions = {}): Promise<void> {
    try {
      await this.queue.add(this.name, payload as object, { jobId: options.jobId });
    } catch (error) {
      throw new IntegrationError('bullmq', 'Unable to queue the job', error);
    }
  }

  /** Closes the queue's connection handles. */
  async close(): Promise<void> {
    await this.queue.close();
  }
}

/** A running worker that can be stopped gracefully. */
export interface RunningWorker {
  close(): Promise<void>;
}

/**
 * Starts a BullMQ worker for a queue.
 * @param {string} name - The queue name.
 * @param {Redis} connection - A Redis connection; it is duplicated because workers block on it.
 * @param {JobHandler<T>} handler - Processes one job. Throwing triggers a retry.
 * @param {number} concurrency - Jobs processed in parallel.
 * @param {Logger} logger - Logger for job failures.
 * @returns {RunningWorker} The worker.
 */
export function startWorker<T>(
  name: string,
  connection: Redis,
  handler: JobHandler<T>,
  concurrency: number,
  logger: Logger,
): RunningWorker {
  const worker = new Worker(name, async (job) => handler(job.data as T), {
    connection: connection.duplicate() as unknown as ConnectionOptions,
    concurrency,
  });
  worker.on('failed', (job, error) => {
    logger.error('Queue job failed', { queue: name, jobId: job?.id, attemptsMade: job?.attemptsMade, error });
  });
  worker.on('error', (error) => logger.error('Queue worker error', { queue: name, error }));
  return { close: () => worker.close() };
}
