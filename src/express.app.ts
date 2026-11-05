import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import path from 'path';
import swaggerUi from 'swagger-ui-express';
import { readFileSync, existsSync } from 'fs';
import { parse } from 'yaml';
import type { AppContainer } from './app.container';
import { createAuthMiddleware } from './middleware/auth.middleware';
import { createErrorHandler, notFoundHandler, requestId } from './middleware/error.middleware';
import { createRateLimitMiddleware } from './middleware/rateLimit.middleware';
import { createApiRouter } from './routes/api.routes';

/** Location of the OpenAPI document (copied into the Docker image alongside `dist`). */
const OPENAPI_PATH = path.resolve(__dirname, '../docs/sentodo.api.doc.yaml');

/**
 * Builds the Express application from a wired container. No sockets are opened here, so the
 * same function serves production and the test suite.
 * @param {AppContainer} container - The wired services.
 * @returns {Express} The configured application.
 */
export function createApp(container: AppContainer): Express {
  const { config, logger } = container;
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(requestId);
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({ origin: config.corsOrigins.includes('*') ? true : config.corsOrigins }));
  app.use(express.json({ limit: '100kb' }));

  const limit = createRateLimitMiddleware(container.limiters, logger);
  app.use(limit('global', { byIp: true }));

  if (existsSync(OPENAPI_PATH)) {
    const spec = parse(readFileSync(OPENAPI_PATH, 'utf8')) as Record<string, unknown>;
    app.get('/docs/openapi.json', (_req, res) => res.json(spec));
    app.use('/docs', swaggerUi.serve, swaggerUi.setup(spec, { customSiteTitle: 'Sentodo MFB API' }));
  }

  const auth = createAuthMiddleware({
    tokens: container.tokens,
    repositories: container.repositories,
    apiKeys: container.apiKeys,
    serviceToken: config.adminServiceToken,
  });

  app.use('/api/v1', createApiRouter({ container, auth, limit }));
  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));
  return app;
}
