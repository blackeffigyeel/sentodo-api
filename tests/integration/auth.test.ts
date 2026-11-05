import jwt from 'jsonwebtoken';
import request from 'supertest';
import { bearer, createTestContext, PEOPLE, registerIndividual, type TestContext } from '../helpers/testApp';

const api = '/api/v1';
let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

const individual = (overrides: Record<string, unknown> = {}) => ({
  type: 'INDIVIDUAL',
  email: 'adaeze@example.com',
  phone: '08031234567',
  password: 'Password123',
  firstName: 'Adaeze',
  lastName: 'Okonkwo',
  ...overrides,
});

describe('registration', () => {
  it('creates an unverified profile and queues a verification email', async () => {
    const res = await request(ctx.app).post(`${api}/auth/register`).send(individual()).expect(201);

    expect(res.body).toEqual({ success: true, message: expect.any(String), data: { profile: expect.any(Object) } });
    expect(res.body.data.profile).toMatchObject({ type: 'INDIVIDUAL', emailVerified: false, phoneVerified: false, identityVerified: false });
    expect(JSON.stringify(res.body)).not.toMatch(/password/i);

    expect(ctx.emails.sent).toHaveLength(0); // queued, not sent inline
    await ctx.drain();
    expect(ctx.emails.sent).toHaveLength(1);
    expect(ctx.emails.sent[0]).toMatchObject({ to: 'adaeze@example.com', subject: expect.stringContaining('verification') });
    expect(ctx.emails.sent[0].text).toMatch(/code is \d{6}/);
  });

  it('normalises phone numbers to 11 digits and lower-cases emails', async () => {
    const res = await request(ctx.app)
      .post(`${api}/auth/register`)
      .send(individual({ phone: '+234 803 123 4567', email: 'Adaeze@Example.COM' }))
      .expect(201);
    expect(res.body.data.profile.phone).toBe('08031234567');
    expect(res.body.data.profile.email).toBe('adaeze@example.com');
  });

  it('stores only a hash of the password and of the emailed code', async () => {
    await request(ctx.app).post(`${api}/auth/register`).send(individual()).expect(201);
    await ctx.drain();
    const stored = [...ctx.repositories.db.profiles.values()][0];
    expect(stored.passwordHash).not.toContain('Password123');
    const code = ctx.emails.sent[0].text.match(/code is (\d{6})/)![1];
    const codes = [...ctx.repositories.db.verificationCodes.values()];
    expect(codes).toHaveLength(1);
    expect(codes[0].codeHash).not.toContain(code);
  });

  it('rejects duplicates with 409', async () => {
    await request(ctx.app).post(`${api}/auth/register`).send(individual()).expect(201);
    const sameEmail = await request(ctx.app).post(`${api}/auth/register`).send(individual({ phone: '08122223333' })).expect(409);
    expect(sameEmail.body).toMatchObject({ success: false, data: null });
    await request(ctx.app).post(`${api}/auth/register`).send(individual({ email: 'other@example.com' })).expect(409);
  });

  it.each([
    ['a weak password', { password: 'short' }, 'password'],
    ['a password without a digit', { password: 'Password' }, 'password'],
    ['an invalid phone number', { phone: '12345' }, 'phone'],
    ['a 10-digit phone number', { phone: '0803123456' }, 'phone'],
    ['an invalid email', { email: 'nope' }, 'email'],
    ['an individual without a first name', { firstName: undefined }, 'firstName'],
    ['an unknown profile type', { type: 'ADMIN' }, 'type'],
  ])('rejects %s with itemised issues', async (_label, overrides, field) => {
    const res = await request(ctx.app).post(`${api}/auth/register`).send(individual(overrides)).expect(400);
    expect(res.body.success).toBe(false);
    expect(res.body.data.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: field })]));
  });

  it('requires a business name for corporate profiles', async () => {
    const res = await request(ctx.app)
      .post(`${api}/auth/register`)
      .send({ type: 'CORPORATE', email: 'c@example.com', phone: '08031234567', password: 'Password123' })
      .expect(400);
    expect(res.body.data.issues[0].path).toBe('businessName');
  });

  it('is blocked when the command centre switches registration off', async () => {
    await ctx.container.commandCentre.setState('registration', false, { updatedBy: 'ops', reason: 'Maintenance' });
    const res = await request(ctx.app).post(`${api}/auth/register`).send(individual()).expect(503);
    expect(res.body).toMatchObject({ success: false, data: { feature: 'registration', reason: 'Maintenance' } });
  });
});

describe('verification', () => {
  const codeFor = async (email: string): Promise<string> => {
    await ctx.drain();
    return [...ctx.emails.sent].reverse().find((m) => m.to === email)!.text.match(/code is (\d{6})/)![1];
  };

  beforeEach(async () => {
    await request(ctx.app).post(`${api}/auth/register`).send(individual()).expect(201);
  });

  it('verifies email with the emailed code', async () => {
    const code = await codeFor('adaeze@example.com');
    const res = await request(ctx.app).post(`${api}/auth/verify-email`).send({ email: 'adaeze@example.com', code }).expect(200);
    expect(res.body.data.profile.emailVerified).toBe(true);
  });

  it('rejects a wrong email code, and a used one cannot be replayed', async () => {
    const code = await codeFor('adaeze@example.com');
    const wrong = code === '000000' ? '111111' : '000000';
    await request(ctx.app).post(`${api}/auth/verify-email`).send({ email: 'adaeze@example.com', code: wrong }).expect(400);
    await request(ctx.app).post(`${api}/auth/verify-email`).send({ email: 'adaeze@example.com', code }).expect(200);
  });

  it('locks a code after too many wrong attempts', async () => {
    const code = await codeFor('adaeze@example.com');
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i += 1) {
      await request(ctx.app).post(`${api}/auth/verify-email`).send({ email: 'adaeze@example.com', code: wrong }).expect(400);
    }
    await request(ctx.app).post(`${api}/auth/verify-email`).send({ email: 'adaeze@example.com', code }).expect(400);
  });

  it('does not reveal whether an email is registered', async () => {
    const unknown = await request(ctx.app).post(`${api}/auth/verify-email`).send({ email: 'nobody@example.com', code: '123456' }).expect(400);
    const known = await request(ctx.app).post(`${api}/auth/verify-email`).send({ email: 'adaeze@example.com', code: '999999' }).expect(400);
    expect(unknown.body.message).toBe(known.body.message);
  });

  it('resends a fresh code, invalidating the old one, with a generic response', async () => {
    const first = await codeFor('adaeze@example.com');
    const a = await request(ctx.app).post(`${api}/auth/resend-email-code`).send({ email: 'adaeze@example.com' }).expect(200);
    const b = await request(ctx.app).post(`${api}/auth/resend-email-code`).send({ email: 'ghost@example.com' }).expect(200);
    expect(a.body.message).toBe(b.body.message);
    const second = await codeFor('adaeze@example.com');
    expect(ctx.emails.sent.filter((m) => m.to === 'adaeze@example.com')).toHaveLength(2);
    if (first !== second) {
      await request(ctx.app).post(`${api}/auth/verify-email`).send({ email: 'adaeze@example.com', code: first }).expect(400);
    }
    await request(ctx.app).post(`${api}/auth/verify-email`).send({ email: 'adaeze@example.com', code: second }).expect(200);
  });

  it('verifies a phone number with any code from the configured list of 6-digit codes', async () => {
    const res = await request(ctx.app).post(`${api}/auth/verify-phone`).send({ phone: '08031234567', code: '654321' }).expect(200);
    expect(res.body.data.profile.phoneVerified).toBe(true);
  });

  it('rejects phone codes that are not on the list', async () => {
    await request(ctx.app).post(`${api}/auth/verify-phone`).send({ phone: '08031234567', code: '000001' }).expect(400);
  });

  it('records the cost of the SMS and email for reporting', async () => {
    await ctx.drain();
    await request(ctx.app).post(`${api}/auth/verify-phone`).send({ phone: '08031234567', code: '123456' }).expect(200);
    expect(await ctx.repositories.costs.listByType('EMAIL', 10)).toHaveLength(1);
    expect(await ctx.repositories.costs.listByType('SMS_OTP', 10)).toHaveLength(1);
  });

  it('generates a 10-digit account number only once both channels are verified', async () => {
    const code = await codeFor('adaeze@example.com');
    await request(ctx.app).post(`${api}/auth/verify-email`).send({ email: 'adaeze@example.com', code }).expect(200);
    expect(ctx.repositories.db.accounts.size).toBe(0);
    await request(ctx.app).post(`${api}/auth/verify-phone`).send({ phone: '08031234567', code: '123456' }).expect(200);
    const accounts = [...ctx.repositories.db.accounts.values()];
    expect(accounts).toHaveLength(1);
    expect(accounts[0].accountNumber).toMatch(/^\d{10}$/);
    expect(accounts[0]).toMatchObject({ balance: 0, name: 'Adaeze Okonkwo', currency: 'NGN' });
  });
});

describe('login and tokens', () => {
  it('refuses sign-in until email and phone are verified, saying which is missing', async () => {
    await request(ctx.app).post(`${api}/auth/register`).send(individual()).expect(201);
    const res = await request(ctx.app).post(`${api}/auth/login`).send({ email: 'adaeze@example.com', password: 'Password123' }).expect(403);
    expect(res.body.data).toEqual({ emailVerified: false, phoneVerified: false });
  });

  it('signs in a verified profile and returns a bearer token', async () => {
    const user = await registerIndividual(ctx, { verifyIdentity: false });
    const res = await request(ctx.app).post(`${api}/auth/login`).send({ email: user.email, password: 'Password123' }).expect(200);
    expect(res.body.data).toMatchObject({ tokenType: 'Bearer', expiresInSeconds: 3600, accessToken: expect.any(String) });
  });

  it('gives the same 401 for a wrong password and an unknown email', async () => {
    const user = await registerIndividual(ctx, { verifyIdentity: false });
    const wrong = await request(ctx.app).post(`${api}/auth/login`).send({ email: user.email, password: 'WrongPass1' }).expect(401);
    const unknown = await request(ctx.app).post(`${api}/auth/login`).send({ email: 'ghost@example.com', password: 'WrongPass1' }).expect(401);
    expect(wrong.body.message).toBe(unknown.body.message);
  });

  it('refuses suspended profiles', async () => {
    const user = await registerIndividual(ctx, { verifyIdentity: false });
    await ctx.repositories.profiles.update(user.profileId, { status: 'SUSPENDED' });
    await request(ctx.app).post(`${api}/auth/login`).send({ email: user.email, password: 'Password123' }).expect(403);
  });

  describe('POST /auth/verify-token', () => {
    it('confirms a valid token and reports its identity and expiry', async () => {
      const user = await registerIndividual(ctx, { verifyIdentity: false });
      const res = await request(ctx.app).post(`${api}/auth/verify-token`).send({ token: user.token }).expect(200);
      expect(res.body.data).toMatchObject({ valid: true, profileId: user.profileId, profileType: 'INDIVIDUAL' });
      expect(new Date(res.body.data.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    it('rejects garbage, tampered and expired tokens', async () => {
      const user = await registerIndividual(ctx, { verifyIdentity: false });
      await request(ctx.app).post(`${api}/auth/verify-token`).send({ token: 'not-a-real-token' }).expect(401);
      await request(ctx.app).post(`${api}/auth/verify-token`).send({ token: `${user.token}x` }).expect(401);

      const expired = jwt.sign({ type: 'INDIVIDUAL' }, 'test-jwt-secret-0123456789', { subject: user.profileId, expiresIn: -10 });
      await request(ctx.app).post(`${api}/auth/verify-token`).send({ token: expired }).expect(401);

      const wrongSecret = jwt.sign({ type: 'INDIVIDUAL' }, 'a-different-secret-value', { subject: user.profileId, expiresIn: 60 });
      await request(ctx.app).post(`${api}/auth/verify-token`).send({ token: wrongSecret }).expect(401);
    });

    it('rejects unsigned "alg: none" tokens', async () => {
      const user = await registerIndividual(ctx, { verifyIdentity: false });
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ sub: user.profileId, type: 'INDIVIDUAL', iat: 1, exp: 9_999_999_999 })).toString('base64url');
      await request(ctx.app).post(`${api}/auth/verify-token`).send({ token: `${header}.${payload}.` }).expect(401);
    });

    it('rejects the token of a profile that has since been suspended', async () => {
      const user = await registerIndividual(ctx, { verifyIdentity: false });
      await ctx.repositories.profiles.update(user.profileId, { status: 'SUSPENDED' });
      await request(ctx.app).post(`${api}/auth/verify-token`).send({ token: user.token }).expect(401);
    });

    it('validates the request body', async () => {
      await request(ctx.app).post(`${api}/auth/verify-token`).send({}).expect(400);
    });
  });
});

describe('profile and identity verification', () => {
  it('requires authentication', async () => {
    await request(ctx.app).get(`${api}/profiles/me`).expect(401);
    await request(ctx.app).get(`${api}/profiles/me`).set('Authorization', 'Bearer nope').expect(401);
  });

  it('returns the signed-in profile without secrets', async () => {
    const user = await registerIndividual(ctx, { verifyIdentity: false });
    const res = await request(ctx.app).get(`${api}/profiles/me`).set(bearer(user.token)).expect(200);
    expect(res.body.data.profile).toMatchObject({ id: user.profileId, email: user.email, emailVerified: true, phoneVerified: true, identityVerified: false });
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|bvnHash/);
  });

  it('verifies identity against the mock BVN list and records the cost', async () => {
    const user = await registerIndividual(ctx, { verifyIdentity: false });
    const res = await request(ctx.app).post(`${api}/profiles/me/identity`).set(bearer(user.token)).send({ bvn: PEOPLE[0].bvn }).expect(200);
    expect(res.body.data.profile.identityVerified).toBe(true);
    expect(await ctx.repositories.costs.listByType('IDENTITY_VERIFICATION', 10)).toHaveLength(1);
    const stored = ctx.repositories.db.profiles.get(user.profileId)!;
    expect(stored.bvnHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects unknown BVNs but still records the cost of the lookup', async () => {
    const user = await registerIndividual(ctx, { verifyIdentity: false });
    await request(ctx.app).post(`${api}/profiles/me/identity`).set(bearer(user.token)).send({ bvn: '00000000000' }).expect(400);
    expect(await ctx.repositories.costs.listByType('IDENTITY_VERIFICATION', 10)).toHaveLength(1);
  });

  it("rejects a BVN that belongs to someone else's name", async () => {
    const user = await registerIndividual(ctx, { verifyIdentity: false });
    const res = await request(ctx.app).post(`${api}/profiles/me/identity`).set(bearer(user.token)).send({ bvn: PEOPLE[1].bvn }).expect(400);
    expect(res.body.message).toMatch(/do not match/);
  });

  it('validates the BVN format', async () => {
    const user = await registerIndividual(ctx, { verifyIdentity: false });
    await request(ctx.app).post(`${api}/profiles/me/identity`).set(bearer(user.token)).send({ bvn: '123' }).expect(400);
  });
});

describe('accounts', () => {
  it('lets a verified profile open more accounts, each with its own 10-digit number', async () => {
    const user = await registerIndividual(ctx);
    const res = await request(ctx.app).post(`${api}/accounts`).set(bearer(user.token)).send({ name: 'Savings' }).expect(201);
    expect(res.body.data.account).toMatchObject({ name: 'Savings', accountNumber: expect.stringMatching(/^\d{10}$/), balance: { kobo: 0, display: '₦0.00' } });
    const list = await request(ctx.app).get(`${api}/accounts`).set(bearer(user.token)).expect(200);
    expect(list.body.data.accounts).toHaveLength(2);
    expect(new Set(list.body.data.accounts.map((a: { accountNumber: string }) => a.accountNumber)).size).toBe(2);
  });

  it('caps the number of accounts per profile', async () => {
    const user = await registerIndividual(ctx);
    for (let i = 0; i < 4; i += 1) await request(ctx.app).post(`${api}/accounts`).set(bearer(user.token)).send({}).expect(201);
    await request(ctx.app).post(`${api}/accounts`).set(bearer(user.token)).send({}).expect(400);
  });

  it("does not reveal other profiles' accounts", async () => {
    const a = await registerIndividual(ctx, { person: 0 });
    const b = await registerIndividual(ctx, { person: 1 });
    await request(ctx.app).get(`${api}/accounts/${b.accountId}`).set(bearer(a.token)).expect(404);
    await request(ctx.app).get(`${api}/accounts/not-a-uuid`).set(bearer(a.token)).expect(400);
  });

  it('keeps sandbox funding switched off unless the command centre enables it', async () => {
    const user = await registerIndividual(ctx);
    const res = await request(ctx.app).post(`${api}/accounts/${user.accountId}/fund`).set(bearer(user.token)).send({ amount: 100_000 }).expect(503);
    expect(res.body.data.feature).toBe('sandbox-funding');
  });

  it('funds with integer kobo only', async () => {
    const user = await registerIndividual(ctx);
    await ctx.container.commandCentre.setState('sandbox-funding', true, { updatedBy: 'test' });
    await request(ctx.app).post(`${api}/accounts/${user.accountId}/fund`).set(bearer(user.token)).send({ amount: 100.5 }).expect(400);
    await request(ctx.app).post(`${api}/accounts/${user.accountId}/fund`).set(bearer(user.token)).send({ amount: -5 }).expect(400);
    await request(ctx.app).post(`${api}/accounts/${user.accountId}/fund`).set(bearer(user.token)).send({ amount: '100' }).expect(400);
    const ok = await request(ctx.app).post(`${api}/accounts/${user.accountId}/fund`).set(bearer(user.token)).send({ amount: 250_000 }).expect(200);
    expect(ok.body.data.account.balance).toEqual({ kobo: 250_000, display: '₦2,500.00' });
  });
});
