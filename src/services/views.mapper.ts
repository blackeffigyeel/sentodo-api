import type { Account, ApiKey, Profile, Transaction } from '../domain/entities.model';
import { toMoneyView } from '../utils/money.util';

/**
 * Response mappers. Entities are never returned directly, which keeps secrets (password hashes,
 * key hashes) out of responses and gives clients a stable shape. Money is always returned as an
 * integer `kobo` value plus a `display` string.
 */

/** @returns {string} The profile's display name: business name for corporates, full name otherwise. */
export function displayName(profile: Pick<Profile, 'type' | 'firstName' | 'lastName' | 'businessName'>): string {
  if (profile.type === 'CORPORATE' && profile.businessName) return profile.businessName;
  return [profile.firstName, profile.lastName].filter(Boolean).join(' ') || 'Sentodo customer';
}

export const toProfileView = (profile: Profile) => ({
  id: profile.id,
  type: profile.type,
  email: profile.email,
  phone: profile.phone,
  firstName: profile.firstName,
  lastName: profile.lastName,
  businessName: profile.businessName,
  status: profile.status,
  emailVerified: profile.emailVerifiedAt !== null,
  phoneVerified: profile.phoneVerifiedAt !== null,
  identityVerified: profile.identityVerifiedAt !== null,
  createdAt: profile.createdAt,
});

export const toAccountView = (account: Account) => ({
  id: account.id,
  accountNumber: account.accountNumber,
  name: account.name,
  currency: account.currency,
  balance: toMoneyView(account.balance),
  status: account.status,
  createdAt: account.createdAt,
});

export const toTransactionView = (transaction: Transaction) => ({
  id: transaction.id,
  reference: transaction.reference,
  type: transaction.type,
  status: transaction.status,
  accountId: transaction.accountId,
  amount: toMoneyView(transaction.amount),
  fee: toMoneyView(transaction.fee),
  discount: toMoneyView(transaction.discount),
  totalDebit: toMoneyView(transaction.totalDebit),
  feeWaived: transaction.feeWaived,
  counterparty: transaction.counterpartyName
    ? {
        name: transaction.counterpartyName,
        bank: transaction.counterpartyBank,
      }
    : null,
  provider: transaction.provider,
  providerReference: transaction.providerReference,
  narration: transaction.narration,
  details: transaction.status === 'SUCCESS' ? transaction.metadata : null,
  failureReason: transaction.failureReason,
  createdAt: transaction.createdAt,
  updatedAt: transaction.updatedAt,
});

export const toApiKeyView = (key: ApiKey) => ({
  id: key.id,
  name: key.name,
  prefix: key.prefix,
  allowedIps: key.allowedIps,
  status: key.status,
  lastUsedAt: key.lastUsedAt,
  createdAt: key.createdAt,
  revokedAt: key.revokedAt,
});
