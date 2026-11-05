import { BadRequestError } from '../../src/errors/app.errors';
import { normaliseIp, validateAllowlist } from '../../src/services/apiKey.service';
import { generateApiKey, sha256 } from '../../src/utils/crypto.util';

describe('API key helpers', () => {
  it('normalises IPv4-mapped IPv6 addresses', () => {
    expect(normaliseIp('::ffff:41.58.1.9')).toBe('41.58.1.9');
    expect(normaliseIp(' 41.58.1.9 ')).toBe('41.58.1.9');
    expect(normaliseIp('2001:DB8::1')).toBe('2001:db8::1');
  });

  it('validates and de-duplicates allowlists', () => {
    expect(validateAllowlist(['41.58.1.9', '::ffff:41.58.1.9', '2001:db8::1'])).toEqual(['41.58.1.9', '2001:db8::1']);
  });

  it.each([[[]], [['not-an-ip']], [['41.58.1.9', '999.1.1.1']], [['41.58.1.0/24']]])('rejects %p', (ips) => {
    expect(() => validateAllowlist(ips as string[])).toThrow(BadRequestError);
  });

  it('generates keys whose hash, not value, is stored', () => {
    const { key, prefix, hash } = generateApiKey();
    expect(key).toMatch(/^sk_live_[0-9a-f]{48}$/);
    expect(key.startsWith(prefix)).toBe(true);
    expect(hash).toBe(sha256(key));
    expect(hash).not.toContain(key);
    expect(generateApiKey().key).not.toBe(key);
  });
});
