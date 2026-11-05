import { spawn, spawnSync, type ChildProcess } from 'child_process';
import IORedis, { type Redis } from 'ioredis';
import { connect } from 'net';
import { RATE_LIMIT_ALGORITHMS, type RateLimitPolicy } from '../../src/rateLimit/rateLimit.types';
import { createRateLimiter } from '../../src/rateLimit/rateLimit.factory';

/**
 * Runs the atomic Lua scripts against a real Redis. The suite starts a throw-away redis-server on a
 * private port and is skipped automatically when the binary is not installed.
 */
const hasRedis = spawnSync('which', ['redis-server']).status === 0;
const PORT = 6391;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves once something accepts TCP connections on the port. */
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

(hasRedis ? describe : describe.skip)('Redis rate limiting (real Redis, Lua scripts)', () => {
  let server: ChildProcess;
  let redis: Redis;

  beforeAll(async () => {
    server = spawn('redis-server', ['--bind', '127.0.0.1', '--port', String(PORT), '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
    await waitForPort(PORT);
    redis = new IORedis({ host: '127.0.0.1', port: PORT, maxRetriesPerRequest: 2 });
    await redis.ping();
  }, 20_000);

  afterAll(async () => {
    redis?.disconnect();
    server?.kill('SIGTERM');
  });

  beforeEach(async () => {
    await redis.flushall();
  });

  const policy = (overrides: Partial<RateLimitPolicy> = {}): RateLimitPolicy => ({
    name: 'it',
    limit: 3,
    windowSeconds: 2,
    failurePolicy: 'fail-closed',
    ...overrides,
  });

  describe.each(RATE_LIMIT_ALGORITHMS)('%s', (algorithm) => {
    it('allows up to the limit, then rejects with a retry hint', async () => {
      const limiter = createRateLimiter({ algorithm, store: 'redis', policy: policy(), redis });
      for (let i = 0; i < 3; i += 1) expect((await limiter.consume('client-a')).allowed).toBe(true);
      const denied = await limiter.consume('client-a');
      expect(denied.allowed).toBe(false);
      expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(denied.remaining).toBe(0);
    });

    it('isolates clients', async () => {
      const limiter = createRateLimiter({ algorithm, store: 'redis', policy: policy(), redis });
      for (let i = 0; i < 4; i += 1) await limiter.consume('noisy');
      expect((await limiter.consume('quiet')).allowed).toBe(true);
    });

    it('is atomic: concurrent requests cannot exceed the limit', async () => {
      const limiter = createRateLimiter({ algorithm, store: 'redis', policy: policy({ limit: 5, windowSeconds: 30 }), redis });
      const results = await Promise.all(Array.from({ length: 40 }, () => limiter.consume('burst')));
      expect(results.filter((r) => r.allowed)).toHaveLength(5);
    });

    it('recovers after the window', async () => {
      const limiter = createRateLimiter({ algorithm, store: 'redis', policy: policy({ limit: 2, windowSeconds: 1 }), redis });
      await limiter.consume('x');
      await limiter.consume('x');
      expect((await limiter.consume('x')).allowed).toBe(false);
      await sleep(2_300);
      expect((await limiter.consume('x')).allowed).toBe(true);
    });
  });

  it('token bucket: weighted costs drain the bucket faster', async () => {
    const limiter = createRateLimiter({ algorithm: 'token-bucket', store: 'redis', policy: policy({ limit: 1, windowSeconds: 10, burst: 10 }), redis });
    expect((await limiter.consume('w', 5)).allowed).toBe(true);
    expect((await limiter.consume('w', 5)).allowed).toBe(true);
    expect((await limiter.consume('w', 1)).allowed).toBe(false);
  });

  it('token bucket: expires idle keys so buckets do not accumulate', async () => {
    const limiter = createRateLimiter({ algorithm: 'token-bucket', store: 'redis', policy: policy({ limit: 10, windowSeconds: 1, burst: 10 }), redis });
    await limiter.consume('idle');
    const ttl = await redis.ttl('rl:token-bucket:it:idle');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(3);
  });
});
