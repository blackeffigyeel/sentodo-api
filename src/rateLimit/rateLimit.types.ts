/**
 * Rate-limiting contracts.
 *
 * Every algorithm implements {@link RateLimiter} and is configured by the same
 * {@link RateLimitPolicy}, so algorithms and stores can be swapped through
 * configuration alone (see `createRateLimiter`).
 */

/** The supported algorithms. */
export const RATE_LIMIT_ALGORITHMS = [
  'token-bucket',
  'leaky-bucket',
  'fixed-window',
  'sliding-window-log',
  'sliding-window-counter',
] as const;

/** The supported state stores. `memory` is per-process; `redis` is shared across instances. */
export const RATE_LIMIT_STORES = ['memory', 'redis'] as const;

export type RateLimitAlgorithm = (typeof RATE_LIMIT_ALGORITHMS)[number];
export type RateLimitStoreKind = (typeof RATE_LIMIT_STORES)[number];

/** What to do when the limiter itself fails (e.g. Redis is down). */
export type FailurePolicy = 'fail-open' | 'fail-closed';

/**
 * A named allowance. `limit` requests are allowed per `windowSeconds`.
 * For the bucket algorithms `burst` sets the capacity (defaults to `limit`),
 * and the sustained rate is `limit / windowSeconds` per second.
 */
export interface RateLimitPolicy {
  name: string;
  limit: number;
  windowSeconds: number;
  burst?: number;
  failurePolicy: FailurePolicy;
}

/** The outcome of a single consumption attempt. */
export interface RateLimitResult {
  allowed: boolean;
  /** The maximum allowance (capacity or window limit). */
  limit: number;
  /** Whole requests still available. */
  remaining: number;
  /** Seconds to wait before retrying; 0 when allowed. */
  retryAfterSeconds: number;
}

/** Strategy contract implemented by every algorithm and store combination. */
export interface RateLimiter {
  readonly algorithm: RateLimitAlgorithm;
  /**
   * Attempts to consume `cost` units for `key`.
   * @param {string} key - The client identity, e.g. "profile:123" or "ip:1.2.3.4".
   * @param {number} [cost=1] - Units to consume (expensive endpoints cost more).
   * @returns {Promise<RateLimitResult>} Whether the call is allowed and the remaining allowance.
   */
  consume(key: string, cost?: number): Promise<RateLimitResult>;
}

/** Time source, injectable so algorithms can be tested without real delays. */
export interface Clock {
  /** @returns {number} Milliseconds since the Unix epoch. */
  now(): number;
}

/** The default wall-clock. */
export const systemClock: Clock = { now: () => Date.now() };
