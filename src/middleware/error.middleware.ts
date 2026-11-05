import { randomUUID } from 'crypto';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { isAppError } from '../errors/app.errors';
import { failureBody } from '../utils/response.util';
import type { Logger } from '../utils/logger.util';

/** Assigns every request an id (honouring a sane incoming `x-request-id`) and echoes it back. */
export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.header('x-request-id');
  req.requestId = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
};

/** Responds to unmatched routes using the standard envelope. */
export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json(failureBody(`Route not found: ${req.method} ${req.path}`));
};

/**
 * The single place where errors become responses (the end of the error-propagation chain).
 * Operational errors keep their message, status and safe context. Anything else is logged in
 * full and answered with a generic 500 so internals never leak.
 * @param {Logger} logger - Logger for unexpected errors.
 * @returns {ErrorRequestHandler} The Express error handler.
 */
export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  // Express identifies error handlers by their four parameters, so `_next` must stay.
  return (error, req, res, _next) => {
    if (isAppError(error)) {
      if (error.statusCode >= 500) {
        logger.error('Operational error', { requestId: req.requestId, error, cause: (error as { cause?: unknown }).cause });
      }
      const data = Object.keys(error.additionalData).length > 0 ? error.additionalData : null;
      res.status(error.statusCode).json(failureBody(error.message, data));
      return;
    }

    const parserError = error as { type?: string; status?: number };
    if (parserError?.type === 'entity.parse.failed') {
      res.status(400).json(failureBody('Request body is not valid JSON'));
      return;
    }
    if (parserError?.type === 'entity.too.large') {
      res.status(413).json(failureBody('Request body is too large'));
      return;
    }

    logger.error('Unhandled error', { requestId: req.requestId, path: req.path, error });
    res.status(500).json(failureBody('Something went wrong on our side. Please try again.'));
  };
}
