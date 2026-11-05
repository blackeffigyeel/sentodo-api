import type { RequestHandler } from 'express';
import { ServiceUnavailableError, TooManyRequestsError } from '../errors/app.errors';
import type { LimiterRegistry } from '../rateLimit/rateLimit.registry';
import type { PolicyName } from '../rateLimit/rateLimit.policies';
import type { Logger } from '../utils/logger.util';

/** Options for a rate-limit middleware instance. */
export interface RateLimitOptions {
  /** Tokens (or units) this endpoint consumes. Expensive endpoints cost more. */
  cost?: number;
  /** Key by IP even when the caller is authenticated (use for unauthenticated routes). */
  byIp?: boolean;
}

/**
 * Builds the rate-limit middleware factory.
 *
 * Clients are identified by profile id (JWT) or API key id when authenticated, otherwise by IP.
 * When the limiter itself fails (for example Redis is down), the policy's failure mode decides:
 * fail-open lets the request through, fail-closed rejects it with 503.
 *
 * @param {LimiterRegistry} limiters - One limiter per named policy.
 * @param {Logger} logger - Logger for limiter failures.
 * @returns {(policy: PolicyName, options?: RateLimitOptions) => RequestHandler} The factory.
 */
export function createRateLimitMiddleware(
  limiters: LimiterRegistry,
  logger: Logger,
): (policy: PolicyName, options?: RateLimitOptions) => RequestHandler {
  return (policyName, options = {}) => {
    const { policy, limiter } = limiters[policyName];
    const cost = options.cost ?? 1;

    return (req, res, next) => {
      const identity = !options.byIp && req.auth ? (req.auth.apiKeyId ? `key:${req.auth.apiKeyId}` : `profile:${req.auth.profile.id}`) : `ip:${req.ip}`;

      limiter
        .consume(`${identity}`, cost)
        .then((result) => {
          res.setHeader('X-RateLimit-Limit', String(result.limit));
          res.setHeader('X-RateLimit-Remaining', String(result.remaining));
          if (!result.allowed) {
            res.setHeader('Retry-After', String(result.retryAfterSeconds));
            return next(new TooManyRequestsError('Too many requests. Please slow down.', { retryAfterSeconds: result.retryAfterSeconds }));
          }
          return next();
        })
        .catch((error: unknown) => {
          logger.error('Rate limiter failure', { policy: policy.name, failurePolicy: policy.failurePolicy, error });
          if (policy.failurePolicy === 'fail-open') return next();
          return next(new ServiceUnavailableError('The service is temporarily unavailable'));
        });
    };
  };
}
