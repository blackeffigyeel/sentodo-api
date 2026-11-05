import { MOCK_TV_CUSTOMERS } from '../../src/data/catalogue.data';
import { IntegrationError } from '../../src/errors/app.errors';
import { createMockProviderRegistry, providerId } from '../../src/providers/mock/mock.providers';

const registry = createMockProviderRegistry({ mockPhoneCodes: ['123456', '654321'] });

describe('mock providers', () => {
  it('builds stable identifiers', () => {
    expect(providerId('tv', 'DSTV')).toBe('mock-tv-dstv');
    expect(providerId('education', 'WAEC_RESULT')).toBe('mock-education-waec-result');
  });

  it('resolves bill providers by category and key', () => {
    expect(registry.bill('AIRTIME', 'MTN')?.id).toBe('mock-airtime-mtn');
    expect(registry.bill('DATA', 'GLO')?.id).toBe('mock-data-glo');
    expect(registry.bill('TV', 'NOPE')).toBeUndefined();
    expect(registry.billById('mock-tv-gotv')?.category).toBe('TV');
  });

  it('is idempotent: the same reference yields the same provider reference', async () => {
    const provider = registry.bill('AIRTIME', 'MTN')!;
    const request = { reference: 'SNT-1', amount: 10_000, customerId: '08031234567' };
    const first = await provider.purchase(request);
    const second = await provider.purchase(request);
    expect(first.providerReference).toBe(second.providerReference);
    expect(first.providerReference).not.toBe((await provider.purchase({ ...request, reference: 'SNT-2' })).providerReference);
  });

  it('declines customers ending in 0000 (deterministic failure trigger)', async () => {
    const provider = registry.bill('DATA', 'MTN')!;
    await expect(provider.purchase({ reference: 'r', amount: 1, customerId: '08030000000' })).rejects.toThrow(IntegrationError);
  });

  it('returns a tokenised electricity purchase', async () => {
    const result = await registry.bill('ELECTRICITY', 'IKEDC')!.purchase({ reference: 'r1', amount: 100_000, customerId: '12345678901' });
    expect(result.token).toMatch(/^\d{4}(-\d{4}){4}$/);
  });

  it('returns an education PIN and a food order code', async () => {
    expect((await registry.bill('EDUCATION', 'WAEC_RESULT')!.purchase({ reference: 'r2', amount: 1, customerId: '08031234567' })).token).toMatch(/^\d{12}$/);
    expect((await registry.bill('FOOD', 'mama-put')!.purchase({ reference: 'r3', amount: 1, customerId: '08031234567' })).token).toMatch(/^ORD-\d{6}$/);
  });

  describe('TV validation (the only category that supports it)', () => {
    it('returns the customer name for a known smart card', async () => {
      const dstv = registry.bill('TV', 'DSTV')!;
      const known = MOCK_TV_CUSTOMERS.DSTV[0];
      expect(await dstv.validateCustomer!(known.iuc)).toEqual({ valid: true, customerName: known.name });
    });

    it('reports unknown cards as invalid', async () => {
      expect(await registry.bill('TV', 'GOTV')!.validateCustomer!('9999999999')).toEqual({ valid: false });
    });

    it('is not offered by other categories', () => {
      expect(registry.bill('AIRTIME', 'MTN')!.validateCustomer).toBeUndefined();
      expect(registry.bill('ELECTRICITY', 'IKEDC')!.validateCustomer).toBeUndefined();
    });

    it('refuses to charge an unrecognised smart card', async () => {
      await expect(registry.bill('TV', 'DSTV')!.purchase({ reference: 'r', amount: 1, customerId: '9999999999' })).rejects.toThrow(IntegrationError);
    });
  });

  describe('transfers and identity', () => {
    it('resolves account names deterministically', async () => {
      const a = await registry.transfer.resolveAccount('058', '0123456789');
      const b = await registry.transfer.resolveAccount('058', '0123456789');
      expect(a).toEqual(b);
      expect(a.accountName.length).toBeGreaterThan(3);
    });

    it('fails to resolve numbers ending in 9999 and declines sends to 0000', async () => {
      await expect(registry.transfer.resolveAccount('058', '0123459999')).rejects.toThrow(IntegrationError);
      await expect(registry.transfer.send({ reference: 'r', amount: 1, bankCode: '058', accountNumber: '0123450000', accountName: 'X' })).rejects.toThrow(IntegrationError);
    });

    it('looks up BVNs from the data list', async () => {
      expect((await registry.identity.lookupBvn('22222222221'))?.firstName).toBe('Adaeze');
      expect(await registry.identity.lookupBvn('00000000000')).toBeNull();
    });

    it('accepts only listed 6-digit phone codes', async () => {
      expect(await registry.sms.verifyCode('08031234567', '123456')).toBe(true);
      expect(await registry.sms.verifyCode('08031234567', '654321')).toBe(true);
      expect(await registry.sms.verifyCode('08031234567', '111111')).toBe(false);
    });
  });
});
