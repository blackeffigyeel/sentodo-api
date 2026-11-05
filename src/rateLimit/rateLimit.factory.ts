import type { Redis } from 'ioredis';
import { BadRequestError } from '../errors/app.errors';
import { RedisRateLimiter } from './redis/redis.limiter';
import {
  MemoryFixedWindow,
  MemoryLeakyBucket,
  MemorySlidingWindowCounter,
  MemorySlidingWindowLog,
  MemoryTokenBucket,
} from './strategies/memory.strategy';
import type { Clock, RateLimiter, RateLimitAlgorithm, RateLimitPolicy, RateLimitStoreKind } from './rateLimit.types';
import { systemClock } from './rateLimit.types';

/** Everything needed to build a limiter. */
export interface RateLimiterOptions {
  algorithm: RateLimitAlgorithm;
  store: RateLimitStoreKind;
  policy: RateLimitPolicy;
  /** Required when `store` is "redis". */
  redis?: Redis;
  clock?: Clock;
}

/**
 * Builds a limiter for any algorithm and store combination. This is the single swap point:
 * change `RATE_LIMIT_ALGORITHM` or `RATE_LIMIT_STORE` and every policy follows.
 * @param {RateLimiterOptions} options - The algorithm, store and policy.
 * @returns {RateLimiter} The configured limiter.
 * @throws {BadRequestError} If Redis is requested without a client.
 */
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { algorithm, store, policy, redis, clock = systemClock } = options;

  if (store === 'redis') {
    if (!redis) throw new BadRequestError('A Redis client is required for the redis rate-limit store');
    return new RedisRateLimiter(algorithm, policy, redis);
  }

  switch (algorithm) {
    case 'token-bucket':
      return new MemoryTokenBucket(policy, clock);
    case 'leaky-bucket':
      return new MemoryLeakyBucket(policy, clock);
    case 'fixed-window':
      return new MemoryFixedWindow(policy, clock);
    case 'sliding-window-log':
      return new MemorySlidingWindowLog(policy, clock);
    case 'sliding-window-counter':
      return new MemorySlidingWindowCounter(policy, clock);
    default: {
      const exhaustive: never = algorithm;
      throw new BadRequestError(`Unknown rate-limit algorithm: ${String(exhaustive)}`);
    }
  }
}
