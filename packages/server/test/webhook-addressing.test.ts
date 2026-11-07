import { describe, expect, it } from 'vitest';
import { addressedChannel } from '../src/modules/whatsapp/application/webhook-intake.js';
import type { ChannelRow } from '../src/modules/whatsapp/infra/channel.js';

/**
 * V2-007 / DEC-475: several operators' channels verify the same delivery when they share the platform's Meta app
 * secret; the delivery is stored for the operator whose number (or business account) it names.
 */
const ch = (org: string, phone: string, waba: string) =>
  ({ id: `ch-${org}`, org_id: org, phone_number_id: phone, business_account_id: waba }) as ChannelRow;
const A = ch('A', 'PHONE-A', 'WABA-A');
const B = ch('B', 'PHONE-B', 'WABA-B');
const body = (entry: unknown[]) =>
  Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry }));
const messages = (waba: string, phone: string) => ({
  id: waba,
  changes: [{ field: 'messages', value: { metadata: { phone_number_id: phone }, messages: [] } }],
});

describe('addressedChannel', () => {
  it('picks the channel of the number the delivery names, whatever the order of the channels', () => {
    expect(addressedChannel([A, B], body([messages('WABA-B', 'PHONE-B')]))).toBe(B);
    expect(addressedChannel([B, A], body([messages('WABA-A', 'PHONE-A')]))).toBe(A);
  });

  it('account-level fields (no number) go to the channel of the business account', () => {
    const tpl = {
      id: 'WABA-B',
      changes: [{ field: 'message_template_status_update', value: { event: 'APPROVED' } }],
    };
    expect(addressedChannel([A, B], body([tpl]))).toBe(B);
  });

  it('a body that names no verified channel (or is not JSON) keeps the first one', () => {
    expect(addressedChannel([A, B], body([messages('WABA-X', 'PHONE-X')]))).toBe(A);
    expect(addressedChannel([A, B], Buffer.from('not json'))).toBe(A);
    expect(addressedChannel([], body([]))).toBeNull();
  });
});
