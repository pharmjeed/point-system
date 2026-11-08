import { describe, expect, it } from 'vitest';
import { base32Decode, totp } from '../e2e/support/totp';

/** The e2e live sign-in computes the seeded MFA accounts' codes (RFC 6238 appendix B, SHA-1, last 6 digits). */
describe('TOTP of the e2e live sign-in', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // base32 of "12345678901234567890"

  it('decodes base32', () => {
    expect(base32Decode(secret).toString('ascii')).toBe('12345678901234567890');
  });

  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ])('T = %i s → %s', (seconds, code) => {
    expect(totp(secret, seconds * 1000)).toBe(code);
  });
});
