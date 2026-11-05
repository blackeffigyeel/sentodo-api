import type { RateLimitPolicy } from './rateLimit.types';

/**
 * Named rate-limit policies. Limits are illustrative defaults; tune them from production metrics.
 *
 * Failure policy guidance: money-moving and credential endpoints fail closed so that an outage
 * of the limiter cannot be used to bypass protection; low-risk reads fail open to preserve availability.
 */
export const POLICIES = {
  /** Every request, keyed by IP, to blunt floods before authentication. */
  global: { name: 'global', limit: 300, windowSeconds: 60, burst: 100, failurePolicy: 'fail-open' },
  /** Login, registration and code verification, keyed by IP. */
  auth: { name: 'auth', limit: 10, windowSeconds: 60, burst: 10, failurePolicy: 'fail-closed' },
  /** Authenticated reads, keyed by profile or API key. */
  standard: { name: 'standard', limit: 120, windowSeconds: 60, burst: 40, failurePolicy: 'fail-open' },
  /** Transfers and bill purchases. Costs more tokens per call, see {@link COSTS}. */
  transactions: { name: 'transactions', limit: 60, windowSeconds: 60, burst: 20, failurePolicy: 'fail-closed' },
  /** Identity verification triggers a paid provider call. */
  identity: { name: 'identity', limit: 3, windowSeconds: 60, burst: 3, failurePolicy: 'fail-closed' },
} as const satisfies Record<string, RateLimitPolicy>;

export type PolicyName = keyof typeof POLICIES;

/** Token cost per endpoint class, so expensive operations drain the allowance faster. */
export const COSTS = {
  read: 1,
  write: 2,
  transfer: 5,
  purchase: 3,
  identity: 1,
} as const;
