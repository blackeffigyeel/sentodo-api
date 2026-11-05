import type { Redis } from 'ioredis';
import { createRateLimiter } from './rateLimit.factory';
import { POLICIES, type PolicyName } from './rateLimit.policies';
import type { Clock, RateLimiter, RateLimitAlgorithm, RateLimitPolicy, RateLimitStoreKind } from './rateLimit.types';

export * from './rateLimit.types';
export * from './rateLimit.policies';
export { createRateLimiter } from './rateLimit.factory';

/** A limiter bound to its policy, as consumed by the HTTP middleware. */
export interface PolicyLimiter {
  policy: RateLimitPolicy;
  limiter: RateLimiter;
}

/** Registry of one limiter per named policy, built from a single algorithm and store choice. */
export type LimiterRegistry = Record<PolicyName, PolicyLimiter>;

/**
 * Builds a limiter for every named policy using the configured algorithm and store.
 * @param {object} options - Registry options.
 * @param {RateLimitAlgorithm} options.algorithm - The algorithm for all policies.
 * @param {RateLimitStoreKind} options.store - The state store for all policies.
 * @param {Redis} [options.redis] - Required for the redis store.
 * @param {Clock} [options.clock] - Optional clock for tests.
 * @returns {LimiterRegistry} The registry.
 */
export function createLimiterRegistry(options: {
  algorithm: RateLimitAlgorithm;
  store: RateLimitStoreKind;
  redis?: Redis;
  clock?: Clock;
}): LimiterRegistry {
  const entries = (Object.keys(POLICIES) as PolicyName[]).map((name) => {
    const policy: RateLimitPolicy = POLICIES[name];
    return [name, { policy, limiter: createRateLimiter({ ...options, policy }) }] as const;
  });
  return Object.fromEntries(entries) as LimiterRegistry;
}
