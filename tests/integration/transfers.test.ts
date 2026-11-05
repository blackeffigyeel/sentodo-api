import request from 'supertest';
import { ServiceUnavailableError } from '../../src/errors/app.errors';
import { balanceOf, bearer, createTestContext, registerCorporate, registerIndividual, type TestContext, type TestUser } from '../helpers/testApp';

const api = '/api/v1';
const SENTODO = '090';
let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

const transfer = (user: TestUser, body: Record<string, unknown>, key?: string) => {
  const call = request(ctx.app).post(`${api}/transfers`).set(bearer(user.token));
  if (key) call.set('Idempotency-Key', key);
  return call.send({ fromAccountId: user.accountId, bankCode: SENTODO, amount: 100_000, ...body });
};

const getTransaction = async (user: TestUser, id: string) =>
  (await request(ctx.app).get(`${api}/transactions/${id}`).set(bearer(user.token)).expect(200)).body.data.transaction;

/** Records `count` earlier free transfers so the monthly allowance is used up. */
async function useFreeAllowance(user: TestUser, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await ctx.repositories.transactions.create({
      reference: `OLD-${user.profileId}-${i}`,
      profileId: user.profileId,
      accountId: user.accountId,
      type: 'P2P_TRANSFER',
      status: 'SUCCESS',
      amount: 1_000,
      fee: 0,
      discount: 0,
      totalDebit: 1_000,
      feeWaived: true,
    });
  }
}

describe('p2p transfers (Sentodo recipient)', () => {
  let alice: TestUser;
  let bob: TestUser;

  beforeEach(async () => {
    alice = await registerIndividual(ctx, { person: 0, fundKobo: 5_000_000 });
    bob = await registerIndividual(ctx, { person: 1 });
  });

  it('returns 202 immediately, debits the sender at once and credits the recipient from the queue', async () => {
    const res = await transfer(alice, { accountNumber: bob.accountNumber, amount: 100_000, narration: 'Rent share' }).expect(202);

    expect(res.body).toMatchObject({ success: true, data: { transaction: { type: 'P2P_TRANSFER', status: 'PROCESSING', narration: 'Rent share' } } });
    expect(res.body.data.transaction.amount).toEqual({ kobo: 100_000, display: '₦1,000.00' });
    expect(res.body.data.transaction.feeWaived).toBe(true);
    expect(res.body.data.transaction.fee.kobo).toBe(0);

    // Fast response: the sender is debited, but the recipient is not credited yet.
    expect(await balanceOf(ctx, alice.accountId)).toBe(4_900_000);
    expect(await balanceOf(ctx, bob.accountId)).toBe(0);
    expect(ctx.transactionQueue.pending).toHaveLength(1);

    await ctx.drain();

    expect(await balanceOf(ctx, bob.accountId)).toBe(100_000);
    expect(await balanceOf(ctx, alice.accountId)).toBe(4_900_000);
    const settled = await getTransaction(alice, res.body.data.transaction.id);
    expect(settled.status).toBe('SUCCESS');
    expect(settled.counterparty.name).toBe('Tunde Bakare');
  });

  it('treats a Sentodo recipient as p2p whichever way the destination is given', async () => {
    const res = await transfer(alice, { bankCode: SENTODO, accountNumber: bob.accountNumber }).expect(202);
    expect(res.body.data.transaction.type).toBe('P2P_TRANSFER');
  });

  it('writes balanced double-entry ledger lines for both accounts', async () => {
    await transfer(alice, { accountNumber: bob.accountNumber, amount: 250_000 }).expect(202);
    await ctx.drain();
    const debits = await ctx.repositories.ledger.listByAccount(alice.accountId, 10);
    const credits = await ctx.repositories.ledger.listByAccount(bob.accountId, 10);
    expect(debits[0]).toMatchObject({ direction: 'DEBIT', amount: 250_000, balanceAfter: 4_750_000 });
    expect(credits[0]).toMatchObject({ direction: 'CREDIT', amount: 250_000, balanceAfter: 250_000 });
  });

  it('records the cost of every free transfer', async () => {
    await transfer(alice, { accountNumber: bob.accountNumber }).expect(202);
    expect(await ctx.repositories.costs.listByType('FREE_TRANSFER', 10)).toHaveLength(1);
  });

  it('charges NGN 10 plus 7.5% VAT once the 20 free transfers are used', async () => {
    await useFreeAllowance(alice, 20);
    const res = await transfer(alice, { accountNumber: bob.accountNumber, amount: 100_000 }).expect(202);
    const tx = res.body.data.transaction;
    expect(tx.feeWaived).toBe(false);
    expect(tx.fee).toEqual({ kobo: 1_075, display: '₦10.75' });
    expect(tx.totalDebit.kobo).toBe(101_075);
    expect(await balanceOf(ctx, alice.accountId)).toBe(5_000_000 - 101_075);
    await ctx.drain();
    expect(await balanceOf(ctx, bob.accountId)).toBe(100_000); // the recipient gets the full amount
  });

  it('adds NGN 50 above NGN 10,000', async () => {
    await useFreeAllowance(alice, 20);
    const res = await transfer(alice, { accountNumber: bob.accountNumber, amount: 1_000_100 }).expect(202);
    expect(res.body.data.transaction.fee.kobo).toBe(6_450);
  });

  it('keeps the 20th transfer free and charges the 21st', async () => {
    await useFreeAllowance(alice, 19);
    const twentieth = await transfer(alice, { accountNumber: bob.accountNumber }).expect(202);
    expect(twentieth.body.data.transaction.feeWaived).toBe(true);
    const twentyFirst = await transfer(alice, { accountNumber: bob.accountNumber }).expect(202);
    expect(twentyFirst.body.data.transaction.feeWaived).toBe(false);
  });

  it('quotes the fee and recipient name without moving money', async () => {
    await useFreeAllowance(alice, 20);
    const res = await request(ctx.app)
      .post(`${api}/transfers/quote`)
      .set(bearer(alice.token))
      .send({ fromAccountId: alice.accountId, bankCode: SENTODO, accountNumber: bob.accountNumber, amount: 2_000_000 })
      .expect(200);
    expect(res.body.data).toMatchObject({
      fee: { waived: false, base: { kobo: 1_000 }, surcharge: { kobo: 5_000 }, vat: { kobo: 450 }, total: { kobo: 6_450 } },
      totalDebit: { kobo: 2_006_450 },
      recipient: { accountName: 'Tunde Bakare', isSentodo: true },
    });
    expect(await balanceOf(ctx, alice.accountId)).toBe(5_000_000);
  });

  it('reports how many free transfers remain', async () => {
    const res = await request(ctx.app)
      .post(`${api}/transfers/quote`)
      .set(bearer(alice.token))
      .send({ fromAccountId: alice.accountId, bankCode: SENTODO, accountNumber: bob.accountNumber, amount: 1_000 })
      .expect(200);
    expect(res.body.data.freeTransfersRemaining).toBe(19);
  });

  it('allows corporates only 10 free transfers per month', async () => {
    const corp = await registerCorporate(ctx, { fundKobo: 5_000_000 });
    await useFreeAllowance(corp, 10);
    const res = await transfer(corp, { accountNumber: bob.accountNumber }).expect(202);
    expect(res.body.data.transaction.feeWaived).toBe(false);
    expect(res.body.data.transaction.fee.kobo).toBe(1_075);
  });

  it('rejects insufficient funds without changing any balance', async () => {
    const res = await transfer(alice, { accountNumber: bob.accountNumber, amount: 9_000_000 }).expect(422);
    expect(res.body).toMatchObject({ success: false, data: { balance: 5_000_000 } });
    expect(await balanceOf(ctx, alice.accountId)).toBe(5_000_000);
    const history = await request(ctx.app).get(`${api}/transactions?type=P2P_TRANSFER`).set(bearer(alice.token)).expect(200);
    expect(history.body.data.transactions).toHaveLength(0); // the failed attempt left no trace
  });

  it('rejects a transfer that cannot cover the fee', async () => {
    await useFreeAllowance(alice, 20);
    const full = await balanceOf(ctx, alice.accountId);
    await transfer(alice, { accountNumber: bob.accountNumber, amount: full }).expect(422);
  });

  it('requires identity verification before money can leave', async () => {
    const carol = await registerIndividual(ctx, { person: 2, verifyIdentity: false, fundKobo: 100_000 });
    const res = await transfer(carol, { accountNumber: bob.accountNumber, amount: 1_000 }).expect(403);
    expect(res.body.message).toMatch(/identity/i);
  });

  it.each([
    ['decimal kobo', { amount: 100.5 }],
    ['a zero amount', { amount: 0 }],
    ['a negative amount', { amount: -100 }],
    ['an amount sent as a string', { amount: '1000' }],
    ['a short account number', { accountNumber: '12345' }],
    ['an unknown bank code', { bankCode: '12' }],
  ])('rejects %s', async (_label, overrides) => {
    await transfer(alice, { accountNumber: bob.accountNumber, ...overrides }).expect(400);
  });

  it('enforces the minimum and maximum transfer', async () => {
    await transfer(alice, { accountNumber: bob.accountNumber, amount: 99 }).expect(400);
    await transfer(alice, { accountNumber: bob.accountNumber, amount: 500_000_001 }).expect(400);
  });

  it('rejects transfers to the same account and to unknown recipients', async () => {
    await transfer(alice, { accountNumber: alice.accountNumber }).expect(400);
    await transfer(alice, { accountNumber: '0000000001' }).expect(404);
  });

  it("will not debit an account the profile does not own", async () => {
    await request(ctx.app)
      .post(`${api}/transfers`)
      .set(bearer(alice.token))
      .send({ fromAccountId: bob.accountId, bankCode: SENTODO, accountNumber: alice.accountNumber, amount: 1_000 })
      .expect(404);
  });

  it('requires authentication', async () => {
    await request(ctx.app).post(`${api}/transfers`).send({}).expect(401);
  });

  describe('idempotency', () => {
    it('returns the original transaction and debits only once when a key is reused', async () => {
      const first = await transfer(alice, { accountNumber: bob.accountNumber }, 'idem-key-0001').expect(202);
      const second = await transfer(alice, { accountNumber: bob.accountNumber }, 'idem-key-0001').expect(202);
      expect(second.body.data.transaction.id).toBe(first.body.data.transaction.id);
      expect(await balanceOf(ctx, alice.accountId)).toBe(4_900_000);
      await ctx.drain();
      expect(await balanceOf(ctx, bob.accountId)).toBe(100_000);
    });

    it('handles concurrent duplicates', async () => {
      const results = await Promise.all(
        Array.from({ length: 4 }, () => transfer(alice, { accountNumber: bob.accountNumber }, 'idem-race-0001')),
      );
      expect(new Set(results.map((r) => r.body.data.transaction.id)).size).toBe(1);
      expect(await balanceOf(ctx, alice.accountId)).toBe(4_900_000);
    });

    it('treats different keys as different transfers', async () => {
      await transfer(alice, { accountNumber: bob.accountNumber }, 'idem-key-0001').expect(202);
      await transfer(alice, { accountNumber: bob.accountNumber }, 'idem-key-0002').expect(202);
      expect(await balanceOf(ctx, alice.accountId)).toBe(4_800_000);
    });

    it('rejects malformed keys', async () => {
      await transfer(alice, { accountNumber: bob.accountNumber }, 'short').expect(400);
    });
  });

  describe('queue settlement', () => {
    it('never credits twice if the job runs again', async () => {
      const res = await transfer(alice, { accountNumber: bob.accountNumber }).expect(202);
      await ctx.drain();
      await ctx.container.settlement.settle(res.body.data.transaction.id);
      await ctx.container.settlement.settle(res.body.data.transaction.id);
      expect(await balanceOf(ctx, bob.accountId)).toBe(100_000);
    });

    it('conserves money across many parallel transfers', async () => {
      const results = await Promise.all(Array.from({ length: 8 }, () => transfer(alice, { accountNumber: bob.accountNumber, amount: 50_000 })));
      for (const result of results) expect(result.status).toBe(202);
      await ctx.drain();
      expect(await balanceOf(ctx, alice.accountId)).toBe(5_000_000 - 8 * 50_000);
      expect(await balanceOf(ctx, bob.accountId)).toBe(8 * 50_000);
    });

    it('refunds the sender and reports a 503 if the job cannot be queued', async () => {
      jest.spyOn(ctx.transactionQueue, 'add').mockRejectedValueOnce(new Error('redis down'));
      const res = await transfer(alice, { accountNumber: bob.accountNumber }).expect(503);
      expect(res.body.message).toMatch(/not been charged/);
      expect(await balanceOf(ctx, alice.accountId)).toBe(5_000_000);
      const history = await request(ctx.app).get(`${api}/transactions?type=P2P_TRANSFER`).set(bearer(alice.token)).expect(200);
      expect(history.body.data.transactions[0]).toMatchObject({ status: 'FAILED' });
    });

    it('is blocked by the command centre', async () => {
      await ctx.container.commandCentre.setState('transfers.p2p', false, { updatedBy: 'ops', reason: 'Incident' });
      const res = await transfer(alice, { accountNumber: bob.accountNumber }).expect(503);
      expect(res.body.data).toMatchObject({ feature: 'transfers.p2p', reason: 'Incident' });
      expect(await balanceOf(ctx, alice.accountId)).toBe(5_000_000);
    });
  });
});

describe('external transfers (other banks)', () => {
  let alice: TestUser;

  beforeEach(async () => {
    alice = await registerIndividual(ctx, { person: 0, fundKobo: 5_000_000 });
  });

  it('resolves the account name, debits at once and sends through the provider from the queue', async () => {
    const res = await transfer(alice, { bankCode: '058', accountNumber: '0123456789', amount: 200_000 }).expect(202);
    const tx = res.body.data.transaction;
    expect(tx).toMatchObject({ type: 'EXTERNAL_TRANSFER', status: 'PROCESSING', counterparty: { bank: 'Guaranty Trust Bank' } });
    expect(tx.counterparty.name).toMatch(/^[A-Z ]+$/);
    expect(await balanceOf(ctx, alice.accountId)).toBe(4_800_000);

    await ctx.drain();
    const settled = await getTransaction(alice, tx.id);
    expect(settled.status).toBe('SUCCESS');
    expect(settled.providerReference).toMatch(/^NIP-\d{14}$/);
  });

  it('refunds everything, fee included, when the other bank declines', async () => {
    await useFreeAllowance(alice, 20);
    const res = await transfer(alice, { bankCode: '058', accountNumber: '0123450000', amount: 200_000 }).expect(202);
    expect(await balanceOf(ctx, alice.accountId)).toBe(5_000_000 - 201_075);

    await ctx.drain();
    const failed = await getTransaction(alice, res.body.data.transaction.id);
    expect(failed).toMatchObject({ status: 'FAILED', failureReason: expect.any(String) });
    expect(await balanceOf(ctx, alice.accountId)).toBe(5_000_000);
    const entries = await ctx.repositories.ledger.listByAccount(alice.accountId, 10);
    expect(entries.map((e) => e.direction)).toEqual(expect.arrayContaining(['DEBIT', 'CREDIT']));
  });

  it('gives a failed free transfer back to the monthly allowance', async () => {
    await transfer(alice, { bankCode: '058', accountNumber: '0123450000' }).expect(202);
    await ctx.drain();
    const used = await ctx.repositories.transactions.countFreeTransfersSince(alice.profileId, new Date(0));
    expect(used).toBe(0);
  });

  it('retries instead of refunding when the provider is switched off mid-flight', async () => {
    const res = await transfer(alice, { bankCode: '058', accountNumber: '0123456789' }).expect(202);
    const id = res.body.data.transaction.id as string;

    await ctx.container.commandCentre.setState('provider:mock-nip-transfer', false, { updatedBy: 'ops' });
    await expect(ctx.transactionQueue.drain()).rejects.toThrow(ServiceUnavailableError);
    expect((await getTransaction(alice, id)).status).toBe('PROCESSING');
    expect(await balanceOf(ctx, alice.accountId)).toBe(4_900_000); // not refunded yet

    await ctx.container.commandCentre.setState('provider:mock-nip-transfer', true, { updatedBy: 'ops' });
    await ctx.container.settlement.settle(id);
    expect((await getTransaction(alice, id)).status).toBe('SUCCESS');
  });

  it('refuses new external transfers while the provider is off', async () => {
    await ctx.container.commandCentre.setState('provider:mock-nip-transfer', false, { updatedBy: 'ops' });
    const res = await transfer(alice, { bankCode: '058', accountNumber: '0123456789' }).expect(503);
    expect(res.body.data.provider).toBe('mock-nip-transfer');
  });

  it('rejects accounts the provider cannot resolve and unknown bank codes', async () => {
    await transfer(alice, { bankCode: '058', accountNumber: '0123459999' }).expect(502);
    await transfer(alice, { bankCode: '777', accountNumber: '0123456789' }).expect(400);
    expect(await balanceOf(ctx, alice.accountId)).toBe(5_000_000);
  });
});

describe('banks and name enquiry', () => {
  it('lists banks including Sentodo MFB', async () => {
    const user = await registerIndividual(ctx);
    const res = await request(ctx.app).get(`${api}/banks`).set(bearer(user.token)).expect(200);
    expect(res.body.data.banks).toEqual(expect.arrayContaining([{ code: '090', name: 'Sentodo Microfinance Bank' }, { code: '058', name: 'Guaranty Trust Bank' }]));
  });

  it('resolves Sentodo accounts locally and flags them as p2p', async () => {
    const a = await registerIndividual(ctx, { person: 0 });
    const b = await registerIndividual(ctx, { person: 1 });
    const res = await request(ctx.app).get(`${api}/banks/resolve?bankCode=090&accountNumber=${b.accountNumber}`).set(bearer(a.token)).expect(200);
    expect(res.body.data).toMatchObject({ accountName: 'Tunde Bakare', isSentodo: true, bankName: 'Sentodo Microfinance Bank' });
  });

  it('resolves other banks through the provider', async () => {
    const a = await registerIndividual(ctx);
    const res = await request(ctx.app).get(`${api}/banks/resolve?bankCode=044&accountNumber=0123456789`).set(bearer(a.token)).expect(200);
    expect(res.body.data).toMatchObject({ isSentodo: false, bankName: 'Access Bank' });
  });

  it('validates the query', async () => {
    const a = await registerIndividual(ctx);
    await request(ctx.app).get(`${api}/banks/resolve?bankCode=044&accountNumber=123`).set(bearer(a.token)).expect(400);
    await request(ctx.app).get(`${api}/banks`).expect(401);
  });
});

describe('transaction history', () => {
  it('lists newest first, filters, paginates and hides other profiles', async () => {
    const a = await registerIndividual(ctx, { person: 0, fundKobo: 5_000_000 });
    const b = await registerIndividual(ctx, { person: 1 });
    for (let i = 0; i < 3; i += 1) {
      await transfer(a, { accountNumber: b.accountNumber, amount: 1_000 + i }).expect(202);
      await new Promise((resolve) => setTimeout(resolve, 3));
    }
    const page = await request(ctx.app).get(`${api}/transactions?type=P2P_TRANSFER&limit=2`).set(bearer(a.token)).expect(200);
    expect(page.body.data.transactions).toHaveLength(2);
    expect(page.body.data.transactions[0].amount.kobo).toBe(1_002);
    expect(page.body.data.nextCursor).not.toBeNull();

    const next = await request(ctx.app).get(`${api}/transactions?type=P2P_TRANSFER&limit=2&before=${encodeURIComponent(page.body.data.nextCursor)}`).set(bearer(a.token)).expect(200);
    expect(next.body.data.transactions).toHaveLength(1);

    const mine = await request(ctx.app).get(`${api}/transactions?type=P2P_TRANSFER`).set(bearer(b.token)).expect(200);
    expect(mine.body.data.transactions).toHaveLength(0);

    const id = page.body.data.transactions[0].id;
    await request(ctx.app).get(`${api}/transactions/${id}`).set(bearer(b.token)).expect(404);
    const byReference = page.body.data.transactions[0].reference;
    await request(ctx.app).get(`${api}/transactions/${byReference}`).set(bearer(a.token)).expect(200);
  });

  it('validates query parameters', async () => {
    const a = await registerIndividual(ctx);
    await request(ctx.app).get(`${api}/transactions?limit=1000`).set(bearer(a.token)).expect(400);
    await request(ctx.app).get(`${api}/transactions?type=NOPE`).set(bearer(a.token)).expect(400);
  });
});
