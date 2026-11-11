import cors from 'cors';
import express, { type Express, Request } from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'path';
import swaggerUi from 'swagger-ui-express';
import { readFileSync, existsSync } from 'fs';
import { parse } from 'yaml';
import type { AppContainer } from './app.container';
import { createAuthMiddleware } from './middleware/auth.middleware';
import { createErrorHandler, notFoundHandler, requestId } from './middleware/error.middleware';
import { createRateLimitMiddleware } from './middleware/rateLimit.middleware';
import { createApiRouter } from './routes/api.routes';
import type { Logger } from './utils/logger.util';

/** Location of the OpenAPI document (copied into the Docker image alongside `dist`). */
const OPENAPI_PATH = path.resolve(__dirname, '../docs/sentodo.api.doc.yaml');

/**
 * Builds the Morgan format string. Mirrors the standard combined format plus a
 * request-id token at the end so every line can be correlated with app logs.
 */
const MORGAN_FORMAT =
  ':remote-addr - :remote-user ":method :url HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent" [ReqId: :request-id]';

/**
 * Creates the Morgan middleware that forwards every HTTP line through the
 * application logger, so requests land in the same JSON stream as the rest of
 * the logs (and are redacted by the same rules).
 * @param {Logger} logger - The application logger.
 * @returns {express.RequestHandler} The Morgan middleware.
 */
function createHttpLogger(logger: Logger): express.RequestHandler {
  morgan.token('request-id', (req: Request) => (req as { requestId?: string }).requestId ?? '-');

  return morgan(MORGAN_FORMAT, {
    stream: {
      write: (message: string) => {
        // Pull the request id back out of the formatted line so it is a first-class
        // field on the log record, not just text in the message body.
        const match = message.match(/\[ReqId: ([^\]]+)\]/);
        const reqId = match ? match[1] : undefined;
        const clean = message.replace(/\s*\[ReqId: [^\]]+\]\s*$/, '').trim();
        logger.info(clean, reqId && reqId !== '-' ? { requestId: reqId } : undefined);
      },
    },
  });
}

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
  app.use(createHttpLogger(logger));
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
