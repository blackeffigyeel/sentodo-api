import type { Response } from 'express';

/** The single response envelope used by every endpoint. */
export interface ApiResponse<T = unknown> {
  success: boolean;
  message: string;
  data: T | null;
}

/**
 * Builds a success envelope.
 * @param {string} message - A short human-readable message.
 * @param {T | null} [data=null] - The payload.
 * @returns {ApiResponse<T>} The envelope.
 */
export function successBody<T>(message: string, data: T | null = null): ApiResponse<T> {
  return { success: true, message, data };
}

/**
 * Builds a failure envelope.
 * @param {string} message - A short human-readable message.
 * @param {T | null} [data=null] - Optional safe context, e.g. validation issues.
 * @returns {ApiResponse<T>} The envelope.
 */
export function failureBody<T>(message: string, data: T | null = null): ApiResponse<T> {
  return { success: false, message, data };
}

/**
 * Sends a success response using the standard envelope.
 * @param {Response} res - The Express response.
 * @param {number} statusCode - The HTTP status code.
 * @param {string} message - A short human-readable message.
 * @param {T | null} [data=null] - The payload.
 * @returns {Response} The Express response, for chaining.
 */
export function sendSuccess<T>(res: Response, statusCode: number, message: string, data: T | null = null): Response {
  return res.status(statusCode).json(successBody(message, data));
}
