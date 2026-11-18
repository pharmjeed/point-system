import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as arMain from '@/i18n/ar';
import * as arStaff from '@/i18n/ar.staff';
import { ERROR_CODES, errorMessagesAr } from '@/i18n/errors';

/**
 * The whole of 02 §8 is in src/i18n/ar.ts, word for word (05 §7.8), and the 08 catalogue covers every
 * canon error code. Parsed from the spec so a text change in 02 fails here until ar.ts follows.
 */
/** The dictionary is split by area (driver first load vs the lazy staff chunks); the checks cover both. */
const ar = { ...arMain, ...arStaff };

const spec = readFileSync(new URL('../../../docs/02_Wireframes_Spec.md', import.meta.url), 'utf8');
const section8 = spec.slice(
  spec.indexOf('## 8. قاموس النصوص المشتركة'),
  spec.indexOf('## 9. إضافات مقترحة للقاموس'),
);

/** "`received` مستلمة · `parking` جارٍ الصف" → [['received','مستلمة'], …] */
function pairs(cell: string): Array<[string, string]> {
  return cell
    .split(' · ')
    .map((part) => /^`([a-z0-9_]+)`\s+(.+)$/.exec(part.trim()))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => [m[1] as string, (m[2] as string).replace(/\s*\(نص حر\)\s*$/, '').trim()]);
}

function row(identifier: string): string {
  const line = section8.split('\n').find((l) => l.startsWith(`| ${identifier} |`));
  if (!line) throw new Error(`row ${identifier} not in 02 §8`);
  return line.split(' | ')[1]?.replace(/\s*\|\s*$/, '') ?? '';
}

const TABLES: Array<[string, Record<string, string>]> = [
  ['`tickets.status`', ar.ticketStatus],
  ['`driver_state`', ar.driverState],
  ['`connection_state`', ar.connectionState],
  ['`tasks.status`', ar.taskStatus],
  ['`tasks.type`', ar.taskType],
  ['`wa_link_status`', ar.waLinkStatus],
  ['`inspection_status`', ar.inspectionStatus],
  ['`payment_status`', ar.paymentStatus],
  ['`payments.method`', ar.paymentMethod],
  ['`whatsapp_messages.status`', ar.waMessageStatus],
  ['`events.status`', ar.eventStatus],
  ['`shifts.status`', ar.shiftStatus],
  ['`driver_transfers.status`', ar.transferStatus],
  ['`users.status`', ar.userStatus],
  ['`incidents.status`', ar.incidentStatus],
  ['`alerts.status`', ar.alertStatus],
  ['`alerts.type`', ar.alertType],
  ['`incidents.type`', ar.incidentType],
  ['`custody_events.reason`', ar.custodyReason],
  ['`media_assets.kind`', ar.mediaKind],
];

describe('02 §8 dictionary in ar.ts', () => {
  it.each(TABLES.map(([id, dict]) => [id, dict] as const))('%s', (id, dict) => {
    const expected = pairs(row(id));
    expect(expected.length).toBeGreaterThan(1);
    expect(Object.entries(dict)).toEqual(expected);
  });

  it('`incidents.severity` · `alerts.severity`', () => {
    const [incident, alert] = row('`incidents.severity` · `alerts.severity`').split(' — ');
    expect(Object.entries(ar.incidentSeverity)).toEqual(pairs(incident ?? ''));
    expect(Object.entries(ar.alertSeverity)).toEqual(pairs(alert ?? ''));
  });

  it('custody holders (with placeholders)', () => {
    const expected = pairs(row('الحائز')).map(([k, v]) => [
      k,
      v.replace('{الاسم}', '{name}').replace('{رقم}', '{label}'),
    ]);
    expect(Object.entries(ar.custodyHolder)).toEqual(expected);
  });

  it('§8.3 repeated buttons', () => {
    const line = section8.split('\n').find((l) => l.startsWith('«متابعة»')) ?? '';
    const labels = [...line.matchAll(/«([^»]+)»/g)].map((m) => m[1]);
    expect(Object.values(ar.buttons)).toEqual(labels);
  });

  it.each([
    ['الألوان', ar.vehicleColor],
    ['الشركات الشائعة', ar.vehicleMake],
    ['أسباب الطلب نيابة عن العميل', ar.onBehalfReason],
  ] as const)('§8.4 %s', (title, dict) => {
    const line = section8.split('\n').find((l) => l.startsWith(`- **${title}`)) ?? '';
    const list = line.slice(line.indexOf(':**') + 3).replace(/\.\s*$/, '');
    expect(Object.entries(dict)).toEqual(pairs(list));
  });
});

describe('error texts (08 §4)', () => {
  it('cover every canon error code from 07_openapi.yaml', () => {
    const yaml = readFileSync(new URL('../../../docs/07_openapi.yaml', import.meta.url), 'utf8');
    const block = yaml.slice(yaml.indexOf('\n    ErrorCode:'));
    const list = block.slice(block.indexOf('enum: [') + 'enum: ['.length, block.indexOf(']'));
    const canon = list.split(',').map((c) => c.trim());
    expect(canon.length).toBeGreaterThan(90);
    expect([...ERROR_CODES].sort()).toEqual([...canon].sort());
    // Webhook-only codes are answered to Meta, never shown in the UI: 08 gives them no Arabic text («—»).
    const webhookOnly = [
      'WA_WEBHOOK_SIGNATURE_INVALID',
      'WA_WEBHOOK_VERIFY_FAILED',
      'PAYMENT_WEBHOOK_SIGNATURE_INVALID', // answered to the payment gateway (V2-021)
      'EINVOICE_WEBHOOK_SIGNATURE_INVALID', // answered to the e-invoicing provider (V2-040)
    ];
    for (const code of ERROR_CODES) {
      if (webhookOnly.includes(code)) expect(errorMessagesAr[code]).toBe('—');
      else expect(errorMessagesAr[code].length, code).toBeGreaterThan(5);
    }
  });

  it('never names a brand (canon §1)', () => {
    const all = JSON.stringify(ar) + JSON.stringify(errorMessagesAr);
    expect(all).not.toContain('بوينت');
    expect(all).not.toContain('مصاف');
  });
});
