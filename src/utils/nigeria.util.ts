import { randomInt } from 'crypto';

/**
 * Nigerian conventions: phone numbers, account numbers (NUBAN), decoder IUC numbers,
 * meter numbers and the Lagos (WAT, UTC+1, no daylight saving) calendar month.
 */

/** Sentodo's CBN bank code, used as the NUBAN check-digit prefix. Replace with the issued code. */
export const SENTODO_BANK_CODE = '090';

/** Mobile network operators supported for airtime and data. */
export type NetworkCode = 'MTN' | 'AIRTEL' | 'GLO' | '9MOBILE';

const NETWORK_PREFIXES: Record<NetworkCode, string[]> = {
  MTN: ['0703', '0706', '0803', '0806', '0810', '0813', '0814', '0816', '0903', '0906', '0913', '0916', '07025', '07026', '0704'],
  AIRTEL: ['0701', '0708', '0802', '0808', '0812', '0901', '0902', '0904', '0907', '0912'],
  GLO: ['0705', '0805', '0807', '0811', '0815', '0905', '0915'],
  '9MOBILE': ['0809', '0817', '0818', '0908', '0909'],
};

/**
 * Normalises a Nigerian mobile number to the 11-digit national format (0XXXXXXXXXX).
 * Accepts "+234…", "234…" and "0…" forms with optional spaces or hyphens.
 * @param {string} input - The raw phone number.
 * @returns {string | null} The 11-digit number, or null if it is not a valid Nigerian mobile number.
 */
export function normalisePhone(input: string): string | null {
  const digits = String(input ?? '').replace(/[\s-]/g, '');
  let national = digits;
  if (/^\+234\d{10}$/.test(digits)) national = `0${digits.slice(4)}`;
  else if (/^234\d{10}$/.test(digits)) national = `0${digits.slice(3)}`;
  return /^0[789][01]\d{8}$/.test(national) ? national : null;
}

/**
 * Detects the mobile network from an 11-digit number's prefix.
 * @param {string} phone - A normalised 11-digit phone number.
 * @returns {NetworkCode | null} The network, or null if the prefix is unknown.
 */
export function detectNetwork(phone: string): NetworkCode | null {
  for (const [network, prefixes] of Object.entries(NETWORK_PREFIXES) as Array<[NetworkCode, string[]]>) {
    if (prefixes.some((prefix) => phone.startsWith(prefix))) return network;
  }
  return null;
}

/**
 * Checks a DStv/GOtv IUC (smart card) number: exactly 10 digits.
 * @param {string} iuc - The number.
 * @returns {boolean} True if valid.
 */
export function isValidIucNumber(iuc: string): boolean {
  return /^\d{10}$/.test(iuc);
}

/**
 * Checks a prepaid or postpaid electricity meter number: 11 to 13 digits.
 * @param {string} meter - The meter number.
 * @returns {boolean} True if valid.
 */
export function isValidMeterNumber(meter: string): boolean {
  return /^\d{11,13}$/.test(meter);
}

const NUBAN_WEIGHTS = [3, 7, 3, 3, 7, 3, 3, 7, 3, 3, 7, 3];

/**
 * Computes the NUBAN check digit for a bank code and 9-digit serial number.
 * @param {string} bankCode - Three-digit bank code.
 * @param {string} serial - Nine-digit account serial.
 * @returns {number} The check digit (0-9).
 */
export function nubanCheckDigit(bankCode: string, serial: string): number {
  const digits = `${bankCode}${serial}`;
  const sum = digits.split('').reduce((total, digit, index) => total + Number(digit) * NUBAN_WEIGHTS[index], 0);
  const remainder = sum % 10;
  return remainder === 0 ? 0 : 10 - remainder;
}

/**
 * Generates a random, valid 10-digit NUBAN account number for Sentodo.
 * @returns {string} The account number.
 */
export function generateAccountNumber(): string {
  const serial = String(randomInt(0, 1_000_000_000)).padStart(9, '0');
  return `${serial}${nubanCheckDigit(SENTODO_BANK_CODE, serial)}`;
}

/**
 * Validates the NUBAN check digit of an account number for a bank.
 * @param {string} accountNumber - The 10-digit account number.
 * @param {string} bankCode - Three-digit bank code.
 * @returns {boolean} True if the check digit matches.
 */
export function isValidNuban(accountNumber: string, bankCode: string): boolean {
  if (!/^\d{10}$/.test(accountNumber) || !/^\d{3}$/.test(bankCode)) return false;
  return nubanCheckDigit(bankCode, accountNumber.slice(0, 9)) === Number(accountNumber[9]);
}

/**
 * Checks the basic shape of any Nigerian bank account number: exactly 10 digits.
 * @param {string} accountNumber - The account number.
 * @returns {boolean} True if valid.
 */
export function isTenDigitAccountNumber(accountNumber: string): boolean {
  return /^\d{10}$/.test(accountNumber);
}

const WAT_OFFSET_MS = 60 * 60 * 1000;

/**
 * Returns the instant at which the current calendar month began in Lagos (WAT, UTC+1).
 * Used to reset monthly free-transfer allowances.
 * @param {Date} [now=new Date()] - The reference time.
 * @returns {Date} Midnight at the start of the Lagos month, as a UTC instant.
 */
export function startOfLagosMonth(now: Date = new Date()): Date {
  const lagos = new Date(now.getTime() + WAT_OFFSET_MS);
  return new Date(Date.UTC(lagos.getUTCFullYear(), lagos.getUTCMonth(), 1) - WAT_OFFSET_MS);
}
