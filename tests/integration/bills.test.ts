import request from 'supertest';
import { MOCK_TV_CUSTOMERS } from '../../src/data/catalogue.data';
import { balanceOf, bearer, createTestContext, registerCorporate, registerIndividual, type TestContext, type TestUser } from '../helpers/testApp';

const api = '/api/v1';
let ctx: TestContext;
let user: TestUser;

beforeEach(async () => {
  ctx = await createTestContext();
  user = await registerIndividual(ctx, { person: 0, fundKobo: 10_000_000 });
});

const buy = (path: string, body: Record<string, unknown>, who: TestUser = user, key?: string) => {
  const call = request(ctx.app).post(`${api}/bills/${path}`).set(bearer(who.token));
  if (key) call.set('Idempotency-Key', key);
  return call.send({ fromAccountId: who.accountId, ...body });
};

const getTx = async (id: string, who: TestUser = user) =>
  (await request(ctx.app).get(`${api}/transactions/${id}`).set(bearer(who.token)).expect(200)).body.data.transaction;

describe('catalogue', () => {
  it.each(['airtime', 'data', 'electricity', 'education', 'tv', 'food'])('serves the %s catalogue with integer prices', async (category) => {
    const res = await request(ctx.app).get(`${api}/bills/catalogue/${category}`).set(bearer(user.token)).expect(200);
    expect(res.body.success).toBe(true);
    expect(JSON.stringify(res.body.data)).toMatch(/"kobo":\d+/);
  });

  it('filters data plans by network and TV bouquets by operator', async () => {
    const data = await request(ctx.app).get(`${api}/bills/catalogue/data?network=GLO`).set(bearer(user.token)).expect(200);
    expect(data.body.data.plans.every((p: { network: string }) => p.network === 'GLO')).toBe(true);
    const tv = await request(ctx.app).get(`${api}/bills/catalogue/tv?operator=GOTV`).set(bearer(user.token)).expect(200);
    expect(tv.body.data.bouquets.every((b: { operator: string }) => b.operator === 'GOTV')).toBe(true);
  });

  it('requires authentication', async () => {
    await request(ctx.app).get(`${api}/bills/catalogue/data`).expect(401);
  });
});

describe('airtime', () => {
  it('applies the 1% individual discount, returns 202 and fulfils from the queue', async () => {
    const res = await buy('airtime', { network: 'MTN', phone: '08031234567', amount: 50_000 }).expect(202);
    const tx = res.body.data.transaction;
    expect(tx).toMatchObject({ type: 'AIRTIME', status: 'PROCESSING', provider: 'mock-airtime-mtn' });
    expect(tx.amount.kobo).toBe(50_000);
    expect(tx.discount.kobo).toBe(500);
    expect(tx.totalDebit.kobo).toBe(49_500);
    expect(await balanceOf(ctx, user.accountId)).toBe(10_000_000 - 49_500);

    await ctx.drain();
    const done = await getTx(tx.id);
    expect(done.status).toBe('SUCCESS');
    expect(done.providerReference).toMatch(/^MOCK-AIRTIME-MTN-\d{10}$/);
  });

  it('gives corporate profiles the 2.5% discount', async () => {
    const corp = await registerCorporate(ctx, { fundKobo: 10_000_000 });
    const res = await buy('airtime', { network: 'AIRTEL', phone: '08021234567', amount: 50_000 }, corp).expect(202);
    expect(res.body.data.transaction.discount.kobo).toBe(1_250);
    expect(res.body.data.transaction.totalDebit.kobo).toBe(48_750);
  });

  it('accepts +234 numbers and rejects invalid ones', async () => {
    await buy('airtime', { network: 'MTN', phone: '+2348031234567', amount: 10_000 }).expect(202);
    await buy('airtime', { network: 'MTN', phone: '1234', amount: 10_000 }).expect(400);
    await buy('airtime', { network: 'VODAFONE', phone: '08031234567', amount: 10_000 }).expect(400);
  });

  it('enforces limits and integer amounts', async () => {
    await buy('airtime', { network: 'MTN', phone: '08031234567', amount: 1_000 }).expect(400);
    await buy('airtime', { network: 'MTN', phone: '08031234567', amount: 6_000_000 }).expect(400);
    await buy('airtime', { network: 'MTN', phone: '08031234567', amount: 500.5 }).expect(400);
  });

  it('refunds in full when the provider declines', async () => {
    const res = await buy('airtime', { network: 'MTN', phone: '08030000000', amount: 100_000 }).expect(202);
    await ctx.drain();
    expect((await getTx(res.body.data.transaction.id)).status).toBe('FAILED');
    expect(await balanceOf(ctx, user.accountId)).toBe(10_000_000);
  });

  it('rejects insufficient funds', async () => {
    const poor = await registerIndividual(ctx, { person: 1, fundKobo: 10_000 });
    await buy('airtime', { network: 'MTN', phone: '08031234567', amount: 50_000 }, poor).expect(422);
    expect(await balanceOf(ctx, poor.accountId)).toBe(10_000);
  });

  it('requires identity verification', async () => {
    const unverified = await registerIndividual(ctx, { person: 1, verifyIdentity: false, fundKobo: 100_000 });
    await buy('airtime', { network: 'MTN', phone: '08031234567', amount: 10_000 }, unverified).expect(403);
  });

  it('is idempotent with an Idempotency-Key', async () => {
    const a = await buy('airtime', { network: 'MTN', phone: '08031234567', amount: 50_000 }, user, 'airtime-key-1').expect(202);
    const b = await buy('airtime', { network: 'MTN', phone: '08031234567', amount: 50_000 }, user, 'airtime-key-1').expect(202);
    expect(b.body.data.transaction.id).toBe(a.body.data.transaction.id);
    expect(await balanceOf(ctx, user.accountId)).toBe(10_000_000 - 49_500);
  });
});

describe('data', () => {
  it('charges the catalogue price and ignores any client-supplied amount', async () => {
    const res = await buy('data', { planCode: 'mtn-1.5gb-30days', phone: '08031234567', amount: 1 }).expect(202);
    expect(res.body.data.transaction.amount.kobo).toBe(100_000);
    expect(res.body.data.transaction.discount.kobo).toBe(1_000);
    await ctx.drain();
    expect((await getTx(res.body.data.transaction.id)).details).toMatchObject({ plan: '1.5GB (30 days)', network: 'MTN' });
  });

  it('rejects unknown plans', async () => {
    await buy('data', { planCode: 'nope', phone: '08031234567' }).expect(404);
    expect(await balanceOf(ctx, user.accountId)).toBe(10_000_000);
  });
});

describe('electricity', () => {
  it('returns a meter token once fulfilled', async () => {
    const res = await buy('electricity', { disco: 'IKEDC', meterNumber: '12345678901', meterType: 'PREPAID', amount: 200_000 }).expect(202);
    await ctx.drain();
    const done = await getTx(res.body.data.transaction.id);
    expect(done.status).toBe('SUCCESS');
    expect(done.details.token).toMatch(/^\d{4}(-\d{4}){4}$/);
  });

  it.each([
    ['a short meter number', { meterNumber: '12345' }],
    ['an unknown distributor', { disco: 'NOPE' }],
    ['an unknown meter type', { meterType: 'HYBRID' }],
  ])('rejects %s', async (_label, overrides) => {
    await buy('electricity', { disco: 'IKEDC', meterNumber: '12345678901', meterType: 'PREPAID', amount: 200_000, ...overrides }).expect(400);
  });

  it('enforces the purchase limits', async () => {
    await buy('electricity', { disco: 'IKEDC', meterNumber: '12345678901', meterType: 'PREPAID', amount: 10_000 }).expect(400);
  });
});

describe('education', () => {
  it('sells a PIN at the catalogue price', async () => {
    const res = await buy('education', { productCode: 'WAEC_RESULT', phone: '08031234567' }).expect(202);
    expect(res.body.data.transaction.amount.kobo).toBe(350_000);
    await ctx.drain();
    expect((await getTx(res.body.data.transaction.id)).details.token).toMatch(/^\d{12}$/);
  });

  it('rejects unknown products', async () => {
    await buy('education', { productCode: 'GCSE', phone: '08031234567' }).expect(404);
  });
});

describe('TV (the only category with customer validation)', () => {
  const dstv = MOCK_TV_CUSTOMERS.DSTV[0];
  const gotv = MOCK_TV_CUSTOMERS.GOTV[0];

  it('validates a DStv smart card and shows the customer name', async () => {
    const res = await request(ctx.app).post(`${api}/bills/tv/validate`).set(bearer(user.token)).send({ operator: 'DSTV', iuc: dstv.iuc }).expect(200);
    expect(res.body.data).toEqual({ operator: 'DSTV', iuc: dstv.iuc, customerName: dstv.name });
  });

  it('validates a GOtv smart card', async () => {
    const res = await request(ctx.app).post(`${api}/bills/tv/validate`).set(bearer(user.token)).send({ operator: 'GOTV', iuc: gotv.iuc }).expect(200);
    expect(res.body.data.customerName).toBe(gotv.name);
  });

  it('reports unknown cards as 404 and malformed IUC numbers as 400 (must be exactly 10 digits)', async () => {
    await request(ctx.app).post(`${api}/bills/tv/validate`).set(bearer(user.token)).send({ operator: 'DSTV', iuc: '9999999999' }).expect(404);
    await request(ctx.app).post(`${api}/bills/tv/validate`).set(bearer(user.token)).send({ operator: 'DSTV', iuc: '701234567' }).expect(400);
    await request(ctx.app).post(`${api}/bills/tv/validate`).set(bearer(user.token)).send({ operator: 'DSTV', iuc: '70123456789' }).expect(400);
  });

  it('has no validation endpoint for other categories', async () => {
    await request(ctx.app).post(`${api}/bills/airtime/validate`).set(bearer(user.token)).send({}).expect(404);
    await request(ctx.app).post(`${api}/bills/electricity/validate`).set(bearer(user.token)).send({}).expect(404);
  });

  it('subscribes a validated card at the bouquet price', async () => {
    const res = await buy('tv', { operator: 'DSTV', iuc: dstv.iuc, bouquetCode: 'dstv-compact' }).expect(202);
    expect(res.body.data.transaction.amount.kobo).toBe(1_900_000);
    await ctx.drain();
    expect((await getTx(res.body.data.transaction.id)).status).toBe('SUCCESS');
  });

  it('will not charge an unrecognised card, or a bouquet from the other operator', async () => {
    await buy('tv', { operator: 'DSTV', iuc: '9999999999', bouquetCode: 'dstv-padi' }).expect(404);
    await buy('tv', { operator: 'DSTV', iuc: dstv.iuc, bouquetCode: 'gotv-max' }).expect(404);
    expect(await balanceOf(ctx, user.accountId)).toBe(10_000_000);
  });
});

describe('food', () => {
  it('totals items plus delivery and applies the discount', async () => {
    const res = await buy('food', {
      restaurantCode: 'mama-put',
      items: [{ code: 'jollof-chicken', quantity: 2 }],
      deliveryPhone: '08031234567',
    }).expect(202);
    const tx = res.body.data.transaction;
    expect(tx.amount.kobo).toBe(2 * 350_000 + 80_000);
    expect(tx.discount.kobo).toBe(7_800);
    expect(tx.totalDebit.kobo).toBe(772_200);
    await ctx.drain();
    expect((await getTx(tx.id)).details).toMatchObject({ token: expect.stringMatching(/^ORD-\d{6}$/), restaurant: 'Mama Put Kitchen' });
  });

  it('rejects unknown restaurants, items from another menu and empty orders', async () => {
    await buy('food', { restaurantCode: 'nope', items: [{ code: 'x1', quantity: 1 }], deliveryPhone: '08031234567' }).expect(404);
    await buy('food', { restaurantCode: 'mama-put', items: [{ code: 'grilled-fish', quantity: 1 }], deliveryPhone: '08031234567' }).expect(404);
    await buy('food', { restaurantCode: 'mama-put', items: [], deliveryPhone: '08031234567' }).expect(400);
    await buy('food', { restaurantCode: 'mama-put', items: [{ code: 'jollof-chicken', quantity: 0 }], deliveryPhone: '08031234567' }).expect(400);
  });
});

describe('quotes', () => {
  it('prices any category without charging', async () => {
    const res = await request(ctx.app)
      .post(`${api}/bills/quote`)
      .set(bearer(user.token))
      .send({ category: 'DATA', fromAccountId: user.accountId, planCode: 'airtel-3gb-30days', phone: '08021234567' })
      .expect(200);
    expect(res.body.data).toMatchObject({ amount: { kobo: 150_000 }, discount: { kobo: 1_500 }, totalDebit: { kobo: 148_500 } });
    expect(await balanceOf(ctx, user.accountId)).toBe(10_000_000);
  });

  it('rejects an unknown category', async () => {
    await request(ctx.app).post(`${api}/bills/quote`).set(bearer(user.token)).send({ category: 'LOAN' }).expect(400);
  });
});

describe('command centre control', () => {
  it('blocks a category that is switched off, without charging', async () => {
    await ctx.container.commandCentre.setState('bills.airtime', false, { updatedBy: 'ops', reason: 'Aggregator outage' });
    const res = await buy('airtime', { network: 'MTN', phone: '08031234567', amount: 10_000 }).expect(503);
    expect(res.body.data).toMatchObject({ feature: 'bills.airtime', reason: 'Aggregator outage' });
    expect(await balanceOf(ctx, user.accountId)).toBe(10_000_000);
    await buy('data', { planCode: 'mtn-500mb-30days', phone: '08031234567' }).expect(202); // others keep working
  });

  it('blocks one provider and leaves the rest', async () => {
    await ctx.container.commandCentre.setState('provider:mock-airtime-mtn', false, { updatedBy: 'ops' });
    const res = await buy('airtime', { network: 'MTN', phone: '08031234567', amount: 10_000 }).expect(503);
    expect(res.body.data.provider).toBe('mock-airtime-mtn');
    await buy('airtime', { network: 'GLO', phone: '08051234567', amount: 10_000 }).expect(202);
  });

  it('stops everything when the platform is off', async () => {
    await ctx.container.commandCentre.setState('platform', false, { updatedBy: 'ops' });
    await buy('airtime', { network: 'MTN', phone: '08031234567', amount: 10_000 }).expect(503);
    await request(ctx.app).post(`${api}/auth/login`).send({ email: user.email, password: 'Password123' }).expect(503);
  });
});
