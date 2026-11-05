import request from 'supertest';
import { bearer, createTestContext, registerIndividual, SERVICE_TOKEN, type TestContext } from '../helpers/testApp';

const api = '/api/v1';
let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

const service = { 'x-service-token': SERVICE_TOKEN };

describe('GET /command-centre/states', () => {
  it('rejects unauthenticated callers and wrong service tokens', async () => {
    await request(ctx.app).get(`${api}/command-centre/states`).expect(401);
    await request(ctx.app).get(`${api}/command-centre/states`).set('x-service-token', 'wrong-token-value').expect(401);
  });

  it('serves every feature and provider state to an authorised service client', async () => {
    const res = await request(ctx.app).get(`${api}/command-centre/states`).set(service).expect(200);
    expect(res.body.success).toBe(true);
    const { features, providers, generatedAt } = res.body.data;
    expect(new Date(generatedAt).getTime()).not.toBeNaN();
    expect(features.map((f: { key: string }) => f.key)).toEqual(expect.arrayContaining(['platform', 'transfers.p2p', 'bills.tv', 'corporate.api-keys']));
    expect(providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'mock-tv-dstv', category: 'TV', enabled: true }),
        expect.objectContaining({ key: 'mock-nip-transfer', category: 'TRANSFER', enabled: true }),
      ]),
    );
  });

  it('also serves signed-in profiles', async () => {
    const user = await registerIndividual(ctx);
    await request(ctx.app).get(`${api}/command-centre/states`).set(bearer(user.token)).expect(200);
  });

  it('reflects changes immediately', async () => {
    await request(ctx.app).patch(`${api}/command-centre/states/bills.tv`).set(service).send({ enabled: false, reason: 'Maintenance' }).expect(200);
    const res = await request(ctx.app).get(`${api}/command-centre/states`).set(service).expect(200);
    expect(res.body.data.features.find((f: { key: string }) => f.key === 'bills.tv')).toMatchObject({ enabled: false, reason: 'Maintenance' });
  });
});

describe('PATCH /command-centre/states/:key', () => {
  it('needs the service token (a user token is not enough)', async () => {
    const user = await registerIndividual(ctx);
    await request(ctx.app).patch(`${api}/command-centre/states/bills.tv`).send({ enabled: false }).expect(401);
    await request(ctx.app).patch(`${api}/command-centre/states/bills.tv`).set(bearer(user.token)).send({ enabled: false }).expect(401);
  });

  it('switches a provider by its identifier', async () => {
    const res = await request(ctx.app).patch(`${api}/command-centre/states/mock-tv-dstv`).set(service).send({ enabled: false, reason: 'Down' }).expect(200);
    expect(res.body.data).toMatchObject({ key: 'provider:mock-tv-dstv', enabled: false, reason: 'Down' });
    const user = await registerIndividual(ctx, { fundKobo: 10_000_000 });
    await request(ctx.app)
      .post(`${api}/bills/tv/validate`)
      .set(bearer(user.token))
      .send({ operator: 'DSTV', iuc: '7012345678' })
      .expect(503);
  });

  it('can bring everything down and back up with the platform switch', async () => {
    const user = await registerIndividual(ctx);
    await request(ctx.app).patch(`${api}/command-centre/states/platform`).set(service).send({ enabled: false }).expect(200);
    await request(ctx.app).post(`${api}/auth/login`).send({ email: user.email, password: 'Password123' }).expect(503);
    await request(ctx.app).patch(`${api}/command-centre/states/platform`).set(service).send({ enabled: true }).expect(200);
    await request(ctx.app).post(`${api}/auth/login`).send({ email: user.email, password: 'Password123' }).expect(200);
  });

  it('404s on unknown keys and validates the body', async () => {
    await request(ctx.app).patch(`${api}/command-centre/states/nonsense`).set(service).send({ enabled: false }).expect(404);
    await request(ctx.app).patch(`${api}/command-centre/states/bills.tv`).set(service).send({ enabled: 'no' }).expect(400);
    await request(ctx.app).patch(`${api}/command-centre/states/bills.tv`).set(service).send({}).expect(400);
  });

  it('writes an audit log entry for every change', async () => {
    await request(ctx.app).patch(`${api}/command-centre/states/bills.food`).set(service).send({ enabled: false, reason: 'Closed' }).expect(200);
    const logs = [...ctx.repositories.db.auditLogs.values()].filter((l) => l.action === 'commandCentre.stateChanged');
    expect(logs).toHaveLength(1);
    expect(logs[0].metadata).toMatchObject({ key: 'bills.food', enabled: false, reason: 'Closed' });
  });
});
