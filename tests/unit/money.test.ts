import { BadRequestError } from '../../src/errors/app.errors';
import {
  addKobo,
  applyBasisPoints,
  assertKobo,
  assertPositiveKobo,
  formatNaira,
  fromDatabaseAmount,
  koboToNairaString,
  nairaToKobo,
  subtractKobo,
  toDatabaseAmount,
  toMoneyView,
} from '../../src/utils/money.util';

describe('money utilities', () => {
  describe('validation', () => {
    it('accepts safe integers', () => {
      expect(assertKobo(0)).toBe(0);
      expect(assertKobo(150_000)).toBe(150_000);
    });

    it.each([1.5, NaN, Infinity, '100', null, undefined, Number.MAX_SAFE_INTEGER + 1])('rejects %p', (value) => {
      expect(() => assertKobo(value)).toThrow(BadRequestError);
    });

    it('requires positive amounts', () => {
      expect(assertPositiveKobo(1)).toBe(1);
      expect(() => assertPositiveKobo(0)).toThrow('greater than zero');
      expect(() => assertPositiveKobo(-5)).toThrow(BadRequestError);
    });
  });

  describe('arithmetic', () => {
    it('adds and subtracts exactly, where floats would not', () => {
      // 0.1 + 0.2 !== 0.3 in floating point; in kobo it is exact.
      expect(addKobo(10, 20)).toBe(30);
      expect(subtractKobo(30, 10)).toBe(20);
    });

    it('throws when an addition overflows the safe range', () => {
      expect(() => addKobo(Number.MAX_SAFE_INTEGER, 1)).toThrow(BadRequestError);
    });

    it('applies basis points with round-half-up', () => {
      expect(applyBasisPoints(1_000, 750)).toBe(75);
      expect(applyBasisPoints(7, 750)).toBe(1); // 0.525 rounds up
      expect(applyBasisPoints(5, 750)).toBe(0); // 0.375 rounds down
      expect(applyBasisPoints(100_000, 250)).toBe(2_500);
      expect(applyBasisPoints(0, 750)).toBe(0);
    });

    it('rejects invalid basis points', () => {
      expect(() => applyBasisPoints(100, -1)).toThrow(BadRequestError);
      expect(() => applyBasisPoints(100, 1.5)).toThrow(BadRequestError);
    });

    it('keeps precision for very large amounts', () => {
      expect(applyBasisPoints(9_000_000_000_000, 750)).toBe(675_000_000_000);
    });
  });

  describe('conversion', () => {
    it.each([
      ['1250.50', 125_050],
      ['10', 1_000],
      ['0.5', 50],
      ['0.05', 5],
      ['0', 0],
    ])('converts "%s" naira to %d kobo', (naira, kobo) => {
      expect(nairaToKobo(naira)).toBe(kobo);
    });

    it.each(['1.234', '-1', 'abc', '', '1,000', '1.'])('rejects naira string %p', (value) => {
      expect(() => nairaToKobo(value)).toThrow(BadRequestError);
    });

    it('formats naira strings without floating-point division', () => {
      expect(koboToNairaString(125_050)).toBe('1250.50');
      expect(koboToNairaString(5)).toBe('0.05');
      expect(koboToNairaString(-150)).toBe('-1.50');
    });

    it('formats for display with grouping', () => {
      expect(formatNaira(125_050)).toBe('₦1,250.50');
      expect(formatNaira(100_000_000)).toBe('₦1,000,000.00');
      expect(formatNaira(5)).toBe('₦0.05');
      expect(formatNaira(-150)).toBe('-₦1.50');
    });

    it('builds the response money view', () => {
      expect(toMoneyView(250_000)).toEqual({ kobo: 250_000, display: '₦2,500.00' });
    });

    it('converts to and from database BigInt', () => {
      expect(toDatabaseAmount(123)).toBe(123n);
      expect(fromDatabaseAmount(123n)).toBe(123);
      expect(() => fromDatabaseAmount(BigInt(Number.MAX_SAFE_INTEGER) + 10n)).toThrow();
    });
  });
});
