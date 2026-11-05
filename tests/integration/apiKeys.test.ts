import request from 'supertest';
import { balanceOf, bearer, createTestContext, registerCorporate, registerIndividual, type TestContext, type TestUser } from '../helpers/testApp';

const api = '/api/v1';
let ctx: TestContext;
let corp: TestUser;

beforeEach(async () => {
  ctx = await createTestContext();
  corp = await registerCorporate(ctx, { fundKobo: 10_000_000 });
});

const createKey = (ips: string[] = ['41.58.1.9'], name = 'Production') =>
  request(ctx.app).post(`${api}/api-keys`).set(bearer(corp.token)).send({ name, allowedIps: ips });

/** Calls the API as a corporate integration would: with an API key from a given IP. */
const withKey = (key: string, ip = '41.58.1.9') => ({ 'x-api-key': key, 'X-Forwarded-For': ip });

describe('key management', () => {
  it('creates a key, shows the raw value once and never stores it', async () => {
    const res = await createKey(['41.58.1.9', '102.89.0.4']).expect(201);
    const { key, apiKey } = res.body.data;
    expect(key).toMatch(/^sk_live_[0-9a-f]{48}$/);
    expect(apiKey).toMatchObject({ name: 'Production', allowedIps: ['41.58.1.9', '102.89.0.4'], status: 'ACTIVE', prefix: key.slice(0, 12) });

    const stored = [...ctx.repositories.db.apiKeys.values()][0];
    expect(JSON.stringify(stored)).not.toContain(key);
    expect(stored.keyHash).toMatch(/^[0-9a-f]{64}$/);

    const list = await request(ctx.app).get(`${api}/api-keys`).set(bearer(corp.token)).expect(200);
    expect(JSON.stringify(list.body)).not.toContain(key);
    expect(JSON.stringify(list.body)).not.toMatch(/keyHash/);
    expect(list.body.data.apiKeys).toHaveLength(1);
  });

  it('is for corporate profiles only', async () => {
    const person = await registerIndividual(ctx, { person: 0 });
    await request(ctx.app).post(`${api}/api-keys`).set(bearer(person.token)).send({ name: 'x1', allowedIps: ['41.58.1.9'] }).expect(403);
    await request(ctx.app).get(`${api}/api-keys`).set(bearer(person.token)).expect(403);
  });

  it('requires a valid, non-empty allowlist', async () => {
    await createKey([]).expect(400);
    await createKey(['not-an-ip']).expect(400);
    await createKey(['41.58.1.0/24']).expect(400);
    const res = await createKey(['41.58.1.9', '999.1.1.1']).expect(400);
    expect(res.body.data).toEqual({ invalid: ['999.1.1.1'] });
  });

  it('supports IPv6 allowlisting', async () => {
    const res = await createKey(['2001:db8::1']).expect(201);
    await request(ctx.app).get(`${api}/accounts`).set(withKey(res.body.data.key, '2001:db8::1')).expect(200);
  });

  it('limits the number of active keys', async () => {
    for (let i = 0; i < 10; i += 1) await createKey(['41.58.1.9'], `Key ${i + 10}`).expect(201);
    await createKey(['41.58.1.9'], 'One too many').expect(400);
  });

  it('is blocked by the command centre', async () => {
    await ctx.container.commandCentre.setState('corporate.api-keys', false, { updatedBy: 'ops' });
    await createKey().expect(503);
  });

  it('cannot be managed with an API key, only with a signed-in session', async () => {
    const { key } = (await createKey().expect(201)).body.data;
    await request(ctx.app).get(`${api}/api-keys`).set(withKey(key)).expect(403);
    await request(ctx.app).post(`${api}/api-keys`).set(withKey(key)).send({ name: 'sneaky', allowedIps: ['1.1.1.1'] }).expect(403);
  });
});

describe('authenticating with a key', () => {
  it('accepts a request from an allowlisted IP', async () => {
    const { key } = (await createKey(['41.58.1.9']).expect(201)).body.data;
    const res = await request(ctx.app).get(`${api}/accounts`).set(withKey(key, '41.58.1.9')).expect(200);
    expect(res.body.data.accounts).toHaveLength(1);
  });

  it('rejects any other IP with 403 and says which address was seen', async () => {
    const { key } = (await createKey(['41.58.1.9']).expect(201)).body.data;
    const res = await request(ctx.app).get(`${api}/accounts`).set(withKey(key, '10.20.30.40')).expect(403);
    expect(res.body).toMatchObject({ success: false, data: { ip: '10.20.30.40' } });
  });

  it('rejects unknown keys', async () => {
    await request(ctx.app).get(`${api}/accounts`).set(withKey('sk_live_' + 'a'.repeat(48))).expect(401);
  });

  it('lets the owner change the allowlist without issuing a new key', async () => {
    const created = (await createKey(['41.58.1.9']).expect(201)).body.data;
    await request(ctx.app).get(`${api}/accounts`).set(withKey(created.key, '102.89.0.4')).expect(403);

    await request(ctx.app)
      .patch(`${api}/api-keys/${created.apiKey.id}/allowlist`)
      .set(bearer(corp.token))
      .send({ allowedIps: ['102.89.0.4'] })
      .expect(200);

    await request(ctx.app).get(`${api}/accounts`).set(withKey(created.key, '102.89.0.4')).expect(200);
    await request(ctx.app).get(`${api}/accounts`).set(withKey(created.key, '41.58.1.9')).expect(403);
  });

  it('stops working once revoked, and stays revoked', async () => {
    const created = (await createKey().expect(201)).body.data;
    await request(ctx.app).get(`${api}/accounts`).set(withKey(created.key)).expect(200);

    const revoked = await request(ctx.app).delete(`${api}/api-keys/${created.apiKey.id}`).set(bearer(corp.token)).expect(200);
    expect(revoked.body.data.apiKey).toMatchObject({ status: 'REVOKED', revokedAt: expect.any(String) });
    await request(ctx.app).get(`${api}/accounts`).set(withKey(created.key)).expect(401);
    await request(ctx.app).patch(`${api}/api-keys/${created.apiKey.id}/allowlist`).set(bearer(corp.token)).send({ allowedIps: ['1.1.1.1'] }).expect(400);
  });

  it("will not let one profile touch another's keys", async () => {
    const created = (await createKey().expect(201)).body.data;
    const other = await registerCorporate(ctx, { person: 1 });
    await request(ctx.app).delete(`${api}/api-keys/${created.apiKey.id}`).set(bearer(other.token)).expect(404);
    await request(ctx.app).patch(`${api}/api-keys/${created.apiKey.id}/allowlist`).set(bearer(other.token)).send({ allowedIps: ['1.1.1.1'] }).expect(404);
  });

  it('rejects keys of suspended profiles', async () => {
    const { key } = (await createKey().expect(201)).body.data;
    await ctx.repositories.profiles.update(corp.profileId, { status: 'SUSPENDED' });
    await request(ctx.app).get(`${api}/accounts`).set(withKey(key)).expect(403);
  });

  it('records when a key was last used', async () => {
    const created = (await createKey().expect(201)).body.data;
    expect(created.apiKey.lastUsedAt).toBeNull();
    await request(ctx.app).get(`${api}/accounts`).set(withKey(created.key)).expect(200);
    const list = await request(ctx.app).get(`${api}/api-keys`).set(bearer(corp.token)).expect(200);
    expect(list.body.data.apiKeys[0].lastUsedAt).not.toBeNull();
  });
});

describe('corporate integrations end to end', () => {
  it('buys airtime with an API key and gets the 2.5% corporate discount', async () => {
    const { key } = (await createKey().expect(201)).body.data;
    const res = await request(ctx.app)
      .post(`${api}/bills/airtime`)
      .set(withKey(key))
      .set('Idempotency-Key', 'corp-order-0001')
      .send({ fromAccountId: corp.accountId, network: 'MTN', phone: '08031234567', amount: 100_000 })
      .expect(202);
    expect(res.body.data.transaction.discount.kobo).toBe(2_500);
    await ctx.drain();
    expect(await balanceOf(ctx, corp.accountId)).toBe(10_000_000 - 97_500);
  });

  it('rate limits per key rather than per IP', async () => {
    const tight = await createTestContext({ limits: { standard: { limit: 12, burst: 12, windowSeconds: 6000 } } });
    const owner = await registerCorporate(tight);
    const a = (await request(tight.app).post(`${api}/api-keys`).set(bearer(owner.token)).send({ name: 'Key A', allowedIps: ['41.58.1.9'] }).expect(201)).body.data.key;
    const b = (await request(tight.app).post(`${api}/api-keys`).set(bearer(owner.token)).send({ name: 'Key B', allowedIps: ['41.58.1.9'] }).expect(201)).body.data.key;

    const statuses: number[] = [];
    for (let i = 0; i < 14; i += 1) statuses.push((await request(tight.app).get(`${api}/accounts`).set(withKey(a))).status);
    expect(statuses).toEqual([...Array(12).fill(200), 429, 429]);
    await request(tight.app).get(`${api}/accounts`).set(withKey(b)).expect(200); // the other key is unaffected
  });
});
