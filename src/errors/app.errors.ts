/**
 * Additional, JSON-serialisable context attached to an error.
 * It is exposed to API clients as the `data` property of the error response,
 * so it must never contain secrets or internal stack traces.
 */
export type AdditionalData = Record<string, unknown>;

/**
 * Base class for every error that the application throws deliberately.
 *
 * Errors propagate upwards (repository -> service -> controller) without being
 * caught and re-wrapped in between. The central error handler is the single place
 * that converts them into the standard response envelope.
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean = true;
  public readonly additionalData: AdditionalData;

  /**
   * @param {string} message - A safe, human-readable message for API clients.
   * @param {number} statusCode - The HTTP status code to respond with.
   * @param {AdditionalData} [additionalData={}] - Extra safe context for the client.
   */
  constructor(message: string, statusCode: number, additionalData: AdditionalData = {}) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.additionalData = additionalData;
    Object.setPrototypeOf(this, new.target.prototype);
    Error.captureStackTrace?.(this, new.target);
  }
}

/** 400: the request is malformed or violates a business precondition. */
export class BadRequestError extends AppError {
  constructor(message = 'Bad request', additionalData: AdditionalData = {}) {
    super(message, 400, additionalData);
  }
}

/** 400: request payload failed schema validation. Issues are returned in `data.issues`. */
export class ValidationError extends BadRequestError {
  constructor(message = 'Validation failed', issues: Array<{ path: string; message: string }> = []) {
    super(message, { issues });
  }
}

/** 401: credentials are missing, invalid or expired. */
export class UnauthorisedError extends AppError {
  constructor(message = 'Unauthorised', additionalData: AdditionalData = {}) {
    super(message, 401, additionalData);
  }
}

/** 403: the caller is authenticated but not permitted to perform the action. */
export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden', additionalData: AdditionalData = {}) {
    super(message, 403, additionalData);
  }
}

/** 404: the requested resource does not exist. */
export class NotFoundError extends AppError {
  constructor(message = 'Resource not found', additionalData: AdditionalData = {}) {
    super(message, 404, additionalData);
  }
}

/** 409: the request conflicts with the current state of a resource. */
export class ConflictError extends AppError {
  constructor(message = 'Conflict', additionalData: AdditionalData = {}) {
    super(message, 409, additionalData);
  }
}

/**
 * 409: an optimistic-locking check failed because another writer changed the row first.
 * Callers inside the domain layer normally retry before this reaches a client.
 */
export class ConcurrencyConflictError extends ConflictError {
  constructor(message = 'The resource was modified by another request. Please retry.', additionalData: AdditionalData = {}) {
    super(message, additionalData);
  }
}

/** 422: the request is well-formed but cannot be processed (e.g. insufficient funds). */
export class UnprocessableError extends AppError {
  constructor(message = 'Unprocessable request', additionalData: AdditionalData = {}) {
    super(message, 422, additionalData);
  }
}

/** 422: the debited account does not hold enough money. */
export class InsufficientFundsError extends UnprocessableError {
  constructor(message = 'Insufficient funds', additionalData: AdditionalData = {}) {
    super(message, additionalData);
  }
}

/** 429: the caller exceeded a rate limit. */
export class TooManyRequestsError extends AppError {
  constructor(message = 'Too many requests', additionalData: AdditionalData = {}) {
    super(message, 429, additionalData);
  }
}

/** 503: a feature or dependency is switched off or unavailable (see the App Command Centre). */
export class ServiceUnavailableError extends AppError {
  constructor(message = 'Service temporarily unavailable', additionalData: AdditionalData = {}) {
    super(message, 503, additionalData);
  }
}

/**
 * 502: a third-party integration (database, queue, mail, provider) failed.
 * The underlying error is kept on `cause` for logs but never sent to clients.
 */
export class IntegrationError extends AppError {
  public readonly integration: string;

  /**
   * @param {string} integration - The integration identifier, e.g. "redis" or "mock-vtu-mtn".
   * @param {string} message - A safe message for clients.
   * @param {unknown} [cause] - The original error, for logging only.
   */
  constructor(integration: string, message = 'An upstream service failed', cause?: unknown) {
    super(message, 502, { integration });
    this.integration = integration;
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

/**
 * Type guard for operational (expected) errors.
 * @param {unknown} error - Any thrown value.
 * @returns {boolean} True if the value is an {@link AppError}.
 */
export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
