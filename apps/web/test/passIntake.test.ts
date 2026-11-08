import { describe, expect, it } from 'vitest';
import { dueOf, entitlementBadgeOf } from '@/features/common/entitlement';
import {
  channelBody,
  channelForm,
  channelIssues,
  DEFAULT_CHANNEL_FORM,
  linkActions,
  linkBody,
  linkMode,
  needsQrAtSubmit,
} from '@/features/driver/linkModel';
import { cameraProblemOf, passTokenOf } from '@/features/driver/passScan';
import { d05, entitlementBadge } from '@/i18n/ar';
import { s03 } from '@/i18n/ar.staff';

/**
 * V2-013 / V2-014 on the staff app: «مسح بطاقة العميل» in D-05 (O-01) and the entitlement badge of D-05, D-10/D-11
 * and S-03 (O-02). The camera and the decoder are covered by e2e/driver-pass-scan.spec.ts; these are the rules.
 */
const TOKEN = 'P1.D5wrfj1BSluMbX6PmgscLQ.WmJ8jZ4PShuMLT5PWmt8jQ.59434520.Ms0tUo6SXfOVXZ2Pdjw';

describe('passTokenOf', () => {
  it('keeps an entry pass and drops other QR texts', () => {
    expect(passTokenOf(`  ${TOKEN}\n`)).toBe(TOKEN);
    expect(passTokenOf('https://wa.me/9665?text=%D8%B1%D8%A8%D8%B7')).toBeNull();
    expect(passTokenOf('P1.only.three')).toBeNull();
    expect(passTokenOf(`${TOKEN}${'x'.repeat(100)}`)).toBeNull();
    expect(passTokenOf(null)).toBeNull();
  });

  it('tells a refused permission from a missing camera', () => {
    expect(cameraProblemOf({ name: 'NotAllowedError' })).toBe('denied');
    expect(cameraProblemOf({ name: 'SecurityError' })).toBe('denied');
    expect(cameraProblemOf({ name: 'NotFoundError' })).toBe('unavailable');
    expect(cameraProblemOf(new Error('x'))).toBe('unavailable');
  });
});

describe('the app channel in the D-05 form and D-07', () => {
  const app = { ...DEFAULT_CHANNEL_FORM, channel: 'app' as const };
  it('sends nothing about the channel and asks for nothing', () => {
    expect(channelBody(app, null)).toEqual({});
    expect(channelIssues(app, null)).toEqual([]);
  });

  it('starts from the server’s app ticket, and the device’s later choice wins', () => {
    const t = { channel: 'app' as const, paper_serial: null, customer: { phone_masked: '05•••••123' } };
    expect(channelForm(t, {}).channel).toBe('app');
    expect(channelForm(t, { channel: 'whatsapp' }).channel).toBe('whatsapp');
    // leaving the app channel sends the normal WhatsApp body (the server unlinks the account)
    expect(channelBody({ ...app, channel: 'whatsapp', method: 'qr' }, null)).toMatchObject({
      channel: 'whatsapp',
      customer_phone: null,
    });
  });

  it('D-07 shows the app note and offers no WhatsApp action; no QR at the submit', () => {
    const t = {
      status: 'parking' as const,
      channel: 'app' as const,
      wa_link_status: 'none' as const,
      customer: null,
    };
    expect(linkMode(t, undefined, false)).toBe('app');
    expect(linkBody('app', 'none')).toBe('app');
    expect(linkActions(t)).toEqual({ resend: false, qr: false, paper: false });
    expect(needsQrAtSubmit(t)).toBe(false);
  });

  it('has its copy (driver screens in ar.ts, S-03 in ar.staff.ts)', () => {
    expect(d05.pass.scan).toBe('مسح بطاقة العميل');
    expect(d05.channels.app).toBeTruthy();
    expect(s03.channelName.app).toBeTruthy();
  });
});

describe('entitlementBadgeOf (O-02)', () => {
  it('«مشمول» for an included event, a subscription or an app payment', () => {
    expect(entitlementBadgeOf('event_included', null)).toEqual({
      tone: 'included',
      text: entitlementBadge.included,
    });
    expect(entitlementBadgeOf('subscription', null)?.text).toBe(entitlementBadge.subscription);
    expect(entitlementBadgeOf('app_paid', { amountHalalas: 2000 })?.text).toBe(entitlementBadge.appPaid);
    // V2-022 (O-03, DEC-522): a visit paid in the app is `collected` with `app_paid`: D-11 shows «مدفوع في
    // التطبيق» and asks for no cash (nothing is due)
    const paid = { payment_status: 'collected', fee_halalas: 2000 };
    expect(dueOf(paid)).toBeNull();
    expect(entitlementBadgeOf('app_paid', dueOf(paid))).toEqual({
      tone: 'included',
      text: entitlementBadge.appPaid,
    });
  });

  it('«يدفع X» while the fee is due, nothing once it is not', () => {
    const b = entitlementBadgeOf('none', { amountHalalas: 2000 });
    expect(b?.tone).toBe('pays');
    expect(b?.text).toMatch(/^يدفع 20[.,]00/);
    expect(entitlementBadgeOf('none', null)).toBeNull();
    expect(entitlementBadgeOf(undefined, { amountHalalas: 0 })).toBeNull();
    expect(dueOf({ payment_status: 'due', fee_halalas: 2000 })).toEqual({ amountHalalas: 2000 });
    expect(dueOf({ payment_status: 'collected', fee_halalas: 2000 })).toBeNull();
    // the intake driver sees the due state without the fee (09 §5.1)
    expect(entitlementBadgeOf('none', dueOf({ payment_status: 'due' }))).toEqual({
      tone: 'pays',
      text: entitlementBadge.paysAtHandover,
    });
  });
});
