import { NotFoundError, ServiceUnavailableError } from '../../src/errors/app.errors';
import { createMockProviderRegistry } from '../../src/providers/mock/mock.providers';
import { createMemoryRepositories } from '../../src/repositories/memory/memory.repositories';
import { AppCommandCentre, FEATURES } from '../../src/services/commandCentre.service';

async function setup() {
  const repositories = createMemoryRepositories();
  const providers = createMockProviderRegistry({ mockPhoneCodes: ['123456'] });
  const centre = new AppCommandCentre(repositories.serviceStates, providers, { cacheTtlMs: 0 });
  await centre.initialise();
  return { centre, providers, repositories };
}

describe('AppCommandCentre', () => {
  it('seeds every feature and provider, with sandbox funding off by default', async () => {
    const { centre, providers } = await setup();
    const snapshot = await centre.snapshot();
    expect(snapshot.features.map((f) => f.key).sort()).toEqual([...FEATURES].sort());
    expect(snapshot.providers).toHaveLength(providers.list().length);
    expect(snapshot.features.find((f) => f.key === 'sandbox-funding')?.enabled).toBe(false);
    expect(snapshot.features.find((f) => f.key === 'transfers.p2p')?.enabled).toBe(true);
  });

  it('gives every provider a stable identifier', async () => {
    const { providers } = await setup();
    const ids = providers.list().map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(['mock-tv-dstv', 'mock-tv-gotv', 'mock-airtime-mtn', 'mock-nip-transfer', 'mock-identity-bvn', 'mock-sms']));
  });

  it('blocks a switched-off feature with 503 and the reason', async () => {
    const { centre } = await setup();
    await centre.setState('bills.tv', false, { updatedBy: 'ops', reason: 'Provider maintenance' });
    await expect(centre.assertFeature('bills.tv')).rejects.toThrow(ServiceUnavailableError);
    await expect(centre.assertFeature('bills.tv')).rejects.toMatchObject({
      statusCode: 503,
      additionalData: { feature: 'bills.tv', reason: 'Provider maintenance' },
    });
    await expect(centre.assertFeature('bills.data')).resolves.toBeUndefined();
  });

  it('blocks a switched-off provider', async () => {
    const { centre } = await setup();
    await centre.setState('provider:mock-tv-dstv', false, { updatedBy: 'ops' });
    await expect(centre.assertProvider('mock-tv-dstv')).rejects.toMatchObject({ additionalData: { provider: 'mock-tv-dstv' } });
    await expect(centre.assertProvider('mock-tv-gotv')).resolves.toBeUndefined();
  });

  it('uses "platform" as a master switch over everything', async () => {
    const { centre } = await setup();
    await centre.setState('platform', false, { updatedBy: 'ops' });
    expect(await centre.isFeatureEnabled('login')).toBe(false);
    expect(await centre.isProviderEnabled('mock-sms')).toBe(false);
    await centre.setState('platform', true, { updatedBy: 'ops' });
    expect(await centre.isFeatureEnabled('login')).toBe(true);
  });

  it('clears the reason when something is switched back on', async () => {
    const { centre } = await setup();
    await centre.setState('bills.food', false, { updatedBy: 'ops', reason: 'Closed' });
    const on = await centre.setState('bills.food', true, { updatedBy: 'ops', reason: 'ignored' });
    expect(on.reason).toBeNull();
  });

  it('rejects unknown keys', async () => {
    const { centre } = await setup();
    await expect(centre.setState('nope', true, { updatedBy: 'ops' })).rejects.toThrow(NotFoundError);
  });

  it('treats unknown features as disabled (fail safe)', async () => {
    const { centre } = await setup();
    expect(await centre.isFeatureEnabled('not-a-feature' as never)).toBe(false);
  });

  it('does not overwrite operator decisions when initialised again', async () => {
    const { centre } = await setup();
    await centre.setState('bills.tv', false, { updatedBy: 'ops' });
    await centre.initialise();
    expect(await centre.isFeatureEnabled('bills.tv')).toBe(false);
  });

  it('caches states for the configured TTL', async () => {
    const repositories = createMemoryRepositories();
    const providers = createMockProviderRegistry({ mockPhoneCodes: [] });
    let now = 0;
    const centre = new AppCommandCentre(repositories.serviceStates, providers, { cacheTtlMs: 1_000, clock: { now: () => now } });
    await centre.initialise();
    expect(await centre.isFeatureEnabled('login')).toBe(true);
    // Change behind the cache's back (as another instance would).
    await repositories.serviceStates.upsert({ key: 'login', kind: 'FEATURE', enabled: false, reason: null, updatedBy: 'other' });
    expect(await centre.isFeatureEnabled('login')).toBe(true);
    now = 1_500;
    expect(await centre.isFeatureEnabled('login')).toBe(false);
  });
});
