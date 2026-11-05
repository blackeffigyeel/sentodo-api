import {
  AppError,
  BadRequestError,
  ConcurrencyConflictError,
  ConflictError,
  ForbiddenError,
  InsufficientFundsError,
  IntegrationError,
  isAppError,
  NotFoundError,
  ServiceUnavailableError,
  TooManyRequestsError,
  UnauthorisedError,
  UnprocessableError,
  ValidationError,
} from '../../src/errors/app.errors';

describe('error classes', () => {
  it.each([
    [new BadRequestError(), 400, 'Bad request'],
    [new UnauthorisedError(), 401, 'Unauthorised'],
    [new ForbiddenError(), 403, 'Forbidden'],
    [new NotFoundError(), 404, 'Resource not found'],
    [new ConflictError(), 409, 'Conflict'],
    [new UnprocessableError(), 422, 'Unprocessable request'],
    [new TooManyRequestsError(), 429, 'Too many requests'],
    [new ServiceUnavailableError(), 503, 'Service temporarily unavailable'],
  ])('%p has the expected status and default message', (error, status, message) => {
    expect(error.statusCode).toBe(status);
    expect(error.message).toBe(message);
    expect(error.isOperational).toBe(true);
  });

  it('keeps the class name and works with instanceof', () => {
    const error = new NotFoundError('Nope');
    expect(error.name).toBe('NotFoundError');
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toBeInstanceOf(Error);
  });

  it('carries safe additional data', () => {
    expect(new BadRequestError('x', { field: 'amount' }).additionalData).toEqual({ field: 'amount' });
  });

  it('models specialised conflicts and balances as their parent types', () => {
    expect(new ConcurrencyConflictError()).toBeInstanceOf(ConflictError);
    expect(new InsufficientFundsError()).toBeInstanceOf(UnprocessableError);
    expect(new ValidationError('x', [{ path: 'a', message: 'b' }]).additionalData).toEqual({ issues: [{ path: 'a', message: 'b' }] });
  });

  it('keeps the original cause of integration failures out of client data', () => {
    const cause = new Error('connection string with password');
    const error = new IntegrationError('redis', 'Unable to connect', cause);
    expect(error.statusCode).toBe(502);
    expect(error.additionalData).toEqual({ integration: 'redis' });
    expect((error as { cause?: unknown }).cause).toBe(cause);
  });

  it('recognises operational errors only', () => {
    expect(isAppError(new ForbiddenError())).toBe(true);
    expect(isAppError(new Error('x'))).toBe(false);
    expect(isAppError('x')).toBe(false);
  });
});
