import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Wraps an async route handler so that rejected promises propagate to the central
 * error handler through `next(error)`. This is the glue of the error-propagation pattern:
 * controllers never need try/catch.
 * @param {(req: Request, res: Response, next: NextFunction) => Promise<unknown>} handler - The async handler.
 * @returns {RequestHandler} A standard Express handler.
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}
