import type { Kobo } from '../utils/money.util';

/**
 * Provider contracts. Real aggregators (VTpass, NIBSS NIP, a BVN vendor, ...) would implement
 * these same interfaces; today every implementation is a mock under `./mock`.
 * Each provider has a stable identifier that the App Command Centre can switch on or off.
 */

/** The purchasable bill categories. */
export type BillCategory = 'AIRTIME' | 'DATA' | 'ELECTRICITY' | 'EDUCATION' | 'TV' | 'FOOD';

/** Common metadata every provider exposes. */
export interface ProviderInfo {
  /** Stable identifier, e.g. "mock-tv-dstv". Used by the command centre. */
  readonly id: string;
  readonly name: string;
}

/** What the platform asks a bill provider to fulfil. */
export interface PurchaseRequest {
  /** Sentodo's transaction reference; providers must treat it as an idempotency key. */
  reference: string;
  amount: Kobo;
  /** Phone number, meter number, IUC number, exam profile code or delivery phone. */
  customerId: string;
  /** Catalogue product code, e.g. a data plan or TV bouquet. */
  productCode?: string;
  metadata?: Record<string, unknown>;
}

/** What a provider returns after a successful purchase. */
export interface PurchaseResult {
  providerReference: string;
  /** Electricity token, exam PIN or food order code, where applicable. */
  token?: string;
  details?: Record<string, unknown>;
}

/** The result of validating a customer, e.g. a TV smart card holder. */
export interface CustomerValidation {
  valid: boolean;
  customerName?: string;
  details?: Record<string, unknown>;
}

/** Fulfils a purchase for one category. */
export interface BillProvider extends ProviderInfo {
  readonly category: BillCategory;
  purchase(request: PurchaseRequest): Promise<PurchaseResult>;
  /** Only TV providers implement validation, as required by the product specification. */
  validateCustomer?(customerId: string, productCode?: string): Promise<CustomerValidation>;
}

/** Moves money to another bank. */
export interface TransferRequest {
  reference: string;
  amount: Kobo;
  bankCode: string;
  accountNumber: string;
  accountName: string;
  narration?: string;
}

/** Interbank transfer rail (NIP-like). */
export interface TransferProvider extends ProviderInfo {
  send(request: TransferRequest): Promise<{ providerReference: string }>;
  resolveAccount(bankCode: string, accountNumber: string): Promise<{ accountName: string }>;
}

/** A person known to the identity provider. */
export interface IdentityRecord {
  bvn: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  phone: string;
}

/** Verifies customers against a national identity source. */
export interface IdentityProvider extends ProviderInfo {
  lookupBvn(bvn: string): Promise<IdentityRecord | null>;
}

/** Sends the phone verification code. The mock does not send anything. */
export interface SmsProvider extends ProviderInfo {
  verifyCode(phone: string, code: string): Promise<boolean>;
}
