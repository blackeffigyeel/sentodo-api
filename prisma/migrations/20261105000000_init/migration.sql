-- Initial Sentodo schema. Mirrors prisma/schema.prisma.
-- Monetary columns are BIGINT holding kobo (integer minor units).
-- The CHECK constraints below are defence in depth: they are enforced by PostgreSQL even if
-- application code has a bug. Prisma does not model CHECK constraints, so they live only here.

-- CreateEnum
CREATE TYPE "ProfileType" AS ENUM ('INDIVIDUAL', 'CORPORATE');
CREATE TYPE "ProfileStatus" AS ENUM ('ACTIVE', 'SUSPENDED');
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'FROZEN', 'CLOSED');
CREATE TYPE "TransactionType" AS ENUM ('P2P_TRANSFER', 'EXTERNAL_TRANSFER', 'AIRTIME', 'DATA', 'ELECTRICITY', 'EDUCATION', 'TV', 'FOOD', 'FUNDING');
CREATE TYPE "TransactionStatus" AS ENUM ('PENDING', 'PROCESSING', 'SUCCESS', 'FAILED');
CREATE TYPE "LedgerDirection" AS ENUM ('DEBIT', 'CREDIT');
CREATE TYPE "CostType" AS ENUM ('FREE_TRANSFER', 'IDENTITY_VERIFICATION', 'SMS_OTP', 'EMAIL', 'PROVIDER_PURCHASE');
CREATE TYPE "ApiKeyStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateTable
CREATE TABLE "profiles" (
    "id" TEXT NOT NULL,
    "type" "ProfileType" NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "businessName" TEXT,
    "bvnHash" TEXT,
    "status" "ProfileStatus" NOT NULL DEFAULT 'ACTIVE',
    "emailVerifiedAt" TIMESTAMP(3),
    "phoneVerifiedAt" TIMESTAMP(3),
    "identityVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "profiles_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "accountNumber" VARCHAR(10) NOT NULL,
    "profileId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'NGN',
    "balance" BIGINT NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "accounts_balance_non_negative" CHECK ("balance" >= 0),
    CONSTRAINT "accounts_account_number_digits" CHECK ("accountNumber" ~ '^[0-9]{10}$')
);

CREATE TABLE "transactions" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "profileId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "type" "TransactionType" NOT NULL,
    "status" "TransactionStatus" NOT NULL DEFAULT 'PENDING',
    "amount" BIGINT NOT NULL,
    "fee" BIGINT NOT NULL DEFAULT 0,
    "discount" BIGINT NOT NULL DEFAULT 0,
    "totalDebit" BIGINT NOT NULL,
    "feeWaived" BOOLEAN NOT NULL DEFAULT false,
    "counterpartyAccountId" TEXT,
    "counterpartyName" TEXT,
    "counterpartyBank" TEXT,
    "provider" TEXT,
    "providerReference" TEXT,
    "narration" TEXT,
    "metadata" JSONB,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "transactions_amount_positive" CHECK ("amount" > 0),
    CONSTRAINT "transactions_fee_non_negative" CHECK ("fee" >= 0),
    CONSTRAINT "transactions_discount_non_negative" CHECK ("discount" >= 0),
    CONSTRAINT "transactions_total_debit_non_negative" CHECK ("totalDebit" >= 0)
);

CREATE TABLE "ledger_entries" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "direction" "LedgerDirection" NOT NULL,
    "amount" BIGINT NOT NULL,
    "balanceAfter" BIGINT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ledger_entries_amount_positive" CHECK ("amount" > 0),
    CONSTRAINT "ledger_entries_balance_after_non_negative" CHECK ("balanceAfter" >= 0)
);

CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "allowedIps" TEXT[],
    "status" "ApiKeyStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "cost_records" (
    "id" TEXT NOT NULL,
    "type" "CostType" NOT NULL,
    "amount" BIGINT NOT NULL,
    "profileId" TEXT,
    "reference" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cost_records_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "cost_records_amount_non_negative" CHECK ("amount" >= 0)
);

-- CreateIndex
CREATE UNIQUE INDEX "profiles_email_key" ON "profiles"("email");
CREATE UNIQUE INDEX "profiles_phone_key" ON "profiles"("phone");
CREATE UNIQUE INDEX "profiles_bvnHash_key" ON "profiles"("bvnHash");
CREATE UNIQUE INDEX "accounts_accountNumber_key" ON "accounts"("accountNumber");
CREATE INDEX "accounts_profileId_idx" ON "accounts"("profileId");
CREATE UNIQUE INDEX "transactions_reference_key" ON "transactions"("reference");
CREATE INDEX "transactions_profileId_createdAt_idx" ON "transactions"("profileId", "createdAt");
CREATE INDEX "transactions_accountId_createdAt_idx" ON "transactions"("accountId", "createdAt");
CREATE UNIQUE INDEX "transactions_profileId_idempotencyKey_key" ON "transactions"("profileId", "idempotencyKey");
CREATE INDEX "ledger_entries_accountId_createdAt_idx" ON "ledger_entries"("accountId", "createdAt");
CREATE UNIQUE INDEX "api_keys_keyHash_key" ON "api_keys"("keyHash");
CREATE INDEX "api_keys_profileId_idx" ON "api_keys"("profileId");
CREATE INDEX "cost_records_type_createdAt_idx" ON "cost_records"("type", "createdAt");

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cost_records" ADD CONSTRAINT "cost_records_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
