import { z } from 'zod';
import { BadRequestError } from '../errors/app.errors';
import { normalisePhone } from '../utils/nigeria.util';
import type { Request } from 'express';

/** An 11-digit Nigerian mobile number; also accepts +234 and 234 forms and returns the 11-digit form. */
export const phoneSchema = z
  .string()
  .trim()
  .transform((value, ctx) => {
    const phone = normalisePhone(value);
    if (!phone) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Must be a valid 11-digit Nigerian mobile number' });
    return phone ?? '';
  });

export const emailSchema = z.string().trim().toLowerCase().email().max(254);

/** A strictly positive integer amount of kobo (1 NGN = 100 kobo). Decimals are rejected. */
export const koboSchema = z
  .number({ invalid_type_error: 'Must be an integer number of kobo' })
  .int('Must be an integer number of kobo')
  .positive('Must be greater than zero')
  .max(Number.MAX_SAFE_INTEGER);

export const uuidSchema = z.string().uuid();

/** A 10-digit account number. */
export const accountNumberSchema = z.string().regex(/^\d{10}$/, 'Must be exactly 10 digits');

/** Six digits, used for verification codes. */
export const sixDigitCodeSchema = z.string().regex(/^\d{6}$/, 'Must be a 6-digit code');

/**
 * Reads the optional `Idempotency-Key` header used to make money-moving calls safely retryable.
 * @param {Request} req - The request.
 * @returns {string | undefined} The key, if supplied.
 * @throws {BadRequestError} If the header is malformed.
 */
export function readIdempotencyKey(req: Request): string | undefined {
  const key = req.header('idempotency-key');
  if (key === undefined) return undefined;
  if (!/^[\w-]{8,64}$/.test(key)) {
    throw new BadRequestError('Idempotency-Key must be 8-64 characters: letters, digits, hyphens or underscores');
  }
  return key;
}
