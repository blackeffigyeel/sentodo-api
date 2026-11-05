import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Profile } from '../domain/entities.model';
import { ForbiddenError, UnauthorisedError } from '../errors/app.errors';
import type { Repositories } from '../repositories/interfaces/repositories.interface';
import type { ApiKeyService } from '../services/apiKey.service';
import type { TokenService } from '../services/token.service';
import { safeEqual } from '../utils/crypto.util';

/** Who is calling, attached to `req.auth` by the authentication middleware. */
export interface AuthContext {
  profile: Profile;
  via: 'jwt' | 'api-key';
  apiKeyId?: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
      /** True when the request carried a valid internal service token. */
      isServiceClient?: boolean;
      requestId?: string;
    }
  }
}

/** The authentication middleware set. */
export interface AuthMiddleware {
  /** Requires a valid Bearer JWT or `x-api-key`. */
  authenticate: RequestHandler;
  /** Requires a valid internal service token (`x-service-token`). */
  requireServiceToken: RequestHandler;
  /** Accepts a service token, a Bearer JWT or an API key. */
  authenticateClient: RequestHandler;
  /** Requires the authenticated profile to be corporate. Use after `authenticate`. */
  requireCorporate: RequestHandler;
}

/**
 * Builds the authentication middleware.
 * @param {object} deps - Collaborators.
 * @param {TokenService} deps.tokens - Verifies JWTs.
 * @param {Repositories} deps.repositories - Loads profiles.
 * @param {ApiKeyService} deps.apiKeys - Authenticates API keys.
 * @param {string} deps.serviceToken - The shared secret for internal clients.
 * @returns {AuthMiddleware} The handlers.
 */
export function createAuthMiddleware(deps: {
  tokens: TokenService;
  repositories: Repositories;
  apiKeys: ApiKeyService;
  serviceToken: string;
}): AuthMiddleware {
  const hasServiceToken = (req: Request): boolean => {
    const provided = req.header('x-service-token');
    return typeof provided === 'string' && safeEqual(provided, deps.serviceToken);
  };

  const resolveUser = async (req: Request): Promise<AuthContext> => {
    const apiKey = req.header('x-api-key');
    if (apiKey) {
      const { profile, apiKey: key } = await deps.apiKeys.authenticate(apiKey, req.ip ?? '');
      return { profile, via: 'api-key', apiKeyId: key.id };
    }

    const header = req.header('authorization');
    const match = header?.match(/^Bearer\s+(.+)$/i);
    if (!match) throw new UnauthorisedError('Authentication is required');

    const claims = deps.tokens.verify(match[1]);
    const profile = await deps.repositories.profiles.findById(claims.sub);
    if (!profile || profile.status !== 'ACTIVE') throw new UnauthorisedError('Invalid or expired token');
    return { profile, via: 'jwt' };
  };

  const authenticate: RequestHandler = (req, _res, next) => {
    resolveUser(req)
      .then((auth) => {
        req.auth = auth;
        next();
      })
      .catch(next);
  };

  const requireServiceToken: RequestHandler = (req, _res, next) => {
    if (!hasServiceToken(req)) return next(new UnauthorisedError('A valid service token is required'));
    req.isServiceClient = true;
    return next();
  };

  const authenticateClient: RequestHandler = (req, res, next) => {
    if (hasServiceToken(req)) {
      req.isServiceClient = true;
      return next();
    }
    return authenticate(req, res, next);
  };

  const requireCorporate: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
    if (req.auth?.profile.type !== 'CORPORATE') return next(new ForbiddenError('This endpoint is for corporate profiles only'));
    return next();
  };

  return { authenticate, requireServiceToken, authenticateClient, requireCorporate };
}

/**
 * Returns the authenticated context or throws.
 * @param {Request} req - The request.
 * @returns {AuthContext} The context.
 * @throws {UnauthorisedError} If the request is unauthenticated.
 */
export function requireAuth(req: Request): AuthContext {
  if (!req.auth) throw new UnauthorisedError('Authentication is required');
  return req.auth;
}
