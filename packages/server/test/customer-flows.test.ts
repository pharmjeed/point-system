import { createHmac } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claimCodeHash } from '../src/modules/tickets-custody/application/claim-codes.js';
import { claimedChecks, identityMethods } from '../src/use-cases/customer-flows/handover-exception.js';

const fields = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return (e as { code: string; details: { fields: unknown } }).details.fields;
  }
  throw new Error('expected a VALIDATION_FAILED');
};

describe('handover exception identity checks (PNT-078; 07, 02 S-03, 00 §4ز)', () => {
  it('needs two independent checks: the plate alone is never enough', () => {
    expect(fields(() => identityMethods({ plate_confirmed: true }, '+966551234567'))).toEqual([
      { field: 'identity_checks', issue: 'insufficient_checks', min_checks: 2 },
    ]);
    expect(identityMethods({ plate_confirmed: true, vehicle_description_confirmed: true }, null)).toEqual([
      'plate',
      'vehicle_description',
    ]);
    expect(
      identityMethods({ document_note: 'اطّلعت على الهوية', phone_last4: '4567' }, '+966551234567'),
    ).toEqual(['phone_last4', 'document']);
  });

  it('phone_last4 counts only when it matches the stored number; a blank note and false flags count nothing', () => {
    expect(
      fields(() => identityMethods({ phone_last4: '1111', plate_confirmed: true }, '+966551234567')),
    ).toEqual([{ field: 'identity_checks.phone_last4', issue: 'mismatch' }]);
    expect(fields(() => identityMethods({ phone_last4: '4567', plate_confirmed: true }, null))).toEqual([
      { field: 'identity_checks.phone_last4', issue: 'no_customer_phone' },
    ]);
    expect(
      fields(() =>
        identityMethods(
          { plate_confirmed: true, vehicle_description_confirmed: false, document_note: '   ' },
          null,
        ),
      ),
    ).toEqual([{ field: 'identity_checks', issue: 'insufficient_checks', min_checks: 2 }]);
    expect(claimedChecks({ phone_last4: '0000', plate_confirmed: true, document_note: ' ' })).toBe(2);
    expect(claimedChecks({})).toBe(0);
  });
});

describe('claim code hash (11 §5.1: HMAC-SHA256(CODE_PEPPER, cycle_id:code))', () => {
  it('binds the code to its cycle', () => {
    const pepper = 'pepper';
    expect(claimCodeHash(pepper, 'c1', '123456')).toBe(
      createHmac('sha256', pepper).update('c1:123456').digest('hex'),
    );
    expect(claimCodeHash(pepper, 'c2', '123456')).not.toBe(claimCodeHash(pepper, 'c1', '123456'));
  });
});

/** 04 §4.3: whatsapp never calls dispatch (rule 3) nor the use-cases; tickets-custody never imports whatsapp. */
describe('module boundaries of the S3 flows', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
    });
  const offenders = (module: string, pattern: RegExp) =>
    files(join(import.meta.dirname, `../src/modules/${module}`)).filter((f) =>
      pattern.test(readFileSync(f, 'utf8')),
    );

  it('whatsapp imports neither dispatch nor the use-cases', () => {
    expect(offenders('whatsapp', /from '[^']*(modules\/dispatch|\/dispatch\/|use-cases)[^']*'/)).toEqual([]);
  });
  it('tickets-custody does not import whatsapp', () => {
    expect(offenders('tickets-custody', /from '[^']*whatsapp[^']*'/)).toEqual([]);
  });
});
