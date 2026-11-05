import { randomUUID } from 'crypto';
import { Schema, type Connection, type Model } from 'mongoose';
import type { AuditLog, ServiceState, VerificationCode } from '../../domain/entities.model';
import { NotFoundError } from '../../errors/app.errors';
import type {
  AuditLogRepository,
  NewVerificationCode,
  ServiceStateRepository,
  VerificationCodeRepository,
} from '../interfaces/repositories.interface';

/**
 * MongoDB repositories (Mongoose) for non-financial, high-churn data.
 * Documents use string UUID `_id`s so they map one-to-one onto the domain models.
 */

interface VerificationCodeDoc extends Omit<VerificationCode, 'id'> {
  _id: string;
}
interface AuditLogDoc extends Omit<AuditLog, 'id'> {
  _id: string;
}
type ServiceStateDoc = ServiceState;

const verificationCodeSchema = new Schema<VerificationCodeDoc>(
  {
    _id: { type: String, default: () => randomUUID() },
    profileId: { type: String, required: true, index: true },
    channel: { type: String, enum: ['EMAIL', 'PHONE'], required: true },
    codeHash: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
    consumedAt: { type: Date, default: null },
    createdAt: { type: Date, default: () => new Date() },
  },
  { versionKey: false },
);
// MongoDB removes expired documents automatically (the reaper runs about once a minute).
verificationCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
verificationCodeSchema.index({ profileId: 1, channel: 1 });

const auditLogSchema = new Schema<AuditLogDoc>(
  {
    _id: { type: String, default: () => randomUUID() },
    action: { type: String, required: true, index: true },
    actorId: { type: String, default: null, index: true },
    ip: { type: String, default: null },
    metadata: { type: Schema.Types.Mixed, default: {} },
    createdAt: { type: Date, default: () => new Date(), index: true },
  },
  { versionKey: false },
);

const serviceStateSchema = new Schema<ServiceStateDoc>(
  {
    key: { type: String, required: true, unique: true },
    kind: { type: String, enum: ['FEATURE', 'PROVIDER'], required: true },
    enabled: { type: Boolean, required: true },
    reason: { type: String, default: null },
    updatedBy: { type: String, default: null },
    updatedAt: { type: Date, default: () => new Date() },
  },
  { versionKey: false },
);

/** Registers (or reuses) a model on a connection. */
function model<T>(connection: Connection, name: string, schema: Schema<T>): Model<T> {
  return (connection.models[name] as Model<T> | undefined) ?? connection.model<T>(name, schema);
}

const toVerificationCode = (doc: VerificationCodeDoc): VerificationCode => {
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
};

/** Mongoose implementation of {@link VerificationCodeRepository}. */
export class MongoVerificationCodeRepository implements VerificationCodeRepository {
  private readonly model: Model<VerificationCodeDoc>;

  constructor(connection: Connection) {
    this.model = model(connection, 'VerificationCode', verificationCodeSchema);
  }

  async replace(data: NewVerificationCode): Promise<VerificationCode> {
    await this.model.deleteMany({ profileId: data.profileId, channel: data.channel });
    const created = await this.model.create({ ...data, attempts: 0, consumedAt: null });
    return toVerificationCode(created.toObject() as VerificationCodeDoc);
  }

  async findActive(profileId: string, channel: VerificationCode['channel']): Promise<VerificationCode | null> {
    const doc = await this.model
      .findOne({ profileId, channel, consumedAt: null, expiresAt: { $gt: new Date() } })
      .lean<VerificationCodeDoc>();
    return doc ? toVerificationCode(doc) : null;
  }

  async incrementAttempts(id: string): Promise<VerificationCode> {
    const doc = await this.model
      .findByIdAndUpdate(id, { $inc: { attempts: 1 } }, { new: true })
      .lean<VerificationCodeDoc>();
    if (!doc) throw new NotFoundError('Verification code not found');
    return toVerificationCode(doc);
  }

  async markConsumed(id: string): Promise<void> {
    await this.model.updateOne({ _id: id }, { $set: { consumedAt: new Date() } });
  }
}

/** Mongoose implementation of {@link AuditLogRepository}. */
export class MongoAuditLogRepository implements AuditLogRepository {
  private readonly model: Model<AuditLogDoc>;

  constructor(connection: Connection) {
    this.model = model(connection, 'AuditLog', auditLogSchema);
  }

  async add(data: Omit<AuditLog, 'id' | 'createdAt'>): Promise<void> {
    await this.model.create(data);
  }
}

/** Mongoose implementation of {@link ServiceStateRepository}. */
export class MongoServiceStateRepository implements ServiceStateRepository {
  private readonly model: Model<ServiceStateDoc>;

  constructor(connection: Connection) {
    this.model = model(connection, 'ServiceState', serviceStateSchema);
  }

  async list(): Promise<ServiceState[]> {
    const docs = await this.model.find().lean<Array<ServiceStateDoc & { _id: unknown }>>();
    return docs.map(({ _id: _ignored, ...state }) => state as ServiceState);
  }

  async upsert(state: Omit<ServiceState, 'updatedAt'>): Promise<ServiceState> {
    const doc = await this.model
      .findOneAndUpdate({ key: state.key }, { $set: { ...state, updatedAt: new Date() } }, { upsert: true, new: true })
      .lean<ServiceStateDoc & { _id: unknown }>();
    const { _id: _ignored, ...saved } = doc as ServiceStateDoc & { _id: unknown };
    return saved as ServiceState;
  }
}
