import { randomBytes } from 'crypto';
import type { Redis } from 'ioredis';
import type { RateLimitAlgorithm, RateLimiter, RateLimitPolicy, RateLimitResult } from '../rateLimit.types';
import {
  FIXED_WINDOW_SCRIPT,
  LEAKY_BUCKET_SCRIPT,
  SLIDING_WINDOW_COUNTER_SCRIPT,
  SLIDING_WINDOW_LOG_SCRIPT,
  TOKEN_BUCKET_SCRIPT,
} from './redis.scripts';

/** Builds the Lua arguments and decodes the reply for one algorithm. */
interface ScriptSpec {
  script: string;
  args(policy: RateLimitPolicy, cost: number): Array<string | number>;
  limit(policy: RateLimitPolicy): number;
}

const SPECS: Record<RateLimitAlgorithm, ScriptSpec> = {
  'token-bucket': {
    script: TOKEN_BUCKET_SCRIPT,
    args: (p, cost) => [p.burst ?? p.limit, p.limit / p.windowSeconds, cost],
    limit: (p) => p.burst ?? p.limit,
  },
  'leaky-bucket': {
    script: LEAKY_BUCKET_SCRIPT,
    args: (p, cost) => [p.burst ?? p.limit, p.limit / p.windowSeconds, cost],
    limit: (p) => p.burst ?? p.limit,
  },
  'fixed-window': {
    script: FIXED_WINDOW_SCRIPT,
    args: (p, cost) => [p.limit, p.windowSeconds, cost],
    limit: (p) => p.limit,
  },
  'sliding-window-log': {
    script: SLIDING_WINDOW_LOG_SCRIPT,
    args: (p, cost) => [p.limit, p.windowSeconds, cost, randomBytes(4).toString('hex')],
    limit: (p) => p.limit,
  },
  'sliding-window-counter': {
    script: SLIDING_WINDOW_COUNTER_SCRIPT,
    args: (p, cost) => [p.limit, p.windowSeconds, cost],
    limit: (p) => p.limit,
  },
};

/**
 * Redis-backed limiter shared by every application instance. One class serves all algorithms:
 * the algorithm only decides which atomic Lua script runs.
 */
export class RedisRateLimiter implements RateLimiter {
  /**
   * @param {RateLimitAlgorithm} algorithm - The algorithm to run.
   * @param {RateLimitPolicy} policy - The allowance.
   * @param {Redis} redis - A connected ioredis client.
   * @param {string} [namespace='rl'] - Key prefix.
   */
  constructor(
    readonly algorithm: RateLimitAlgorithm,
    private readonly policy: RateLimitPolicy,
    private readonly redis: Redis,
    private readonly namespace = 'rl',
  ) {}

  async consume(key: string, cost = 1): Promise<RateLimitResult> {
    const spec = SPECS[this.algorithm];
    const redisKey = `${this.namespace}:${this.algorithm}:${this.policy.name}:${key}`;
    const reply = (await this.redis.eval(spec.script, 1, redisKey, ...spec.args(this.policy, cost))) as [
      number,
      string,
      number,
    ];
    const [allowed, remaining, retryAfter] = reply;
    return {
      allowed: Number(allowed) === 1,
      limit: spec.limit(this.policy),
      remaining: Math.max(0, Math.floor(Number(remaining))),
      retryAfterSeconds: Number(allowed) === 1 ? 0 : Math.max(1, Number(retryAfter)),
    };
  }
}
