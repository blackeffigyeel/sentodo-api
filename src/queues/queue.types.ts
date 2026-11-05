import type { EmailMessage } from '../integrations/mailer.integration';

/**
 * Queue contracts. Services enqueue through {@link JobQueue}; BullMQ (production) and the
 * in-memory queue (tests) are interchangeable implementations.
 */

/** Names of the application queues. */
export const QUEUE_NAMES = {
  transactions: 'sentodo-transactions',
  emails: 'sentodo-emails',
} as const;

/** Settles a pending transaction: credits the recipient or calls the provider. */
export interface TransactionJob {
  transactionId: string;
}

/** Delivers one email. */
export type EmailJob = EmailMessage;

/** Options for enqueuing a job. */
export interface EnqueueOptions {
  /** De-duplicates jobs: adding the same id twice enqueues it once. */
  jobId?: string;
}

/** Producer contract. */
export interface JobQueue<T> {
  add(payload: T, options?: EnqueueOptions): Promise<void>;
}

/** Consumer contract: process a single job. Throwing makes the queue retry. */
export type JobHandler<T> = (payload: T) => Promise<void>;

/** Queues the application writes to. */
export interface Queues {
  transactions: JobQueue<TransactionJob>;
  emails: JobQueue<EmailJob>;
}

/**
 * An in-memory queue. Jobs wait until {@link drain} runs them, which lets tests prove that
 * an endpoint returns before the work is done and then settle the work deterministically.
 */
export class InMemoryJobQueue<T> implements JobQueue<T> {
  public readonly pending: Array<{ payload: T; jobId?: string }> = [];
  private readonly seen = new Set<string>();
  private handler: JobHandler<T> | null = null;

  /** Registers the handler used by {@link drain}. */
  setHandler(handler: JobHandler<T>): void {
    this.handler = handler;
  }

  async add(payload: T, options: EnqueueOptions = {}): Promise<void> {
    if (options.jobId) {
      if (this.seen.has(options.jobId)) return;
      this.seen.add(options.jobId);
    }
    this.pending.push({ payload, jobId: options.jobId });
  }

  /**
   * Runs every pending job through the handler, including jobs added while draining.
   * @returns {Promise<number>} The number of jobs processed.
   */
  async drain(): Promise<number> {
    let processed = 0;
    while (this.pending.length > 0) {
      const job = this.pending.shift();
      if (job && this.handler) {
        await this.handler(job.payload);
        processed += 1;
      }
    }
    return processed;
  }
}
