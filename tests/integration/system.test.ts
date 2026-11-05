import request from 'supertest';
import { createTestContext, createTestContext as build } from '../helpers/testApp';

const api = '/api/v1';

describe('response envelope', () => {
  it('wraps success as { success, message, data }', async () => {
    const ctx = await createTestContext();
    const res = await request(ctx.app).get(`${api}/health`).expect(200);
    expect(Object.keys(res.body).sort()).toEqual(['data', 'message', 'success']);
    expect(res.body).toMatchObject({ success: true, message: expect.any(String), data: { status: 'ok' } });
  });

  it('wraps unknown routes the same way', async () => {
    const ctx = await createTestContext();
    const res = await request(ctx.app).get(`${api}/nothing-here`).expect(404);
    expect(res.body).toEqual({ success: false, message: 'Route not found: GET /api/v1/nothing-here', data: null });
  });

  it('answers malformed JSON with a 400 in the same envelope', async () => {
    const ctx = await createTestContext();
    const res = await request(ctx.app).post(`${api}/auth/login`).set('Content-Type', 'application/json').send('{"email": ').expect(400);
    expect(res.body).toEqual({ success: false, message: 'Request body is not valid JSON', data: null });
  });

  it('rejects oversized bodies', async () => {
    const ctx = await createTestContext();
    const res = await request(ctx.app).post(`${api}/auth/login`).send({ email: 'a@b.co', password: 'x'.repeat(200_000) }).expect(413);
    expect(res.body.success).toBe(false);
  });

  it('never leaks internals on unexpected errors', async () => {
    const ctx = await createTestContext();
    jest.spyOn(ctx.repositories.profiles, 'findByEmail').mockRejectedValueOnce(new Error('connection to 10.0.0.5:5432 refused, password=hunter2'));
    const res = await request(ctx.app).post(`${api}/auth/login`).send({ email: 'a@example.com', password: 'Password123' }).expect(500);
    expect(res.body).toEqual({ success: false, message: 'Something went wrong on our side. Please try again.', data: null });
    expect(JSON.stringify(res.body)).not.toMatch(/hunter2|10\.0\.0\.5/);
  });

  it('returns a request id and security headers', async () => {
    const ctx = await createTestContext();
    const res = await request(ctx.app).get(`${api}/health`).expect(200);
    expect(res.headers['x-request-id']).toMatch(/[\w-]{8,}/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
    const echoed = await request(ctx.app).get(`${api}/health`).set('X-Request-Id', 'client-req-12345').expect(200);
    expect(echoed.headers['x-request-id']).toBe('client-req-12345');
  });
});

describe('health probes', () => {
  it('reports readiness with every dependency', async () => {
    const ctx = await createTestContext();
    const res = await request(ctx.app).get(`${api}/health/ready`).expect(200);
    expect(res.body.data.checks).toEqual({ memory: true });
  });

  it('reports 503 when a dependency is down', async () => {
    const ctx = await createTestContext();
    ctx.container.healthChecks.postgresql = async () => false;
    ctx.container.healthChecks.redis = async () => {
      throw new Error('down');
    };
    const res = await request(ctx.app).get(`${api}/health/ready`).expect(503);
    expect(res.body).toMatchObject({ success: false, data: { checks: { memory: true, postgresql: false, redis: false } } });
  });
});

describe('rate limiting over HTTP', () => {
  it('answers 429 with Retry-After and rate-limit headers once the allowance is used', async () => {
    const ctx = await build({ limits: { auth: { limit: 2, burst: 2, windowSeconds: 600 } } });
    const attempt = () => request(ctx.app).post(`${api}/auth/login`).send({ email: 'x@example.com', password: 'Password123' });

    const first = await attempt().expect(401);
    expect(first.headers['x-ratelimit-limit']).toBe('2');
    expect(first.headers['x-ratelimit-remaining']).toBe('1');
    await attempt().expect(401);

    const limited = await attempt().expect(429);
    expect(limited.body).toMatchObject({ success: false, data: { retryAfterSeconds: expect.any(Number) } });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(limited.headers['x-ratelimit-remaining']).toBe('0');
  });

  it('limits by IP on public routes: another address is unaffected', async () => {
    const ctx = await build({ limits: { auth: { limit: 1, burst: 1, windowSeconds: 600 } } });
    const attempt = (ip: string) =>
      request(ctx.app).post(`${api}/auth/login`).set('X-Forwarded-For', ip).send({ email: 'x@example.com', password: 'Password123' });
    await attempt('1.1.1.1').expect(401);
    await attempt('1.1.1.1').expect(429);
    await attempt('2.2.2.2').expect(401);
  });

  it('applies the global policy before anything else', async () => {
    const ctx = await build({ limits: { global: { limit: 2, burst: 2, windowSeconds: 600 } } });
    await request(ctx.app).get(`${api}/health`).expect(200);
    await request(ctx.app).get(`${api}/health`).expect(200);
    await request(ctx.app).get(`${api}/health`).expect(429);
  });

  it('weights costs: a transfer drains more of the allowance than a read', async () => {
    const ctx = await build({ limits: { transactions: { limit: 10, burst: 10, windowSeconds: 600 } } });
    const { registerIndividual, bearer } = await import('../helpers/testApp');
    const user = await registerIndividual(ctx, { fundKobo: 5_000_000 });
    const other = await registerIndividual(ctx, { person: 1 });
    const send = () =>
      request(ctx.app)
        .post(`${api}/transfers`)
        .set(bearer(user.token))
        .send({ fromAccountId: user.accountId, bankCode: '090', accountNumber: other.accountNumber, amount: 1_000 });
    await send().expect(202); // cost 5
    await send().expect(202); // cost 5
    await send().expect(429);
  });

  it('fails closed when the limiter breaks on credential endpoints', async () => {
    const ctx = await build({ failingPolicies: ['auth'] });
    const res = await request(ctx.app).post(`${api}/auth/login`).send({ email: 'x@example.com', password: 'Password123' }).expect(503);
    expect(res.body.success).toBe(false);
  });

  it('fails open when the limiter breaks on low-risk endpoints', async () => {
    const ctx = await build({ failingPolicies: ['global'] });
    await request(ctx.app).get(`${api}/health`).expect(200);
  });

  it('fails closed for money movement when its limiter breaks', async () => {
    const ctx = await build({ failingPolicies: ['transactions'] });
    const { registerIndividual, bearer } = await import('../helpers/testApp');
    const user = await registerIndividual(ctx, { fundKobo: 5_000_000 });
    await request(ctx.app)
      .post(`${api}/bills/airtime`)
      .set(bearer(user.token))
      .send({ fromAccountId: user.accountId, network: 'MTN', phone: '08031234567', amount: 10_000 })
      .expect(503);
  });
});
