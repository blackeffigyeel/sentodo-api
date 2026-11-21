import { spawn, spawnSync, type ChildProcess } from 'child_process';
import IORedis, { type Redis } from 'ioredis';
import { connect } from 'net';
import { loadConfig } from '../../src/config/app.config';
import { BullJobQueue, type RunningWorker } from '../../src/integrations/queue.integration';
import { QUEUE_NAMES, type EmailJob, type TransactionJob } from '../../src/queues/queue.types';
import { startQueueWorkers } from '../../src/queues/queueWorkers.runner';
import { silentLogger } from '../../src/utils/logger.util';

/**
 * Runs the shared queue-worker runner (used by `queue.worker.ts` and by the API when RUN_WORKER_IN_API=true)
 * against a real Redis. Skipped automatically when `redis-server` is not installed.
 */
const hasRedis = spawnSync('which', ['redis-server']).status === 0;
const PORT = 6392;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the condition');
    await sleep(25);
  }
}

async function waitForPort(port: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: '127.0.0.1', port }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('error', () => resolve(false));
    });
    if (open) return;
    await sleep(100);
  }
  throw new Error('Redis did not start');
}

(hasRedis ? describe : describe.skip)('queue workers (real Redis)', () => {
  let server: ChildProcess;
  let redis: Redis;
  let transactionQueue: BullJobQueue<TransactionJob>;
  let emailQueue: BullJobQueue<EmailJob>;
  let workers: RunningWorker | undefined;

  beforeAll(async () => {
    server = spawn('redis-server', ['--bind', '127.0.0.1', '--port', String(PORT), '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
    await waitForPort(PORT);
    redis = new IORedis({ host: '127.0.0.1', port: PORT, maxRetriesPerRequest: null });
    await redis.ping();
    transactionQueue = new BullJobQueue<TransactionJob>(QUEUE_NAMES.transactions, redis);
    emailQueue = new BullJobQueue<EmailJob>(QUEUE_NAMES.emails, redis);
  }, 20_000);

  afterAll(async () => {
    await transactionQueue?.close();
    await emailQueue?.close();
    redis?.disconnect();
    server?.kill('SIGTERM');
  });

  beforeEach(async () => {
    await redis.flushall();
  });

  afterEach(async () => {
    await workers?.close();
    workers = undefined;
  });

  const email: EmailJob = { to: 'a@example.com', subject: 'Hello', text: 'Hi' } as EmailJob;

  it('settles queued transactions and sends queued emails', async () => {
    const settled: string[] = [];
    const sent: EmailJob[] = [];
    workers = startQueueWorkers({
      redis,
      settleTransaction: async (id) => void settled.push(id),
      sendEmail: async (message) => void sent.push(message),
      concurrency: 2,
      logger: silentLogger,
    });

    await transactionQueue.add({ transactionId: 'tx-1' } as TransactionJob, { jobId: 'tx-1' });
    await emailQueue.add(email, { jobId: 'mail-1' });

    await waitFor(() => settled.length === 1 && sent.length === 1);
    expect(settled).toEqual(['tx-1']);
    expect(sent[0]).toMatchObject({ to: 'a@example.com' });
  });

  it('retries a job whose handler throws, then succeeds', async () => {
    let calls = 0;
    workers = startQueueWorkers({
      redis,
      settleTransaction: async () => {
        calls += 1;
        if (calls === 1) throw new Error('provider unavailable');
      },
      sendEmail: async () => undefined,
      concurrency: 1,
      logger: silentLogger,
    });

    await transactionQueue.add({ transactionId: 'tx-retry' } as TransactionJob, { jobId: 'tx-retry' });
    await waitFor(() => calls >= 2, 10_000);
    expect(calls).toBe(2);
  }, 20_000);

  it('leaves jobs waiting while no worker runs, and processes them once one starts (as after an API sleep)', async () => {
    await transactionQueue.add({ transactionId: 'tx-waiting' } as TransactionJob, { jobId: 'tx-waiting' });
    await sleep(300);

    const settled: string[] = [];
    workers = startQueueWorkers({
      redis,
      settleTransaction: async (id) => void settled.push(id),
      sendEmail: async () => undefined,
      concurrency: 1,
      logger: silentLogger,
    });
    await waitFor(() => settled.includes('tx-waiting'));
  });

  it('stops processing after close()', async () => {
    const settled: string[] = [];
    workers = startQueueWorkers({
      redis,
      settleTransaction: async (id) => void settled.push(id),
      sendEmail: async () => undefined,
      concurrency: 1,
      logger: silentLogger,
    });
    await workers.close();
    workers = undefined;

    await transactionQueue.add({ transactionId: 'tx-after-close' } as TransactionJob, { jobId: 'tx-after-close' });
    await sleep(500);
    expect(settled).toEqual([]);
  });
});

describe('RUN_WORKER_IN_API config', () => {
  const base = {
    DATABASE_USER: 'x', DATABASE_PASSWORD: 'x', DATABASE_NAME: 'x', MONGODB_URI: 'mongodb://x', REDIS_URL: 'redis://x',
    JWT_SECRET: 'a'.repeat(20), ADMIN_SERVICE_TOKEN: 'b'.repeat(20),
  };

  it('is off by default, so a separate worker process is expected', () => {
    expect(loadConfig(base).runWorkerInApi).toBe(false);
  });

  it.each(['true', '1', 'yes'])('turns on for %s', (value) => {
    expect(loadConfig({ ...base, RUN_WORKER_IN_API: value }).runWorkerInApi).toBe(true);
  });

  it('stays off for false', () => {
    expect(loadConfig({ ...base, RUN_WORKER_IN_API: 'false' }).runWorkerInApi).toBe(false);
  });
});
