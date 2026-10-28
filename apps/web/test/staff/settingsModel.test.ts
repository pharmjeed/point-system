import { describe, expect, it } from 'vitest';
import type { OrgSettings } from '@/api/types';
import {
  boundError,
  formFromSettings,
  orgSettingsBody,
  parseWhole,
  retentionBody,
  validateOrgSettings,
  validateRetention,
} from '@/features/admin/settingsModel';

/** S-13 «إعدادات المؤسسة» and «سياسة الاحتفاظ» (PNT-091, DEC-39, DEC-65/66). */
const SETTINGS: OrgSettings = {
  security: {
    supervisor_mfa_required: true,
    driver_session_hours: 14,
    staff_session_hours: 12,
    max_login_attempts: 5,
    admin_idle_minutes: 30,
    reveal_phone_per_hour: 20,
  },
  heartbeat: { interval_s: 15, uncertain_after_s: 45, offline_after_s: 120 },
  updated_at: '2026-10-01T09:00:00Z',
};

const RULE = 'الفاصل أقل من حد «غير مؤكد»، وحد «غير مؤكد» أقل من حد «منقطع».';

describe('organization settings form', () => {
  it('round-trips the reply (no pin_length, numbers back)', () => {
    const form = formFromSettings(SETTINGS);
    expect(form.heartbeat.interval_s).toBe('15');
    expect(validateOrgSettings(form)).toEqual({});
    expect(orgSettingsBody(form)).toEqual({ security: SETTINGS.security, heartbeat: SETTINGS.heartbeat });
  });

  it('accepts Arabic-Indic digits and rejects what is not a whole number', () => {
    expect(parseWhole('١٥')).toBe(15);
    expect(parseWhole(' 30 ')).toBe(30);
    expect(parseWhole('1.5')).toBeNull();
    expect(parseWhole('')).toBeNull();
    expect(parseWhole('-3')).toBeNull();
  });

  it('checks the minimums of 07 OrgSettings on the dotted field of the API', () => {
    const form = formFromSettings(SETTINGS);
    form.security.max_login_attempts = '2';
    form.security.admin_idle_minutes = 'abc';
    form.heartbeat.offline_after_s = '20';
    expect(validateOrgSettings(form)).toEqual({
      'security.max_login_attempts': 'الحد الأدنى 3',
      'security.admin_idle_minutes': 'أدخل عددًا صحيحًا.',
      'heartbeat.offline_after_s': 'الحد الأدنى 30',
      'heartbeat.uncertain_after_s': RULE,
    });
  });

  it('rejects a bad heartbeat order inline (interval < uncertain < offline)', () => {
    const form = formFromSettings(SETTINGS);
    form.heartbeat = { interval_s: '15', uncertain_after_s: '150', offline_after_s: '120' };
    expect(validateOrgSettings(form)).toEqual({
      'heartbeat.uncertain_after_s': RULE,
      'heartbeat.offline_after_s': RULE,
    });
    form.heartbeat = { interval_s: '60', uncertain_after_s: '45', offline_after_s: '120' };
    expect(validateOrgSettings(form)).toEqual({
      'heartbeat.uncertain_after_s': RULE,
      'heartbeat.interval_s': RULE,
    });
    form.heartbeat = { interval_s: '45', uncertain_after_s: '45', offline_after_s: '120' };
    expect(Object.keys(validateOrgSettings(form))).toContain('heartbeat.uncertain_after_s');
  });
});

describe('retention policy form', () => {
  it('keeps every duration between 1 and 100 years', () => {
    const form = {
      photos_days: '90',
      wa_messages_days: '0',
      tickets_months: '1201',
      audit_months: '24',
      wa_raw_days: '٣٠',
      analytics_months: '',
    };
    expect(validateRetention(form)).toEqual({
      wa_messages_days: 'الحد الأدنى 1',
      tickets_months: 'الحد الأعلى 1200',
      analytics_months: 'أدخل عددًا صحيحًا.',
    });
    expect(
      retentionBody({ ...form, wa_messages_days: '30', tickets_months: '24', analytics_months: '12' }),
    ).toEqual({
      photos_days: 90,
      wa_messages_days: 30,
      tickets_months: 24,
      audit_months: 24,
      wa_raw_days: 30,
      analytics_months: 12,
    });
  });

  it('boundError reports min before max', () => {
    expect(boundError('0', { min: 1, max: 10 })).toBe('الحد الأدنى 1');
    expect(boundError('11', { min: 1, max: 10 })).toBe('الحد الأعلى 10');
    expect(boundError('10', { min: 1, max: 10 })).toBeNull();
  });
});
