import { createHash, randomBytes, randomInt, timingSafeEqual } from 'crypto';

/**
 * Computes a hex SHA-256 digest.
 * @param {string} value - The input.
 * @returns {string} The digest.
 */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Compares two strings in constant time.
 * @param {string} a - The first string.
 * @param {string} b - The second string.
 * @returns {boolean} True if they are identical.
 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Generates a numeric one-time code using a cryptographically secure source.
 * @param {number} [length=6] - Number of digits.
 * @returns {string} The zero-padded code.
 */
export function generateNumericCode(length = 6): string {
  return String(randomInt(0, 10 ** length)).padStart(length, '0');
}

/**
 * Generates a corporate API key. The raw key is returned once; only its hash is stored.
 * @returns {{ key: string; prefix: string; hash: string }} The key, its display prefix and its hash.
 */
export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const key = `sk_live_${randomBytes(24).toString('hex')}`;
  return { key, prefix: key.slice(0, 12), hash: sha256(key) };
}

/**
 * Generates a unique, sortable transaction reference such as "SNT-LZ3K9-4F2A9C1B".
 * @returns {string} The reference.
 */
export function generateReference(): string {
  return `SNT-${Date.now().toString(36).toUpperCase()}-${randomBytes(4).toString('hex').toUpperCase()}`;
}
