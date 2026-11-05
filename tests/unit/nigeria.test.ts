import {
  detectNetwork,
  generateAccountNumber,
  isTenDigitAccountNumber,
  isValidIucNumber,
  isValidMeterNumber,
  isValidNuban,
  normalisePhone,
  nubanCheckDigit,
  SENTODO_BANK_CODE,
  startOfLagosMonth,
} from '../../src/utils/nigeria.util';

describe('Nigerian conventions', () => {
  describe('phone numbers', () => {
    it.each([
      ['08031234567', '08031234567'],
      ['+2348031234567', '08031234567'],
      ['2348031234567', '08031234567'],
      ['0803 123 4567', '08031234567'],
      ['0803-123-4567', '08031234567'],
      ['07012345678', '07012345678'],
      ['09012345678', '09012345678'],
    ])('normalises %s', (input, expected) => {
      expect(normalisePhone(input)).toBe(expected);
    });

    it.each(['12345', '0803123456', '080312345678', '09212345678', '06012345678', '+2348031234', 'abc', ''])(
      'rejects %p',
      (input) => {
        expect(normalisePhone(input)).toBeNull();
      },
    );

    it('detects the network from the prefix', () => {
      expect(detectNetwork('08031234567')).toBe('MTN');
      expect(detectNetwork('08021234567')).toBe('AIRTEL');
      expect(detectNetwork('08051234567')).toBe('GLO');
      expect(detectNetwork('08091234567')).toBe('9MOBILE');
      expect(detectNetwork('07999999999')).toBeNull();
    });
  });

  describe('decoder and meter numbers', () => {
    it('requires exactly 10 digits for IUC numbers', () => {
      expect(isValidIucNumber('7012345678')).toBe(true);
      expect(isValidIucNumber('701234567')).toBe(false);
      expect(isValidIucNumber('70123456789')).toBe(false);
      expect(isValidIucNumber('70123abcde')).toBe(false);
    });

    it('accepts 11 to 13 digit meter numbers', () => {
      expect(isValidMeterNumber('12345678901')).toBe(true);
      expect(isValidMeterNumber('1234567890123')).toBe(true);
      expect(isValidMeterNumber('1234567890')).toBe(false);
      expect(isValidMeterNumber('12345678901234')).toBe(false);
    });
  });

  describe('account numbers', () => {
    it('generates 10-digit numbers with a valid NUBAN check digit', () => {
      for (let i = 0; i < 50; i += 1) {
        const number = generateAccountNumber();
        expect(number).toMatch(/^\d{10}$/);
        expect(isValidNuban(number, SENTODO_BANK_CODE)).toBe(true);
      }
    });

    it('detects a wrong check digit', () => {
      const number = generateAccountNumber();
      const wrong = `${number.slice(0, 9)}${(Number(number[9]) + 1) % 10}`;
      expect(isValidNuban(wrong, SENTODO_BANK_CODE)).toBe(false);
    });

    it('computes the check digit deterministically', () => {
      expect(nubanCheckDigit('058', '000000001')).toBe(nubanCheckDigit('058', '000000001'));
      expect(nubanCheckDigit('058', '000000001')).toBeGreaterThanOrEqual(0);
      expect(nubanCheckDigit('058', '000000001')).toBeLessThanOrEqual(9);
    });

    it('validates only the 10-digit shape for other banks', () => {
      expect(isTenDigitAccountNumber('0123456789')).toBe(true);
      expect(isTenDigitAccountNumber('012345678')).toBe(false);
      expect(isValidNuban('abc', '090')).toBe(false);
    });
  });

  describe('Lagos month', () => {
    it('starts the month at midnight WAT (23:00 UTC the day before)', () => {
      expect(startOfLagosMonth(new Date('2026-11-15T12:00:00Z')).toISOString()).toBe('2026-10-31T23:00:00.000Z');
    });

    it('treats late 30 November UTC as December in Lagos', () => {
      expect(startOfLagosMonth(new Date('2026-11-30T23:30:00Z')).toISOString()).toBe('2026-11-30T23:00:00.000Z');
    });

    it('handles January', () => {
      expect(startOfLagosMonth(new Date('2027-01-10T08:00:00Z')).toISOString()).toBe('2026-12-31T23:00:00.000Z');
    });
  });
});
