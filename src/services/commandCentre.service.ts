import type { ServiceState } from '../domain/entities.model';
import { NotFoundError, ServiceUnavailableError } from '../errors/app.errors';
import type { ProviderRegistry } from '../providers/mock/mock.providers';
import type { Clock } from '../rateLimit/rateLimit.types';
import { systemClock } from '../rateLimit/rateLimit.types';
import type { ServiceStateRepository } from '../repositories/interfaces/repositories.interface';

/**
 * Feature keys controlled by the command centre. "platform" is the master switch:
 * when it is off, everything is off.
 */
export const FEATURES = [
  'platform',
  'registration',
  'login',
  'identity-verification',
  'account-creation',
  'transfers.p2p',
  'transfers.external',
  'bills.airtime',
  'bills.data',
  'bills.electricity',
  'bills.education',
  'bills.tv',
  'bills.food',
  'corporate.api-keys',
  'sandbox-funding',
] as const;

export type FeatureKey = (typeof FEATURES)[number];

/** A client-safe view of one switch. */
export interface StateView {
  key: string;
  kind: 'FEATURE' | 'PROVIDER';
  enabled: boolean;
  reason: string | null;
  updatedAt: Date;
}

/** The full set of states returned to authorised clients. */
export interface CommandCentreSnapshot {
  generatedAt: Date;
  features: StateView[];
  providers: Array<StateView & { name: string; category: string }>;
}

/** Namespaced key for a provider switch. */
const providerKey = (id: string): string => `provider:${id}`;

/**
 * The App Command Centre controls the state of every feature and provider.
 * Services never decide on their own whether they may run: they ask the command centre
 * first (`assertFeature`, `assertProvider`) and fail with 503 when switched off.
 *
 * States live in MongoDB and are cached in-process for a short TTL. A change made on one
 * instance is applied immediately there and reaches the others within `cacheTtlMs`.
 */
export class AppCommandCentre {
  private cache: Map<string, ServiceState> | null = null;
  private cacheLoadedAt = 0;

  /**
   * @param {ServiceStateRepository} repository - Persistence for states.
   * @param {ProviderRegistry} providers - Source of provider identifiers to seed.
   * @param {object} [options] - Tuning options.
   * @param {number} [options.cacheTtlMs=5000] - How long a loaded snapshot is trusted.
   * @param {Clock} [options.clock] - Injectable clock for tests.
   */
  constructor(
    private readonly repository: ServiceStateRepository,
    private readonly providers: ProviderRegistry,
    private readonly options: { cacheTtlMs?: number; clock?: Clock } = {},
  ) {}

  private get ttl(): number {
    return this.options.cacheTtlMs ?? 5_000;
  }

  private get clock(): Clock {
    return this.options.clock ?? systemClock;
  }

  /**
   * Ensures every known feature and provider has a state, defaulting new ones to enabled.
   * Existing states are never overwritten, so deployments do not reset operator decisions.
   */
  async initialise(): Promise<void> {
    const existing = new Set((await this.repository.list()).map((state) => state.key));
    const missing: Array<Omit<ServiceState, 'updatedAt'>> = [
      ...FEATURES.filter((key) => !existing.has(key)).map((key) => ({
        key,
        kind: 'FEATURE' as const,
        // Sandbox funding is a testing aid and must be switched on deliberately.
        enabled: key !== 'sandbox-funding',
        reason: null,
        updatedBy: 'system',
      })),
      ...this.providers
        .list()
        .filter((provider) => !existing.has(providerKey(provider.id)))
        .map((provider) => ({
          key: providerKey(provider.id),
          kind: 'PROVIDER' as const,
          enabled: true,
          reason: null,
          updatedBy: 'system',
        })),
    ];
    for (const state of missing) await this.repository.upsert(state);
    this.cache = null;
  }

  private async load(): Promise<Map<string, ServiceState>> {
    const now = this.clock.now();
    if (this.cache && now - this.cacheLoadedAt < this.ttl) return this.cache;
    const states = await this.repository.list();
    this.cache = new Map(states.map((state) => [state.key, state]));
    this.cacheLoadedAt = now;
    return this.cache;
  }

  /**
   * Whether a feature may run. Unknown keys are treated as disabled (fail safe).
   * @param {FeatureKey} feature - The feature key.
   * @returns {Promise<boolean>} True if both the platform and the feature are enabled.
   */
  async isFeatureEnabled(feature: FeatureKey): Promise<boolean> {
    const states = await this.load();
    const platform = states.get('platform')?.enabled ?? false;
    return platform && (states.get(feature)?.enabled ?? false);
  }

  /**
   * Whether a provider may be used.
   * @param {string} providerId - The provider identifier.
   * @returns {Promise<boolean>} True if the platform and the provider are enabled.
   */
  async isProviderEnabled(providerId: string): Promise<boolean> {
    const states = await this.load();
    const platform = states.get('platform')?.enabled ?? false;
    return platform && (states.get(providerKey(providerId))?.enabled ?? false);
  }

  /**
   * @param {FeatureKey} feature - The feature that must be on.
   * @throws {ServiceUnavailableError} If the feature is switched off.
   */
  async assertFeature(feature: FeatureKey): Promise<void> {
    if (!(await this.isFeatureEnabled(feature))) {
      const reason = (await this.load()).get(feature)?.reason;
      throw new ServiceUnavailableError('This service is temporarily unavailable', { feature, ...(reason ? { reason } : {}) });
    }
  }

  /**
   * @param {string} providerId - The provider that must be on.
   * @throws {ServiceUnavailableError} If the provider is switched off.
   */
  async assertProvider(providerId: string): Promise<void> {
    if (!(await this.isProviderEnabled(providerId))) {
      throw new ServiceUnavailableError('The provider for this service is temporarily unavailable', { provider: providerId });
    }
  }

  /**
   * Switches a feature or provider on or off.
   * @param {string} key - A feature key or "provider:<id>".
   * @param {boolean} enabled - The new state.
   * @param {object} meta - Who changed it and why.
   * @param {string} meta.updatedBy - The actor.
   * @param {string | null} [meta.reason] - Optional explanation shown to clients.
   * @returns {Promise<ServiceState>} The saved state.
   * @throws {NotFoundError} If the key is unknown.
   */
  async setState(key: string, enabled: boolean, meta: { updatedBy: string; reason?: string | null }): Promise<ServiceState> {
    const states = await this.load();
    const current = states.get(key);
    if (!current) throw new NotFoundError(`Unknown command-centre key: ${key}`);
    const saved = await this.repository.upsert({
      key,
      kind: current.kind,
      enabled,
      reason: enabled ? null : meta.reason ?? null,
      updatedBy: meta.updatedBy,
    });
    this.cache = null;
    return saved;
  }

  /** @returns {Promise<boolean>} Whether a key is known to the command centre. */
  async hasKey(key: string): Promise<boolean> {
    return (await this.load()).has(key);
  }

  /**
   * Builds the snapshot served by `GET /command-centre/states`.
   * @returns {Promise<CommandCentreSnapshot>} Every feature and provider with its state.
   */
  async snapshot(): Promise<CommandCentreSnapshot> {
    this.cache = null;
    const states = await this.load();
    const view = (state: ServiceState): StateView => ({
      key: state.key,
      kind: state.kind,
      enabled: state.enabled,
      reason: state.reason,
      updatedAt: state.updatedAt,
    });
    const features = [...states.values()].filter((state) => state.kind === 'FEATURE').map(view);
    const providers = this.providers.list().map((provider) => {
      const state = states.get(providerKey(provider.id));
      return {
        key: provider.id,
        kind: 'PROVIDER' as const,
        enabled: state?.enabled ?? false,
        reason: state?.reason ?? null,
        updatedAt: state?.updatedAt ?? new Date(0),
        name: provider.name,
        category: provider.category,
      };
    });
    return { generatedAt: new Date(this.clock.now()), features, providers };
  }
}
