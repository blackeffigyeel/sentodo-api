import {
  calculateBillDiscount,
  calculateTransferFee,
  FREE_TRANSFERS_PER_MONTH,
  HIGH_VALUE_THRESHOLD,
} from '../../src/domain/pricing.rules';

describe('pricing rules', () => {
  describe('transfer fees', () => {
    it('is free while the monthly allowance lasts (20 individual, 10 corporate)', () => {
      expect(FREE_TRANSFERS_PER_MONTH).toEqual({ INDIVIDUAL: 20, CORPORATE: 10 });
      expect(calculateTransferFee(500_000, 0, 'INDIVIDUAL')).toMatchObject({ waived: true, total: 0 });
      expect(calculateTransferFee(500_000, 19, 'INDIVIDUAL').waived).toBe(true);
      expect(calculateTransferFee(500_000, 9, 'CORPORATE').waived).toBe(true);
    });

    it('charges NGN 10 plus 7.5% VAT once the allowance is used', () => {
      const fee = calculateTransferFee(500_000, 20, 'INDIVIDUAL');
      expect(fee).toEqual({ waived: false, baseFee: 1_000, surcharge: 0, vat: 75, total: 1_075 });
      expect(calculateTransferFee(500_000, 10, 'CORPORATE').total).toBe(1_075);
    });

    it('adds NGN 50 above NGN 10,000 and charges VAT on the whole fee', () => {
      const fee = calculateTransferFee(HIGH_VALUE_THRESHOLD + 1, 20, 'INDIVIDUAL');
      expect(fee).toEqual({ waived: false, baseFee: 1_000, surcharge: 5_000, vat: 450, total: 6_450 });
    });

    it('does not add the surcharge at exactly NGN 10,000', () => {
      expect(calculateTransferFee(HIGH_VALUE_THRESHOLD, 20, 'INDIVIDUAL').surcharge).toBe(0);
    });

    it('never produces fractional kobo', () => {
      for (const amount of [1, 99, 100, 123_457, 1_000_001, 499_999_999]) {
        const fee = calculateTransferFee(amount, 99, 'INDIVIDUAL');
        expect(Number.isInteger(fee.total)).toBe(true);
        expect(Number.isInteger(fee.vat)).toBe(true);
      }
    });
  });

  describe('bill discounts', () => {
    it('gives individuals 1% and corporates 2.5%', () => {
      expect(calculateBillDiscount(100_000, 'INDIVIDUAL')).toBe(1_000);
      expect(calculateBillDiscount(100_000, 'CORPORATE')).toBe(2_500);
    });

    it('rounds to whole kobo', () => {
      expect(calculateBillDiscount(150, 'INDIVIDUAL')).toBe(2);
      expect(calculateBillDiscount(49, 'INDIVIDUAL')).toBe(0);
    });
  });
});
