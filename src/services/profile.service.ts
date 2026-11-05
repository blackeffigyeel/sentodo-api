import type { Profile } from '../domain/entities.model';
import { COST_SCHEDULE } from '../domain/pricing.rules';
import { BadRequestError, NotFoundError } from '../errors/app.errors';
import type { IdentityProvider } from '../providers/provider.types';
import type { Repositories } from '../repositories/interfaces/repositories.interface';
import { sha256 } from '../utils/crypto.util';
import type { AppCommandCentre } from './commandCentre.service';

/** Reads profiles and verifies identity against the (mock) BVN registry. */
export class ProfileService {
  constructor(
    private readonly repositories: Repositories,
    private readonly identity: IdentityProvider,
    private readonly commandCentre: AppCommandCentre,
  ) {}

  /**
   * @param {string} profileId - The profile id.
   * @returns {Promise<Profile>} The profile.
   * @throws {NotFoundError} If it does not exist.
   */
  async get(profileId: string): Promise<Profile> {
    const profile = await this.repositories.profiles.findById(profileId);
    if (!profile) throw new NotFoundError('Profile not found');
    return profile;
  }

  /**
   * Verifies the profile's identity with a BVN from the provider's records. The registry name
   * must match the profile's name, and one BVN can back only one profile. The cost of the check
   * is recorded for every attempt that reaches the provider.
   * @param {string} profileId - The profile to verify.
   * @param {string} bvn - The 11-digit BVN.
   * @returns {Promise<Profile>} The verified profile.
   */
  async verifyIdentity(profileId: string, bvn: string): Promise<Profile> {
    await this.commandCentre.assertFeature('identity-verification');
    await this.commandCentre.assertProvider(this.identity.id);
    const profile = await this.get(profileId);
    if (profile.identityVerifiedAt) return profile;

    const record = await this.identity.lookupBvn(bvn);
    await this.repositories.costs.add({
      type: 'IDENTITY_VERIFICATION',
      amount: COST_SCHEDULE.IDENTITY_VERIFICATION,
      profileId,
      note: record ? 'BVN found' : 'BVN not found',
    });
    if (!record) throw new BadRequestError('We could not verify this BVN');

    if (profile.type === 'INDIVIDUAL') {
      const same = (a: string | null, b: string): boolean => (a ?? '').trim().toLowerCase() === b.trim().toLowerCase();
      if (!same(profile.firstName, record.firstName) || !same(profile.lastName, record.lastName)) {
        throw new BadRequestError('The BVN details do not match this profile');
      }
    }
    return this.repositories.profiles.update(profileId, { identityVerifiedAt: new Date(), bvnHash: sha256(bvn) });
  }
}
