import { describe, expect, it } from 'vitest';
import { maskPhone, normalizeSaudiMobile } from '@/lib/phone';
import { isWeakPin, isSixDigitPin, isLongEnoughPassword } from '@/lib/secretPolicy';

describe('normalizeSaudiMobile (03 §3.8, 07 §1.8)', () => {
  it.each([
    ['0551234567', '+966551234567'],
    ['551234567', '+966551234567'],
    ['+966551234567', '+966551234567'],
    ['966551234567', '+966551234567'],
    ['00966551234567', '+966551234567'],
    ['055 123 4567', '+966551234567'],
    ['055-123-4567', '+966551234567'],
    ['٠٥٥١٢٣٤٥٦٧', '+966551234567'],
  ])('%s → %s', (input, e164) => {
    expect(normalizeSaudiMobile(input)).toBe(e164);
  });

  it.each(['', '123', '0451234567', '05512345678', '+971551234567', 'abc'])('rejects %s', (input) => {
    expect(normalizeSaudiMobile(input)).toBeNull();
  });
});

describe('maskPhone (02 §1.2)', () => {
  it('masks to 05•••••123 and keeps an already masked value', () => {
    expect(maskPhone('+966551234123')).toBe('05•••••123');
    expect(maskPhone('0551234123')).toBe('05•••••123');
    expect(maskPhone('05•••••567')).toBe('05•••••567');
  });
});

describe('secret pre-checks (09 §9.1)', () => {
  it('accepts exactly six digits and flags repeated or sequential PINs', () => {
    expect(isSixDigitPin('482915')).toBe(true);
    expect(isSixDigitPin('48291')).toBe(false);
    expect(isWeakPin('111111')).toBe(true);
    expect(isWeakPin('123456')).toBe(true);
    expect(isWeakPin('987654')).toBe(true);
    expect(isWeakPin('482915')).toBe(false);
  });

  it('requires 12 characters for staff passwords', () => {
    expect(isLongEnoughPassword('short-pass')).toBe(false);
    expect(isLongEnoughPassword('a-long-passphrase')).toBe(true);
  });
});
