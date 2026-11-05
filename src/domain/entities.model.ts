import type { Kobo } from '../utils/money.util';

/**
 * Domain models. They are plain data and deliberately independent of Prisma and Mongoose,
 * so services depend only on abstractions (Dependency Inversion).
 * Every `Kobo` field is an integer number of kobo.
 */

export type ProfileType = 'INDIVIDUAL' | 'CORPORATE';
export type ProfileStatus = 'ACTIVE' | 'SUSPENDED';
export type AccountStatus = 'ACTIVE' | 'FROZEN' | 'CLOSED';

export type TransactionType =
  | 'P2P_TRANSFER'
  | 'EXTERNAL_TRANSFER'
  | 'AIRTIME'
  | 'DATA'
  | 'ELECTRICITY'
  | 'EDUCATION'
  | 'TV'
  | 'FOOD'
  | 'FUNDING';

export type TransactionStatus = 'PENDING' | 'PROCESSING' | 'SUCCESS' | 'FAILED';
export type LedgerDirection = 'DEBIT' | 'CREDIT';
export type CostType = 'FREE_TRANSFER' | 'IDENTITY_VERIFICATION' | 'SMS_OTP' | 'EMAIL' | 'PROVIDER_PURCHASE';
export type ApiKeyStatus = 'ACTIVE' | 'REVOKED';

/** The transaction types that count towards the monthly free-transfer allowance. */
export const TRANSFER_TYPES: readonly TransactionType[] = ['P2P_TRANSFER', 'EXTERNAL_TRANSFER'];

/** A user of the platform. Individuals and corporates are both "profiles". */
export interface Profile {
  id: string;
  type: ProfileType;
  email: string;
  phone: string;
  passwordHash: string;
  firstName: string | null;
  lastName: string | null;
  businessName: string | null;
  bvnHash: string | null;
  status: ProfileStatus;
  emailVerifiedAt: Date | null;
  phoneVerifiedAt: Date | null;
  identityVerifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A 10-digit account belonging to a profile. A profile may hold several. */
export interface Account {
  id: string;
  accountNumber: string;
  profileId: string;
  name: string;
  currency: string;
  balance: Kobo;
  /** Optimistic-locking counter, incremented on every balance change. */
  version: number;
  status: AccountStatus;
  createdAt: Date;
  updatedAt: Date;
}

/** A money movement or purchase. */
export interface Transaction {
  id: string;
  reference: string;
  idempotencyKey: string | null;
  profileId: string;
  accountId: string;
  type: TransactionType;
  status: TransactionStatus;
  amount: Kobo;
  fee: Kobo;
  discount: Kobo;
  /** amount + fee - discount: what leaves the sender's account. */
  totalDebit: Kobo;
  feeWaived: boolean;
  counterpartyAccountId: string | null;
  counterpartyName: string | null;
  counterpartyBank: string | null;
  provider: string | null;
  providerReference: string | null;
  narration: string | null;
  metadata: Record<string, unknown> | null;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** One side of a double-entry record. */
export interface LedgerEntry {
  id: string;
  transactionId: string;
  accountId: string;
  direction: LedgerDirection;
  amount: Kobo;
  balanceAfter: Kobo;
  description: string | null;
  createdAt: Date;
}

/** A corporate API credential. Only the hash of the key is stored. */
export interface ApiKey {
  id: string;
  profileId: string;
  name: string;
  prefix: string;
  keyHash: string;
  allowedIps: string[];
  status: ApiKeyStatus;
  lastUsedAt: Date | null;
  createdAt: Date;
  revokedAt: Date | null;
}

/** What something cost Sentodo (free transfers, identity checks, SMS, and so on). */
export interface CostRecord {
  id: string;
  type: CostType;
  amount: Kobo;
  profileId: string | null;
  reference: string | null;
  note: string | null;
  createdAt: Date;
}

/** A hashed one-time code, stored in MongoDB with a TTL. */
export interface VerificationCode {
  id: string;
  profileId: string;
  channel: 'EMAIL' | 'PHONE';
  codeHash: string;
  attempts: number;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

/** Append-only audit trail entry. */
export interface AuditLog {
  id: string;
  action: string;
  actorId: string | null;
  ip: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

/** A switchable capability or provider controlled by the App Command Centre. */
export interface ServiceState {
  key: string;
  kind: 'FEATURE' | 'PROVIDER';
  enabled: boolean;
  reason: string | null;
  updatedBy: string | null;
  updatedAt: Date;
}
