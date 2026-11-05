import type { Prisma } from '@prisma/client';
import { PrismaClient } from '@prisma/client';
import type {
  Account,
  ApiKey,
  CostRecord,
  LedgerEntry,
  Profile,
  Transaction,
} from '../../domain/entities.model';
import { TRANSFER_TYPES } from '../../domain/entities.model';
import { ConcurrencyConflictError, ConflictError, NotFoundError } from '../../errors/app.errors';
import { fromDatabaseAmount, toDatabaseAmount } from '../../utils/money.util';
import type {
  AccountRepository,
  ApiKeyRepository,
  CostRepository,
  LedgerRepository,
  NewAccount,
  NewApiKey,
  NewCostRecord,
  NewLedgerEntry,
  NewProfile,
  NewTransaction,
  ProfilePatch,
  ProfileRepository,
  TransactionalRepositories,
  TransactionPatch,
  TransactionQuery,
  TransactionRepository,
  UnitOfWork,
} from '../interfaces/repositories.interface';

/**
 * PostgreSQL repositories (Prisma). Every class accepts either the root client or a
 * transaction client, so the same code runs standalone or inside a {@link PostgresUnitOfWork}.
 * Monetary columns are BigInt in the database and plain integer numbers in the domain.
 */
type Db = Prisma.TransactionClient;

/** @returns {boolean} True when the error is a PostgreSQL unique-constraint violation (Prisma P2002). */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';
}

type ProfileRow = Awaited<ReturnType<Db['profile']['findUniqueOrThrow']>>;
type AccountRow = Awaited<ReturnType<Db['account']['findUniqueOrThrow']>>;
type TransactionRow = Awaited<ReturnType<Db['transaction']['findUniqueOrThrow']>>;
type LedgerRow = Awaited<ReturnType<Db['ledgerEntry']['findFirstOrThrow']>>;
type ApiKeyRow = Awaited<ReturnType<Db['apiKey']['findUniqueOrThrow']>>;
type CostRow = Awaited<ReturnType<Db['costRecord']['findFirstOrThrow']>>;

const toProfile = (row: ProfileRow): Profile => ({ ...row });

const toAccount = (row: AccountRow): Account => ({ ...row, balance: fromDatabaseAmount(row.balance) });

const toTransaction = (row: TransactionRow): Transaction => ({
  ...row,
  amount: fromDatabaseAmount(row.amount),
  fee: fromDatabaseAmount(row.fee),
  discount: fromDatabaseAmount(row.discount),
  totalDebit: fromDatabaseAmount(row.totalDebit),
  metadata: (row.metadata as Record<string, unknown> | null) ?? null,
});

const toLedgerEntry = (row: LedgerRow): LedgerEntry => ({
  ...row,
  amount: fromDatabaseAmount(row.amount),
  balanceAfter: fromDatabaseAmount(row.balanceAfter),
});

const toApiKey = (row: ApiKeyRow): ApiKey => ({ ...row });

const toCostRecord = (row: CostRow): CostRecord => ({ ...row, amount: fromDatabaseAmount(row.amount) });

/** Prisma implementation of {@link ProfileRepository}. */
export class PostgresProfileRepository implements ProfileRepository {
  constructor(private readonly db: Db) {}

  async create(data: NewProfile): Promise<Profile> {
    try {
      return toProfile(await this.db.profile.create({ data }));
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError('A profile with this email or phone number already exists');
      throw error;
    }
  }

  async findById(id: string): Promise<Profile | null> {
    const row = await this.db.profile.findUnique({ where: { id } });
    return row ? toProfile(row) : null;
  }

  async findByEmail(email: string): Promise<Profile | null> {
    const row = await this.db.profile.findUnique({ where: { email } });
    return row ? toProfile(row) : null;
  }

  async findByPhone(phone: string): Promise<Profile | null> {
    const row = await this.db.profile.findUnique({ where: { phone } });
    return row ? toProfile(row) : null;
  }

  async update(id: string, patch: ProfilePatch): Promise<Profile> {
    try {
      return toProfile(await this.db.profile.update({ where: { id }, data: patch }));
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError('This BVN is already linked to another profile');
      if ((error as { code?: string }).code === 'P2025') throw new NotFoundError('Profile not found');
      throw error;
    }
  }
}

/** Prisma implementation of {@link AccountRepository} with optimistic locking. */
export class PostgresAccountRepository implements AccountRepository {
  constructor(private readonly db: Db) {}

  async create(data: NewAccount): Promise<Account> {
    try {
      return toAccount(await this.db.account.create({ data }));
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError('Account number already exists');
      throw error;
    }
  }

  async findById(id: string): Promise<Account | null> {
    const row = await this.db.account.findUnique({ where: { id } });
    return row ? toAccount(row) : null;
  }

  async findByAccountNumber(accountNumber: string): Promise<Account | null> {
    const row = await this.db.account.findUnique({ where: { accountNumber } });
    return row ? toAccount(row) : null;
  }

  async listByProfile(profileId: string): Promise<Account[]> {
    const rows = await this.db.account.findMany({ where: { profileId }, orderBy: { createdAt: 'asc' } });
    return rows.map(toAccount);
  }

  async updateBalance(id: string, expectedVersion: number, newBalance: number): Promise<Account> {
    const result = await this.db.account.updateMany({
      where: { id, version: expectedVersion },
      data: { balance: toDatabaseAmount(newBalance), version: { increment: 1 } },
    });
    if (result.count === 0) {
      const exists = await this.db.account.findUnique({ where: { id }, select: { id: true } });
      if (!exists) throw new NotFoundError('Account not found');
      throw new ConcurrencyConflictError();
    }
    return toAccount(await this.db.account.findUniqueOrThrow({ where: { id } }));
  }
}

/** Prisma implementation of {@link TransactionRepository}. */
export class PostgresTransactionRepository implements TransactionRepository {
  constructor(private readonly db: Db) {}

  async create(data: NewTransaction): Promise<Transaction> {
    try {
      const row = await this.db.transaction.create({
        data: {
          reference: data.reference,
          idempotencyKey: data.idempotencyKey ?? null,
          profileId: data.profileId,
          accountId: data.accountId,
          type: data.type,
          status: data.status ?? 'PENDING',
          amount: toDatabaseAmount(data.amount),
          fee: toDatabaseAmount(data.fee),
          discount: toDatabaseAmount(data.discount),
          totalDebit: toDatabaseAmount(data.totalDebit),
          feeWaived: data.feeWaived,
          counterpartyAccountId: data.counterpartyAccountId ?? null,
          counterpartyName: data.counterpartyName ?? null,
          counterpartyBank: data.counterpartyBank ?? null,
          provider: data.provider ?? null,
          narration: data.narration ?? null,
          metadata: (data.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
        },
      });
      return toTransaction(row);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError('Duplicate transaction reference or idempotency key');
      throw error;
    }
  }

  async findById(id: string): Promise<Transaction | null> {
    const row = await this.db.transaction.findUnique({ where: { id } });
    return row ? toTransaction(row) : null;
  }

  async findByReference(reference: string): Promise<Transaction | null> {
    const row = await this.db.transaction.findUnique({ where: { reference } });
    return row ? toTransaction(row) : null;
  }

  async findByIdempotencyKey(profileId: string, key: string): Promise<Transaction | null> {
    const row = await this.db.transaction.findUnique({
      where: { profileId_idempotencyKey: { profileId, idempotencyKey: key } },
    });
    return row ? toTransaction(row) : null;
  }

  async update(id: string, patch: TransactionPatch): Promise<Transaction> {
    try {
      const row = await this.db.transaction.update({
        where: { id },
        data: { ...patch, metadata: patch.metadata as Prisma.InputJsonValue | undefined },
      });
      return toTransaction(row);
    } catch (error) {
      if ((error as { code?: string }).code === 'P2025') throw new NotFoundError('Transaction not found');
      throw error;
    }
  }

  async transition(
    id: string,
    from: Transaction['status'][],
    to: Transaction['status'],
    patch: TransactionPatch = {},
  ): Promise<Transaction | null> {
    const result = await this.db.transaction.updateMany({
      where: { id, status: { in: from } },
      data: { ...patch, metadata: patch.metadata as Prisma.InputJsonValue | undefined, status: to },
    });
    if (result.count === 0) return null;
    return toTransaction(await this.db.transaction.findUniqueOrThrow({ where: { id } }));
  }

  async list(query: TransactionQuery): Promise<Transaction[]> {
    const rows = await this.db.transaction.findMany({
      where: {
        profileId: query.profileId,
        accountId: query.accountId,
        type: query.type,
        status: query.status,
        createdAt: query.before ? { lt: query.before } : undefined,
      },
      orderBy: { createdAt: 'desc' },
      take: query.limit,
    });
    return rows.map(toTransaction);
  }

  async countFreeTransfersSince(profileId: string, since: Date): Promise<number> {
    return this.db.transaction.count({
      where: {
        profileId,
        type: { in: [...TRANSFER_TYPES] },
        feeWaived: true,
        status: { not: 'FAILED' },
        createdAt: { gte: since },
      },
    });
  }
}

/** Prisma implementation of {@link LedgerRepository}. */
export class PostgresLedgerRepository implements LedgerRepository {
  constructor(private readonly db: Db) {}

  async add(entries: NewLedgerEntry[]): Promise<LedgerEntry[]> {
    const created: LedgerEntry[] = [];
    for (const entry of entries) {
      const row = await this.db.ledgerEntry.create({
        data: {
          transactionId: entry.transactionId,
          accountId: entry.accountId,
          direction: entry.direction,
          amount: toDatabaseAmount(entry.amount),
          balanceAfter: toDatabaseAmount(entry.balanceAfter),
          description: entry.description,
        },
      });
      created.push(toLedgerEntry(row));
    }
    return created;
  }

  async listByAccount(accountId: string, limit: number): Promise<LedgerEntry[]> {
    const rows = await this.db.ledgerEntry.findMany({ where: { accountId }, orderBy: { createdAt: 'desc' }, take: limit });
    return rows.map(toLedgerEntry);
  }
}

/** Prisma implementation of {@link ApiKeyRepository}. */
export class PostgresApiKeyRepository implements ApiKeyRepository {
  constructor(private readonly db: Db) {}

  async create(data: NewApiKey): Promise<ApiKey> {
    return toApiKey(await this.db.apiKey.create({ data }));
  }

  async findById(id: string): Promise<ApiKey | null> {
    const row = await this.db.apiKey.findUnique({ where: { id } });
    return row ? toApiKey(row) : null;
  }

  async findByHash(keyHash: string): Promise<ApiKey | null> {
    const row = await this.db.apiKey.findUnique({ where: { keyHash } });
    return row ? toApiKey(row) : null;
  }

  async listByProfile(profileId: string): Promise<ApiKey[]> {
    const rows = await this.db.apiKey.findMany({ where: { profileId }, orderBy: { createdAt: 'desc' } });
    return rows.map(toApiKey);
  }

  async update(id: string, patch: Parameters<ApiKeyRepository['update']>[1]): Promise<ApiKey> {
    try {
      return toApiKey(await this.db.apiKey.update({ where: { id }, data: patch }));
    } catch (error) {
      if ((error as { code?: string }).code === 'P2025') throw new NotFoundError('API key not found');
      throw error;
    }
  }
}

/** Prisma implementation of {@link CostRepository}. */
export class PostgresCostRepository implements CostRepository {
  constructor(private readonly db: Db) {}

  async add(data: NewCostRecord): Promise<CostRecord> {
    const row = await this.db.costRecord.create({
      data: {
        type: data.type,
        amount: toDatabaseAmount(data.amount),
        profileId: data.profileId ?? null,
        reference: data.reference ?? null,
        note: data.note ?? null,
      },
    });
    return toCostRecord(row);
  }

  async listByType(type: CostRecord['type'], limit: number): Promise<CostRecord[]> {
    const rows = await this.db.costRecord.findMany({ where: { type }, orderBy: { createdAt: 'desc' }, take: limit });
    return rows.map(toCostRecord);
  }
}

/**
 * Builds the transaction-aware repositories bound to one Prisma client or transaction.
 * @param {Db} db - The Prisma client or transaction client.
 * @returns {TransactionalRepositories} The repositories.
 */
export function buildTransactionalRepositories(db: Db): TransactionalRepositories {
  return {
    accounts: new PostgresAccountRepository(db),
    transactions: new PostgresTransactionRepository(db),
    ledger: new PostgresLedgerRepository(db),
    costs: new PostgresCostRepository(db),
  };
}

/** Runs work inside a single PostgreSQL transaction; any thrown error rolls everything back. */
export class PostgresUnitOfWork implements UnitOfWork {
  constructor(private readonly client: PrismaClient) {}

  async run<T>(work: (repositories: TransactionalRepositories) => Promise<T>): Promise<T> {
    return this.client.$transaction((tx) => work(buildTransactionalRepositories(tx)), {
      maxWait: 5_000,
      timeout: 15_000,
    });
  }
}
