import { randomUUID } from 'crypto';
import type {
  Account,
  ApiKey,
  AuditLog,
  CostRecord,
  LedgerEntry,
  Profile,
  ServiceState,
  Transaction,
  VerificationCode,
} from '../../domain/entities.model';
import { TRANSFER_TYPES } from '../../domain/entities.model';
import { ConcurrencyConflictError, ConflictError, NotFoundError } from '../../errors/app.errors';
import type {
  AccountRepository,
  ApiKeyRepository,
  AuditLogRepository,
  CostRepository,
  LedgerRepository,
  NewAccount,
  NewApiKey,
  NewCostRecord,
  NewLedgerEntry,
  NewProfile,
  NewTransaction,
  NewVerificationCode,
  ProfileRepository,
  Repositories,
  ServiceStateRepository,
  TransactionalRepositories,
  TransactionPatch,
  TransactionQuery,
  TransactionRepository,
  UnitOfWork,
  VerificationCodeRepository,
} from '../interfaces/repositories.interface';

/**
 * In-memory repositories used by the test suite and for running the API without databases.
 * They honour the same contracts as the PostgreSQL and MongoDB implementations, including
 * optimistic locking and all-or-nothing units of work.
 */

/** The backing maps. Values are treated as immutable and replaced on update. */
export class MemoryDatabase {
  profiles = new Map<string, Profile>();
  accounts = new Map<string, Account>();
  transactions = new Map<string, Transaction>();
  ledger = new Map<string, LedgerEntry>();
  apiKeys = new Map<string, ApiKey>();
  costs = new Map<string, CostRecord>();
  verificationCodes = new Map<string, VerificationCode>();
  auditLogs = new Map<string, AuditLog>();
  serviceStates = new Map<string, ServiceState>();

  /** Captures the transactional tables so they can be restored on rollback. */
  snapshot(): Pick<MemoryDatabase, 'accounts' | 'transactions' | 'ledger' | 'costs'> {
    return {
      accounts: new Map(this.accounts),
      transactions: new Map(this.transactions),
      ledger: new Map(this.ledger),
      costs: new Map(this.costs),
    };
  }

  /** Restores a snapshot taken by {@link snapshot}. */
  restore(snapshot: Pick<MemoryDatabase, 'accounts' | 'transactions' | 'ledger' | 'costs'>): void {
    this.accounts = snapshot.accounts;
    this.transactions = snapshot.transactions;
    this.ledger = snapshot.ledger;
    this.costs = snapshot.costs;
  }
}

class MemoryProfileRepository implements ProfileRepository {
  constructor(private readonly db: MemoryDatabase) {}

  async create(data: NewProfile): Promise<Profile> {
    for (const existing of this.db.profiles.values()) {
      if (existing.email === data.email) throw new ConflictError('An account with this email already exists');
      if (existing.phone === data.phone) throw new ConflictError('An account with this phone number already exists');
    }
    const now = new Date();
    const profile: Profile = {
      id: randomUUID(),
      type: data.type,
      email: data.email,
      phone: data.phone,
      passwordHash: data.passwordHash,
      firstName: data.firstName ?? null,
      lastName: data.lastName ?? null,
      businessName: data.businessName ?? null,
      bvnHash: null,
      status: 'ACTIVE',
      emailVerifiedAt: null,
      phoneVerifiedAt: null,
      identityVerifiedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.profiles.set(profile.id, profile);
    return { ...profile };
  }

  async findById(id: string): Promise<Profile | null> {
    const found = this.db.profiles.get(id);
    return found ? { ...found } : null;
  }

  async findByEmail(email: string): Promise<Profile | null> {
    for (const profile of this.db.profiles.values()) if (profile.email === email) return { ...profile };
    return null;
  }

  async findByPhone(phone: string): Promise<Profile | null> {
    for (const profile of this.db.profiles.values()) if (profile.phone === phone) return { ...profile };
    return null;
  }

  async update(id: string, patch: Parameters<ProfileRepository['update']>[1]): Promise<Profile> {
    const current = this.db.profiles.get(id);
    if (!current) throw new NotFoundError('Profile not found');
    if (patch.bvnHash) {
      for (const other of this.db.profiles.values()) {
        if (other.id !== id && other.bvnHash === patch.bvnHash) throw new ConflictError('This BVN is already linked to another profile');
      }
    }
    const updated = { ...current, ...patch, updatedAt: new Date() };
    this.db.profiles.set(id, updated);
    return { ...updated };
  }
}

class MemoryAccountRepository implements AccountRepository {
  constructor(private readonly db: MemoryDatabase) {}

  async create(data: NewAccount): Promise<Account> {
    for (const existing of this.db.accounts.values()) {
      if (existing.accountNumber === data.accountNumber) throw new ConflictError('Account number already exists');
    }
    const now = new Date();
    const account: Account = {
      id: randomUUID(),
      accountNumber: data.accountNumber,
      profileId: data.profileId,
      name: data.name,
      currency: 'NGN',
      balance: 0,
      version: 0,
      status: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    };
    this.db.accounts.set(account.id, account);
    return { ...account };
  }

  async findById(id: string): Promise<Account | null> {
    const found = this.db.accounts.get(id);
    return found ? { ...found } : null;
  }

  async findByAccountNumber(accountNumber: string): Promise<Account | null> {
    for (const account of this.db.accounts.values()) if (account.accountNumber === accountNumber) return { ...account };
    return null;
  }

  async listByProfile(profileId: string): Promise<Account[]> {
    return [...this.db.accounts.values()].filter((a) => a.profileId === profileId).map((a) => ({ ...a }));
  }

  async updateBalance(id: string, expectedVersion: number, newBalance: number): Promise<Account> {
    const current = this.db.accounts.get(id);
    if (!current) throw new NotFoundError('Account not found');
    if (current.version !== expectedVersion) throw new ConcurrencyConflictError();
    const updated = { ...current, balance: newBalance, version: current.version + 1, updatedAt: new Date() };
    this.db.accounts.set(id, updated);
    return { ...updated };
  }
}

class MemoryTransactionRepository implements TransactionRepository {
  constructor(private readonly db: MemoryDatabase) {}

  async create(data: NewTransaction): Promise<Transaction> {
    for (const existing of this.db.transactions.values()) {
      if (existing.reference === data.reference) throw new ConflictError('Duplicate transaction reference');
      if (data.idempotencyKey && existing.profileId === data.profileId && existing.idempotencyKey === data.idempotencyKey) {
        throw new ConflictError('Duplicate idempotency key');
      }
    }
    const now = new Date();
    const transaction: Transaction = {
      id: randomUUID(),
      reference: data.reference,
      idempotencyKey: data.idempotencyKey ?? null,
      profileId: data.profileId,
      accountId: data.accountId,
      type: data.type,
      status: data.status ?? 'PENDING',
      amount: data.amount,
      fee: data.fee,
      discount: data.discount,
      totalDebit: data.totalDebit,
      feeWaived: data.feeWaived,
      counterpartyAccountId: data.counterpartyAccountId ?? null,
      counterpartyName: data.counterpartyName ?? null,
      counterpartyBank: data.counterpartyBank ?? null,
      provider: data.provider ?? null,
      providerReference: null,
      narration: data.narration ?? null,
      metadata: data.metadata ?? null,
      failureReason: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.transactions.set(transaction.id, transaction);
    return { ...transaction };
  }

  async findById(id: string): Promise<Transaction | null> {
    const found = this.db.transactions.get(id);
    return found ? { ...found } : null;
  }

  async findByReference(reference: string): Promise<Transaction | null> {
    for (const t of this.db.transactions.values()) if (t.reference === reference) return { ...t };
    return null;
  }

  async findByIdempotencyKey(profileId: string, key: string): Promise<Transaction | null> {
    for (const t of this.db.transactions.values()) {
      if (t.profileId === profileId && t.idempotencyKey === key) return { ...t };
    }
    return null;
  }

  async update(id: string, patch: TransactionPatch): Promise<Transaction> {
    const current = this.db.transactions.get(id);
    if (!current) throw new NotFoundError('Transaction not found');
    const updated = { ...current, ...patch, updatedAt: new Date() };
    this.db.transactions.set(id, updated);
    return { ...updated };
  }

  async transition(
    id: string,
    from: Transaction['status'][],
    to: Transaction['status'],
    patch: TransactionPatch = {},
  ): Promise<Transaction | null> {
    const current = this.db.transactions.get(id);
    if (!current || !from.includes(current.status)) return null;
    const updated = { ...current, ...patch, status: to, updatedAt: new Date() };
    this.db.transactions.set(id, updated);
    return { ...updated };
  }

  async list(query: TransactionQuery): Promise<Transaction[]> {
    return [...this.db.transactions.values()]
      .filter((t) => t.profileId === query.profileId)
      .filter((t) => !query.accountId || t.accountId === query.accountId)
      .filter((t) => !query.type || t.type === query.type)
      .filter((t) => !query.status || t.status === query.status)
      .filter((t) => !query.before || t.createdAt < query.before)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, query.limit)
      .map((t) => ({ ...t }));
  }

  async countFreeTransfersSince(profileId: string, since: Date): Promise<number> {
    return [...this.db.transactions.values()].filter(
      (t) =>
        t.profileId === profileId &&
        TRANSFER_TYPES.includes(t.type) &&
        t.feeWaived &&
        t.status !== 'FAILED' &&
        t.createdAt >= since,
    ).length;
  }
}

class MemoryLedgerRepository implements LedgerRepository {
  constructor(private readonly db: MemoryDatabase) {}

  async add(entries: NewLedgerEntry[]): Promise<LedgerEntry[]> {
    return entries.map((entry) => {
      const created: LedgerEntry = { ...entry, id: randomUUID(), createdAt: new Date() };
      this.db.ledger.set(created.id, created);
      return { ...created };
    });
  }

  async listByAccount(accountId: string, limit: number): Promise<LedgerEntry[]> {
    return [...this.db.ledger.values()]
      .filter((e) => e.accountId === accountId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }
}

class MemoryApiKeyRepository implements ApiKeyRepository {
  constructor(private readonly db: MemoryDatabase) {}

  async create(data: NewApiKey): Promise<ApiKey> {
    const key: ApiKey = {
      id: randomUUID(),
      ...data,
      status: 'ACTIVE',
      lastUsedAt: null,
      createdAt: new Date(),
      revokedAt: null,
    };
    this.db.apiKeys.set(key.id, key);
    return { ...key, allowedIps: [...key.allowedIps] };
  }

  async findById(id: string): Promise<ApiKey | null> {
    const found = this.db.apiKeys.get(id);
    return found ? { ...found, allowedIps: [...found.allowedIps] } : null;
  }

  async findByHash(keyHash: string): Promise<ApiKey | null> {
    for (const key of this.db.apiKeys.values()) {
      if (key.keyHash === keyHash) return { ...key, allowedIps: [...key.allowedIps] };
    }
    return null;
  }

  async listByProfile(profileId: string): Promise<ApiKey[]> {
    return [...this.db.apiKeys.values()]
      .filter((k) => k.profileId === profileId)
      .map((k) => ({ ...k, allowedIps: [...k.allowedIps] }));
  }

  async update(id: string, patch: Parameters<ApiKeyRepository['update']>[1]): Promise<ApiKey> {
    const current = this.db.apiKeys.get(id);
    if (!current) throw new NotFoundError('API key not found');
    const updated = { ...current, ...patch };
    this.db.apiKeys.set(id, updated);
    return { ...updated, allowedIps: [...updated.allowedIps] };
  }
}

class MemoryCostRepository implements CostRepository {
  constructor(private readonly db: MemoryDatabase) {}

  async add(data: NewCostRecord): Promise<CostRecord> {
    const record: CostRecord = {
      id: randomUUID(),
      type: data.type,
      amount: data.amount,
      profileId: data.profileId ?? null,
      reference: data.reference ?? null,
      note: data.note ?? null,
      createdAt: new Date(),
    };
    this.db.costs.set(record.id, record);
    return { ...record };
  }

  async listByType(type: CostRecord['type'], limit: number): Promise<CostRecord[]> {
    return [...this.db.costs.values()].filter((c) => c.type === type).slice(0, limit);
  }
}

class MemoryUnitOfWork implements UnitOfWork {
  /** Runs are serialised so a rollback's snapshot restore can never erase a concurrent commit. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly db: MemoryDatabase, private readonly repositories: TransactionalRepositories) {}

  async run<T>(work: (repositories: TransactionalRepositories) => Promise<T>): Promise<T> {
    const execute = async (): Promise<T> => {
      const snapshot = this.db.snapshot();
      try {
        return await work(this.repositories);
      } catch (error) {
        this.db.restore(snapshot);
        throw error;
      }
    };
    const result = this.tail.then(execute, execute);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

class MemoryVerificationCodeRepository implements VerificationCodeRepository {
  constructor(private readonly db: MemoryDatabase) {}

  async replace(data: NewVerificationCode): Promise<VerificationCode> {
    for (const [id, code] of this.db.verificationCodes) {
      if (code.profileId === data.profileId && code.channel === data.channel) this.db.verificationCodes.delete(id);
    }
    const created: VerificationCode = {
      id: randomUUID(),
      ...data,
      attempts: 0,
      consumedAt: null,
      createdAt: new Date(),
    };
    this.db.verificationCodes.set(created.id, created);
    return { ...created };
  }

  async findActive(profileId: string, channel: VerificationCode['channel']): Promise<VerificationCode | null> {
    for (const code of this.db.verificationCodes.values()) {
      if (code.profileId === profileId && code.channel === channel && !code.consumedAt && code.expiresAt > new Date()) {
        return { ...code };
      }
    }
    return null;
  }

  async incrementAttempts(id: string): Promise<VerificationCode> {
    const current = this.db.verificationCodes.get(id);
    if (!current) throw new NotFoundError('Verification code not found');
    const updated = { ...current, attempts: current.attempts + 1 };
    this.db.verificationCodes.set(id, updated);
    return { ...updated };
  }

  async markConsumed(id: string): Promise<void> {
    const current = this.db.verificationCodes.get(id);
    if (current) this.db.verificationCodes.set(id, { ...current, consumedAt: new Date() });
  }
}

class MemoryAuditLogRepository implements AuditLogRepository {
  constructor(private readonly db: MemoryDatabase) {}

  async add(data: Omit<AuditLog, 'id' | 'createdAt'>): Promise<void> {
    const entry: AuditLog = { id: randomUUID(), createdAt: new Date(), ...data };
    this.db.auditLogs.set(entry.id, entry);
  }
}

class MemoryServiceStateRepository implements ServiceStateRepository {
  constructor(private readonly db: MemoryDatabase) {}

  async list(): Promise<ServiceState[]> {
    return [...this.db.serviceStates.values()].map((s) => ({ ...s }));
  }

  async upsert(state: Omit<ServiceState, 'updatedAt'>): Promise<ServiceState> {
    const saved: ServiceState = { ...state, updatedAt: new Date() };
    this.db.serviceStates.set(saved.key, saved);
    return { ...saved };
  }
}

/**
 * Creates a complete in-memory repository set.
 * @param {MemoryDatabase} [db] - An existing database to share, e.g. to inspect state in tests.
 * @returns {Repositories & { db: MemoryDatabase }} The repositories and their backing store.
 */
export function createMemoryRepositories(db: MemoryDatabase = new MemoryDatabase()): Repositories & { db: MemoryDatabase } {
  const transactional: TransactionalRepositories = {
    accounts: new MemoryAccountRepository(db),
    transactions: new MemoryTransactionRepository(db),
    ledger: new MemoryLedgerRepository(db),
    costs: new MemoryCostRepository(db),
  };
  return {
    db,
    profiles: new MemoryProfileRepository(db),
    apiKeys: new MemoryApiKeyRepository(db),
    verificationCodes: new MemoryVerificationCodeRepository(db),
    auditLogs: new MemoryAuditLogRepository(db),
    serviceStates: new MemoryServiceStateRepository(db),
    unitOfWork: new MemoryUnitOfWork(db, transactional),
    ...transactional,
  };
}
