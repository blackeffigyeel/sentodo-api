import type { RequestHandler } from 'express';
import type { ZodTypeAny, z } from 'zod';
import { ValidationError } from '../errors/app.errors';

/** Which part of the request to validate. */
export type RequestPart = 'body' | 'query' | 'params';

/**
 * Validates and replaces part of the request using a Zod schema. Unknown fields are stripped,
 * and failures become a {@link ValidationError} listing every issue.
 * @param {ZodTypeAny} schema - The schema.
 * @param {RequestPart} [part='body'] - The request part to validate.
 * @returns {RequestHandler} The middleware.
 */
export function validate(schema: ZodTypeAny, part: RequestPart = 'body'): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req[part]);
    if (!result.success) {
      const issues = result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
      return next(new ValidationError('Validation failed', issues));
    }
    Object.defineProperty(req, part, { value: result.data, writable: true, configurable: true, enumerable: true });
    return next();
  };
}

/** Infers the validated type of a schema. */
export type Validated<T extends ZodTypeAny> = z.infer<T>;
