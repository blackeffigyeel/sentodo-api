import type { CostType, ProfileType } from './entities.model';
import { applyBasisPoints, type Kobo } from '../utils/money.util';

/**
 * Pricing rules. All values are integers (kobo or basis points) and are the single
 * source of truth for fees, discounts and Sentodo's own costs.
 */

/** Free transfers each profile type receives per Lagos calendar month. */
export const FREE_TRANSFERS_PER_MONTH: Record<ProfileType, number> = {
  INDIVIDUAL: 20,
  CORPORATE: 10,
};

/** Base transfer fee once the free allowance is used: NGN 10. */
export const TRANSFER_BASE_FEE: Kobo = 1_000;

/** Transfers strictly above this amount attract the surcharge: NGN 10,000. */
export const HIGH_VALUE_THRESHOLD: Kobo = 1_000_000;

/** Surcharge added for transfers above the threshold: NGN 50. */
export const HIGH_VALUE_SURCHARGE: Kobo = 5_000;

/** VAT on the fee: 7.5% expressed in basis points. */
export const VAT_BASIS_POINTS = 750;

/** Bill-payment discount by profile type, in basis points (1.00% and 2.50%). */
export const BILL_DISCOUNT_BASIS_POINTS: Record<ProfileType, number> = {
  INDIVIDUAL: 100,
  CORPORATE: 250,
};

/** Sentodo's cost of each action, in kobo. Placeholder figures to be replaced by contracted rates. */
export const COST_SCHEDULE: Record<Exclude<CostType, 'PROVIDER_PURCHASE'>, Kobo> = {
  FREE_TRANSFER: 1_000,
  IDENTITY_VERIFICATION: 5_000,
  SMS_OTP: 400,
  EMAIL: 10,
};

/** Itemised transfer fee. */
export interface TransferFee {
  /** True when the transfer used one of the free monthly allowances. */
  waived: boolean;
  baseFee: Kobo;
  surcharge: Kobo;
  vat: Kobo;
  /** What the customer is charged: baseFee + surcharge + vat, or 0 when waived. */
  total: Kobo;
}

/**
 * Calculates the fee for a transfer.
 *
 * Interpretation of the pricing rule: after the free allowance is exhausted the fee is NGN 10,
 * plus NGN 50 for transfers above NGN 10,000, and 7.5% VAT is charged on that fee.
 *
 * @param {Kobo} amount - The transfer amount in kobo.
 * @param {number} freeTransfersUsed - Free transfers already used this month.
 * @param {ProfileType} profileType - The sender's profile type.
 * @returns {TransferFee} The itemised fee.
 */
export function calculateTransferFee(amount: Kobo, freeTransfersUsed: number, profileType: ProfileType): TransferFee {
  if (freeTransfersUsed < FREE_TRANSFERS_PER_MONTH[profileType]) {
    return { waived: true, baseFee: 0, surcharge: 0, vat: 0, total: 0 };
  }
  const baseFee = TRANSFER_BASE_FEE;
  const surcharge = amount > HIGH_VALUE_THRESHOLD ? HIGH_VALUE_SURCHARGE : 0;
  const vat = applyBasisPoints(baseFee + surcharge, VAT_BASIS_POINTS);
  return { waived: false, baseFee, surcharge, vat, total: baseFee + surcharge + vat };
}

/**
 * Calculates the discount on a bill payment.
 * @param {Kobo} amount - The bill amount in kobo.
 * @param {ProfileType} profileType - The buyer's profile type.
 * @returns {Kobo} The discount in kobo.
 */
export function calculateBillDiscount(amount: Kobo, profileType: ProfileType): Kobo {
  return applyBasisPoints(amount, BILL_DISCOUNT_BASIS_POINTS[profileType]);
}
