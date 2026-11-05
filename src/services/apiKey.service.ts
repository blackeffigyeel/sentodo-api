import { isIP } from 'net';
import type { ApiKey, Profile } from '../domain/entities.model';
import { BadRequestError, ForbiddenError, NotFoundError, UnauthorisedError } from '../errors/app.errors';
import type { Repositories } from '../repositories/interfaces/repositories.interface';
import { generateApiKey, sha256 } from '../utils/crypto.util';
import type { AppCommandCentre } from './commandCentre.service';

/** The most active API keys one corporate profile may hold. */
export const MAX_ACTIVE_API_KEYS = 10;

/** How often `lastUsedAt` is refreshed, to avoid a write on every request. */
const LAST_USED_REFRESH_MS = 60_000;

/**
 * Normalises a client address: strips the IPv4-mapped IPv6 prefix and lower-cases IPv6.
 * @param {string} ip - The raw address, e.g. "::ffff:41.58.1.9".
 * @returns {string} The normalised address.
 */
export function normaliseIp(ip: string): string {
  const trimmed = ip.trim().toLowerCase();
  return trimmed.startsWith('::ffff:') && isIP(trimmed.slice(7)) === 4 ? trimmed.slice(7) : trimmed;
}

/**
 * Validates and de-duplicates an IP allowlist. Every entry must be a literal IPv4 or IPv6 address.
 * @param {string[]} ips - The submitted addresses.
 * @returns {string[]} The normalised unique list.
 * @throws {BadRequestError} If the list is empty or contains an invalid address.
 */
export function validateAllowlist(ips: string[]): string[] {
  const normalised = [...new Set(ips.map(normaliseIp))];
  if (normalised.length === 0) throw new BadRequestError('At least one allowed IP address is required');
  const bad = normalised.filter((ip) => isIP(ip) === 0);
  if (bad.length > 0) throw new BadRequestError('Some IP addresses are invalid', { invalid: bad });
  return normalised;
}

/** Corporate API keys with IP allowlisting. Raw keys are shown once; only hashes are stored. */
export class ApiKeyService {
  constructor(private readonly repositories: Repositories, private readonly commandCentre: AppCommandCentre) {}

  private assertCorporate(profile: Profile): void {
    if (profile.type !== 'CORPORATE') throw new ForbiddenError('API keys are available to corporate profiles only');
  }

  /**
   * Creates a key.
   * @param {Profile} profile - The corporate profile.
   * @param {string} name - A label for the key.
   * @param {string[]} allowedIps - Addresses that may use the key.
   * @returns {Promise<{ apiKey: ApiKey; rawKey: string }>} The stored key and the one-time raw value.
   */
  async create(profile: Profile, name: string, allowedIps: string[]): Promise<{ apiKey: ApiKey; rawKey: string }> {
    await this.commandCentre.assertFeature('corporate.api-keys');
    this.assertCorporate(profile);
    const ips = validateAllowlist(allowedIps);
    const existing = await this.repositories.apiKeys.listByProfile(profile.id);
    if (existing.filter((key) => key.status === 'ACTIVE').length >= MAX_ACTIVE_API_KEYS) {
      throw new BadRequestError(`You can have at most ${MAX_ACTIVE_API_KEYS} active API keys`);
    }
    const generated = generateApiKey();
    const apiKey = await this.repositories.apiKeys.create({
      profileId: profile.id,
      name,
      prefix: generated.prefix,
      keyHash: generated.hash,
      allowedIps: ips,
    });
    await this.repositories.auditLogs.add({ action: 'apiKey.created', actorId: profile.id, ip: null, metadata: { apiKeyId: apiKey.id } });
    return { apiKey, rawKey: generated.key };
  }

  /** @returns {Promise<ApiKey[]>} The profile's keys. */
  async list(profile: Profile): Promise<ApiKey[]> {
    this.assertCorporate(profile);
    return this.repositories.apiKeys.listByProfile(profile.id);
  }

  private async getOwned(profile: Profile, keyId: string): Promise<ApiKey> {
    const key = await this.repositories.apiKeys.findById(keyId);
    if (!key || key.profileId !== profile.id) throw new NotFoundError('API key not found');
    return key;
  }

  /**
   * Replaces a key's IP allowlist.
   * @param {Profile} profile - The owner.
   * @param {string} keyId - The key id.
   * @param {string[]} allowedIps - The new allowlist.
   * @returns {Promise<ApiKey>} The updated key.
   */
  async updateAllowlist(profile: Profile, keyId: string, allowedIps: string[]): Promise<ApiKey> {
    this.assertCorporate(profile);
    const key = await this.getOwned(profile, keyId);
    if (key.status === 'REVOKED') throw new BadRequestError('A revoked key cannot be changed');
    return this.repositories.apiKeys.update(key.id, { allowedIps: validateAllowlist(allowedIps) });
  }

  /**
   * Revokes a key permanently.
   * @param {Profile} profile - The owner.
   * @param {string} keyId - The key id.
   * @returns {Promise<ApiKey>} The revoked key.
   */
  async revoke(profile: Profile, keyId: string): Promise<ApiKey> {
    this.assertCorporate(profile);
    const key = await this.getOwned(profile, keyId);
    if (key.status === 'REVOKED') return key;
    await this.repositories.auditLogs.add({ action: 'apiKey.revoked', actorId: profile.id, ip: null, metadata: { apiKeyId: key.id } });
    return this.repositories.apiKeys.update(key.id, { status: 'REVOKED', revokedAt: new Date() });
  }

  /**
   * Authenticates a request made with an API key.
   * @param {string} rawKey - The key from the `x-api-key` header.
   * @param {string} clientIp - The caller's address.
   * @returns {Promise<{ profile: Profile; apiKey: ApiKey }>} The owning profile and key.
   * @throws {UnauthorisedError} If the key is unknown or revoked.
   * @throws {ForbiddenError} If the caller's IP is not on the allowlist or the profile is inactive.
   */
  async authenticate(rawKey: string, clientIp: string): Promise<{ profile: Profile; apiKey: ApiKey }> {
    const apiKey = await this.repositories.apiKeys.findByHash(sha256(rawKey));
    if (!apiKey || apiKey.status !== 'ACTIVE') throw new UnauthorisedError('Invalid API key');

    const ip = normaliseIp(clientIp);
    if (!apiKey.allowedIps.includes(ip)) {
      throw new ForbiddenError('This IP address is not allowed to use this API key', { ip });
    }
    const profile = await this.repositories.profiles.findById(apiKey.profileId);
    if (!profile || profile.status !== 'ACTIVE') throw new ForbiddenError('This profile is not active');

    if (!apiKey.lastUsedAt || Date.now() - apiKey.lastUsedAt.getTime() > LAST_USED_REFRESH_MS) {
      await this.repositories.apiKeys.update(apiKey.id, { lastUsedAt: new Date() });
    }
    return { profile, apiKey };
  }
}
