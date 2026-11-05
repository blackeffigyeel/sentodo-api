import type { AppContainer } from '../app.container';
import type { AuthMiddleware } from '../middleware/auth.middleware';
import type { RateLimitOptions } from '../middleware/rateLimit.middleware';
import type { PolicyName } from '../rateLimit/rateLimit.policies';
import type { RequestHandler } from 'express';

/** What every router factory receives. */
export interface RouteDependencies {
  container: AppContainer;
  auth: AuthMiddleware;
  /** Builds a rate-limit middleware for a named policy. */
  limit: (policy: PolicyName, options?: RateLimitOptions) => RequestHandler;
}
