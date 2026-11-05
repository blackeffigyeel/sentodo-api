import { BadRequestError } from '../../src/errors/app.errors';
import { createRateLimiter } from '../../src/rateLimit/rateLimit.factory';
import { createLimiterRegistry } from '../../src/rateLimit/rateLimit.registry';
import {
  RATE_LIMIT_ALGORITHMS,
  type Clock,
  type RateLimitAlgorithm,
  type RateLimitPolicy,
} from '../../src/rateLimit/rateLimit.types';

class FakeClock implements Clock {
  constructor(private current = 0) {}
  now(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
}

const policy = (overrides: Partial<RateLimitPolicy> = {}): RateLimitPolicy => ({
  name: 'test',
  limit: 3,
  windowSeconds: 10,
  failurePolicy: 'fail-closed',
  ...overrides,
});

describe('rate limiting', () => {
  describe.each(RATE_LIMIT_ALGORITHMS)('%s (memory) honours the shared contract', (algorithm: RateLimitAlgorithm) => {
    const build = (clock: Clock) => createRateLimiter({ algorithm, store: 'memory', policy: policy(), clock });

    it('allows up to the limit then rejects with a retry hint', async () => {
      const limiter = build(new FakeClock());
      for (let i = 0; i < 3; i += 1) expect((await limiter.consume('a')).allowed).toBe(true);
      const denied = await limiter.consume('a');
      expect(denied.allowed).toBe(false);
      expect(denied.remaining).toBe(0);
      expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(denied.limit).toBe(3);
    });

    it('reports a decreasing remaining allowance', async () => {
      const limiter = build(new FakeClock());
      expect((await limiter.consume('a')).remaining).toBe(2);
      expect((await limiter.consume('a')).remaining).toBe(1);
      expect((await limiter.consume('a')).remaining).toBe(0);
    });

    it('recovers after enough time has passed', async () => {
      const clock = new FakeClock();
      const limiter = build(clock);
      for (let i = 0; i < 3; i += 1) await limiter.consume('a');
      expect((await limiter.consume('a')).allowed).toBe(false);
      clock.advance(25_000);
      expect((await limiter.consume('a')).allowed).toBe(true);
    });

    it('isolates clients so one cannot starve another', async () => {
      const limiter = build(new FakeClock());
      for (let i = 0; i < 5; i += 1) await limiter.consume('noisy');
      expect((await limiter.consume('noisy')).allowed).toBe(false);
      expect((await limiter.consume('quiet')).allowed).toBe(true);
    });

    it('charges weighted costs', async () => {
      const limiter = build(new FakeClock());
      expect((await limiter.consume('a', 3)).allowed).toBe(true);
      expect((await limiter.consume('a', 1)).allowed).toBe(false);
    });

    it('rejects a request costing more than the whole allowance', async () => {
      const limiter = build(new FakeClock());
      expect((await limiter.consume('a', 4)).allowed).toBe(false);
    });
  });

  describe('token bucket specifics', () => {
    it('allows a burst, then refills continuously', async () => {
      const clock = new FakeClock();
      const limiter = createRateLimiter({
        algorithm: 'token-bucket',
        store: 'memory',
        policy: policy({ limit: 2, windowSeconds: 1, burst: 5 }),
        clock,
      });
      for (let i = 0; i < 5; i += 1) expect((await limiter.consume('a')).allowed).toBe(true);
      const denied = await limiter.consume('a');
      expect(denied.allowed).toBe(false);
      expect(denied.retryAfterSeconds).toBe(1);
      clock.advance(500); // 2 tokens/second -> 1 token
      expect((await limiter.consume('a')).allowed).toBe(true);
      expect((await limiter.consume('a')).allowed).toBe(false);
    });

    it('never exceeds capacity however long the client is idle', async () => {
      const clock = new FakeClock();
      const limiter = createRateLimiter({ algorithm: 'token-bucket', store: 'memory', policy: policy({ limit: 2, windowSeconds: 1, burst: 3 }), clock });
      await limiter.consume('a');
      clock.advance(3_600_000);
      const result = await limiter.consume('a');
      expect(result.remaining).toBe(2);
    });

    it('matches the worked example: capacity 20, 5/s, 4 tokens, 2 seconds -> 14 then 13', async () => {
      const clock = new FakeClock();
      const limiter = createRateLimiter({ algorithm: 'token-bucket', store: 'memory', policy: policy({ limit: 5, windowSeconds: 1, burst: 20 }), clock });
      await limiter.consume('a', 16); // 20 -> 4
      clock.advance(2_000); // 4 + 5*2 = 14
      expect((await limiter.consume('a')).remaining).toBe(13);
    });
  });

  describe('fixed window specifics', () => {
    it('resets at the window boundary', async () => {
      const clock = new FakeClock(0);
      const limiter = createRateLimiter({ algorithm: 'fixed-window', store: 'memory', policy: policy(), clock });
      for (let i = 0; i < 3; i += 1) await limiter.consume('a');
      clock.advance(9_999);
      expect((await limiter.consume('a')).allowed).toBe(false);
      clock.advance(1);
      expect((await limiter.consume('a')).allowed).toBe(true);
    });
  });

  describe('sliding window log specifics', () => {
    it('has no boundary burst: old requests expire one by one', async () => {
      const clock = new FakeClock(0);
      const limiter = createRateLimiter({ algorithm: 'sliding-window-log', store: 'memory', policy: policy(), clock });
      await limiter.consume('a'); // t=0
      clock.advance(4_000);
      await limiter.consume('a'); // t=4s
      await limiter.consume('a'); // t=4s
      expect((await limiter.consume('a')).allowed).toBe(false);
      clock.advance(6_001); // the t=0 request has left the window
      expect((await limiter.consume('a')).allowed).toBe(true);
      expect((await limiter.consume('a')).allowed).toBe(false);
    });
  });

  describe('sliding window counter specifics', () => {
    it('weights the previous window so a boundary burst is smoothed', async () => {
      const clock = new FakeClock(0);
      const limiter = createRateLimiter({ algorithm: 'sliding-window-counter', store: 'memory', policy: policy({ limit: 10 }), clock });
      for (let i = 0; i < 10; i += 1) await limiter.consume('a');
      clock.advance(10_000); // start of the next window: previous weight is 100%
      expect((await limiter.consume('a')).allowed).toBe(false);
      clock.advance(5_000); // halfway: previous weighs 50% = 5 used
      expect((await limiter.consume('a')).allowed).toBe(true);
    });
  });

  describe('factory and registry', () => {
    it('requires a Redis client for the redis store', () => {
      expect(() => createRateLimiter({ algorithm: 'token-bucket', store: 'redis', policy: policy() })).toThrow(BadRequestError);
    });

    it('builds a limiter of the requested algorithm', () => {
      for (const algorithm of RATE_LIMIT_ALGORITHMS) {
        expect(createRateLimiter({ algorithm, store: 'memory', policy: policy() }).algorithm).toBe(algorithm);
      }
    });

    it('swaps every named policy with one setting', () => {
      const registry = createLimiterRegistry({ algorithm: 'leaky-bucket', store: 'memory' });
      expect(Object.keys(registry).sort()).toEqual(['auth', 'global', 'identity', 'standard', 'transactions']);
      for (const { limiter } of Object.values(registry)) expect(limiter.algorithm).toBe('leaky-bucket');
    });

    it('fails closed on credential and money endpoints, open on reads', () => {
      const registry = createLimiterRegistry({ algorithm: 'token-bucket', store: 'memory' });
      expect(registry.auth.policy.failurePolicy).toBe('fail-closed');
      expect(registry.transactions.policy.failurePolicy).toBe('fail-closed');
      expect(registry.standard.policy.failurePolicy).toBe('fail-open');
    });
  });
});
