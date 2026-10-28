import { describe, expect, it } from 'vitest';
import { ApiError } from '@/api/errors';
import { staffKeys, withQuery } from '@/features/supervisor/staffApi';
import { fieldErrorsOf } from '@/features/supervisor/useStaffCommand';

describe('staff API helpers', () => {
  it('repeats array query values (OpenAPI form/explode), comma lists where 07 asks for them', () => {
    expect(
      withQuery('/v1/alerts', { status: ['open', 'acknowledged'], venue_id: undefined, limit: 200 }),
    ).toBe('/v1/alerts?status=open&status=acknowledged&limit=200');
    expect(
      withQuery('/v1/tickets', { status: ['parked', 'ready'], q: '' }, { commaArrays: ['status'] }),
    ).toBe('/v1/tickets?status=parked%2Cready');
    expect(withQuery('/v1/x', { a: null, b: [], c: false })).toBe('/v1/x?c=false');
  });

  it('keys nest so a realtime event can invalidate a whole family (ticket → its timeline, boards)', () => {
    expect(staffKeys.timeline('t-1').slice(0, 3)).toEqual(staffKeys.ticket('t-1'));
    expect(staffKeys.board('e-1').slice(0, 2)).toEqual(staffKeys.boards());
    expect(staffKeys.alerts({ status: ['open'] }).slice(0, 2)).toEqual(staffKeys.alerts());
    expect(staffKeys.reconciliation('e-1').slice(0, 3)).toEqual(staffKeys.event('e-1'));
    for (const key of [staffKeys.venues(), staffKeys.orgSettings(), staffKeys.incident('i-1')])
      expect(key[0]).toBe('staff');
  });

  it('maps VALIDATION_FAILED fields (dotted paths) and REASON_REQUIRED to inputs', () => {
    const validation = ApiError.fromBody(
      {
        code: 'VALIDATION_FAILED',
        message: 'x',
        message_ar: 'تحقق من الحقول المظللة.',
        request_id: 'r',
        retryable: false,
        details: {
          fields: [
            { field: 'heartbeat.uncertain_after_s', issue: 'order', message_ar: 'الترتيب غير صحيح' },
            { field: 'security.max_login_attempts', issue: 'min' },
          ],
        },
      },
      422,
      null,
    );
    expect(fieldErrorsOf(validation)).toEqual({
      'heartbeat.uncertain_after_s': 'الترتيب غير صحيح',
      'security.max_login_attempts': 'تحقق من الحقول المظللة.',
    });
    const reason = ApiError.fromBody(
      { code: 'REASON_REQUIRED', message: 'x', message_ar: 'اكتب السبب.', request_id: 'r', retryable: false },
      422,
      null,
    );
    expect(fieldErrorsOf(reason)).toEqual({ reason: 'اكتب السبب.' });
    const phone = ApiError.fromBody(
      {
        code: 'PHONE_INVALID',
        message: 'x',
        message_ar: 'رقم الجوال غير صحيح.',
        request_id: 'r',
        retryable: false,
        details: { field: 'phone' },
      },
      422,
      null,
    );
    expect(fieldErrorsOf(phone)).toEqual({ phone: 'رقم الجوال غير صحيح.' });
    expect(fieldErrorsOf(new Error('x'))).toEqual({});
  });
});
