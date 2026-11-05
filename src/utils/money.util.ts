import { BadRequestError } from '../errors/app.errors';

/**
 * Money handling for Sentodo.
 *
 * RULES
 * 1. Every amount is an integer number of kobo (1 NGN = 100 kobo).
 * 2. Amounts are stored, transported and calculated as integers only.
 * 3. Conversion to naira happens at the display boundary, using integer maths
 *    and string formatting (never floating-point division).
 */

/** An amount of money expressed as an integer number of kobo. */
export type Kobo = number;

/** Kobo per naira. */
export const KOBO_PER_NAIRA = 100;

/** Basis points in 100 per cent (1 bp = 0.01%). */
export const BASIS_POINTS = 10_000;

/**
 * Asserts that a value is a safe integer.
 * @param {unknown} value - The value to check.
 * @param {string} [label='amount'] - Name used in the error message.
 * @returns {Kobo} The value, narrowed to a number.
 * @throws {BadRequestError} If the value is not a safe integer.
 */
export function assertKobo(value: unknown, label = 'amount'): Kobo {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new BadRequestError(`${label} must be an integer number of kobo`);
  }
  return value;
}

/**
 * Asserts that a value is a strictly positive integer amount of kobo.
 * @param {unknown} value - The value to check.
 * @param {string} [label='amount'] - Name used in the error message.
 * @returns {Kobo} The validated amount.
 * @throws {BadRequestError} If the value is not a positive safe integer.
 */
export function assertPositiveKobo(value: unknown, label = 'amount'): Kobo {
  const kobo = assertKobo(value, label);
  if (kobo <= 0) {
    throw new BadRequestError(`${label} must be greater than zero`);
  }
  return kobo;
}

/**
 * Adds amounts safely.
 * @param {...Kobo} amounts - Amounts to add.
 * @returns {Kobo} The sum.
 * @throws {BadRequestError} If any operand is invalid or the sum overflows.
 */
export function addKobo(...amounts: Kobo[]): Kobo {
  let total = 0;
  for (const amount of amounts) {
    total += assertKobo(amount);
    assertKobo(total, 'total');
  }
  return total;
}

/**
 * Subtracts one amount from another safely.
 * @param {Kobo} minuend - The amount to subtract from.
 * @param {Kobo} subtrahend - The amount to subtract.
 * @returns {Kobo} The difference (may be negative).
 */
export function subtractKobo(minuend: Kobo, subtrahend: Kobo): Kobo {
  return assertKobo(assertKobo(minuend) - assertKobo(subtrahend), 'difference');
}

/**
 * Applies a percentage, expressed in basis points, to an amount using integer
 * arithmetic and round-half-up. For example 750 bps is 7.5%.
 * @param {Kobo} amount - The base amount in kobo.
 * @param {number} basisPoints - The rate in basis points (non-negative integer).
 * @returns {Kobo} The calculated amount in kobo.
 */
export function applyBasisPoints(amount: Kobo, basisPoints: number): Kobo {
  assertKobo(amount);
  if (!Number.isInteger(basisPoints) || basisPoints < 0) {
    throw new BadRequestError('basis points must be a non-negative integer');
  }
  const product = BigInt(amount) * BigInt(basisPoints);
  const half = BigInt(BASIS_POINTS / 2);
  const rounded = (product + (product < 0n ? -half : half)) / BigInt(BASIS_POINTS);
  return assertKobo(Number(rounded), 'result');
}

/**
 * Converts a naira value supplied as a decimal string (e.g. "1250.50") into kobo.
 * Floating-point numbers are intentionally not accepted, because they cannot
 * represent most decimal amounts exactly.
 * @param {string} naira - A decimal string with at most two decimal places.
 * @returns {Kobo} The amount in kobo.
 * @throws {BadRequestError} If the string is not a valid naira amount.
 */
export function nairaToKobo(naira: string): Kobo {
  if (typeof naira !== 'string' || !/^\d+(\.\d{1,2})?$/.test(naira.trim())) {
    throw new BadRequestError('naira amount must be a decimal string with at most two decimal places');
  }
  const [whole, fraction = ''] = naira.trim().split('.');
  const kobo = Number(whole) * KOBO_PER_NAIRA + Number(fraction.padEnd(2, '0'));
  return assertKobo(kobo);
}

/**
 * Converts kobo to a plain decimal naira string without any currency symbol.
 * @param {Kobo} kobo - The amount in kobo.
 * @returns {string} For example "1250.50".
 */
export function koboToNairaString(kobo: Kobo): string {
  assertKobo(kobo);
  const sign = kobo < 0 ? '-' : '';
  const absolute = Math.abs(kobo);
  const whole = Math.floor(absolute / KOBO_PER_NAIRA);
  const fraction = String(absolute % KOBO_PER_NAIRA).padStart(2, '0');
  return `${sign}${whole}.${fraction}`;
}

/**
 * Formats kobo for display, e.g. 125050 becomes "₦1,250.50".
 * Display only: the result must never be parsed back into an amount.
 * @param {Kobo} kobo - The amount in kobo.
 * @returns {string} The formatted naira string.
 */
export function formatNaira(kobo: Kobo): string {
  const plain = koboToNairaString(kobo);
  const negative = plain.startsWith('-');
  const [whole, fraction] = (negative ? plain.slice(1) : plain).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}₦${grouped}.${fraction}`;
}

/**
 * Converts a BigInt (as returned by PostgreSQL via Prisma) into a safe integer number.
 * @param {bigint | number} value - The stored value.
 * @returns {Kobo} The value as a number.
 * @throws {Error} If the value exceeds Number.MAX_SAFE_INTEGER.
 */
export function fromDatabaseAmount(value: bigint | number): Kobo {
  const asNumber = Number(value);
  if (!Number.isSafeInteger(asNumber)) {
    throw new Error('Stored monetary value exceeds the safe integer range');
  }
  return asNumber;
}

/**
 * Converts kobo to a BigInt for persistence.
 * @param {Kobo} kobo - The amount in kobo.
 * @returns {bigint} The value for a BigInt column.
 */
export function toDatabaseAmount(kobo: Kobo): bigint {
  return BigInt(assertKobo(kobo));
}

/**
 * Builds the standard money object used in API responses: the integer value
 * plus a display string.
 * @param {Kobo} kobo - The amount in kobo.
 * @returns {{ kobo: Kobo; display: string }} The response representation.
 */
export function toMoneyView(kobo: Kobo): { kobo: Kobo; display: string } {
  return { kobo, display: formatNaira(kobo) };
}
