/**
 * PNT-005 AC1: the backtick values of canon §4–§14ب are extracted from docs/00_Glossary_Canon.md
 * and compared with the exported lists. Any difference — a value, its order, a list the canon adds
 * or one we export that the canon dropped — fails.
 */
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as shared from '../src/index.js';
import {
  ACTIVE_MOVEMENT_TASK_STATUSES,
  DOMAIN_EVENT_TYPES,
  DRIVE_PERMISSIONS,
  DRIVER_SCREEN_IDS,
  ERROR_CATALOG,
  ERROR_CODES,
  JOB_TYPES,
  LOCK_LEVEL_TABLES,
  LOCK_LEVELS,
  OPEN_TASK_STATUSES,
  OPEN_TICKET_STATUSES,
  PERMISSION_MATRIX,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  ROOM_PATTERNS,
  SCREEN_TITLES_AR,
  SOUND_IDS,
  SOUNDS,
  SUPERVISOR_SCREEN_IDS,
  TABLE_NAMES,
  TASK_STATUSES,
  TERMINAL_TASK_STATUSES,
  TERMINAL_TICKET_STATUSES,
  TICKET_STATUSES,
  WA_MESSAGE_IDS,
  WA_MESSAGE_STATUS_RANK,
  WA_TEMPLATES,
  WS_CLIENT_EVENTS,
  WS_SERVER_EVENTS,
  errorBodySchema,
  eventEnvelopeSchema,
} from '../src/index.js';
import type { PermissionGrant } from '../src/index.js';
import { z } from 'zod';
import { backticks, labeledLists, readDoc, repoPath, section, stripParens, tableRows } from './docs.js';

const canon = readDoc('00_Glossary_Canon.md');

/** Canon list label (§4–§5) → name of the exported const in @point/shared. */
const ENUM_LISTS: Record<string, string> = {
  // §4
  'users.role': 'ROLES',
  actor_type: 'ACTOR_TYPES',
  'role_scopes.scope_type': 'SCOPE_TYPES',
  // §5.1 (the table) and its terminal statuses
  'tickets.status': 'TICKET_STATUSES',
  'الحالات النهائية': 'TERMINAL_TICKET_STATUSES',
  // §5.2
  'tickets.channel': 'TICKET_CHANNELS',
  'tickets.entitlement': 'TICKET_ENTITLEMENTS',
  'tickets.wa_link_status': 'WA_LINK_STATUSES',
  'tickets.inspection_status': 'INSPECTION_STATUSES',
  'tickets.payment_status': 'PAYMENT_STATUSES',
  'tickets.vehicle_holder_type': 'VEHICLE_HOLDER_TYPES',
  'tickets.key_holder_type': 'KEY_HOLDER_TYPES',
  // §5.3
  request_source: 'REQUEST_SOURCES',
  outcome: 'CYCLE_OUTCOMES',
  // §5.4
  type: 'TASK_TYPES',
  status: 'TASK_STATUSES',
  // §5.5
  'task_offers.mode': 'OFFER_MODES',
  'task_offers.status': 'OFFER_STATUSES',
  'task_offers.close_reason': 'OFFER_CLOSE_REASONS',
  'offer_recipients.eligible_as': 'OFFER_ELIGIBILITIES',
  'offer_recipients.response': 'OFFER_RESPONSES',
  // §5.6 (the table) and the connection indicator
  driver_state: 'DRIVER_STATES',
  'duty_sessions.connection_state': 'CONNECTION_STATES',
  // §5.7
  'events.status': 'EVENT_STATUSES',
  'events.pricing_mode': 'PRICING_MODES',
  'shifts.status': 'SHIFT_STATUSES',
  'duty_sessions.status': 'DUTY_STATUSES',
  'users.status': 'USER_STATUSES',
  'users.secret_kind': 'SECRET_KINDS',
  'driver_assignments.status': 'ASSIGNMENT_STATUSES',
  'driver_transfers.status': 'TRANSFER_STATUSES',
  'link_codes.status': 'LINK_CODE_STATUSES',
  'payments.method': 'PAYMENT_METHODS',
  'payments.status': 'PAYMENT_RECORD_STATUSES',
  'incidents.type': 'INCIDENT_TYPES',
  'incidents.status': 'INCIDENT_STATUSES',
  'incidents.severity': 'INCIDENT_SEVERITIES',
  'alerts.status': 'ALERT_STATUSES',
  'alerts.severity': 'ALERT_SEVERITIES',
  'alerts.type': 'ALERT_TYPES',
  'customer_consents.method': 'CONSENT_METHODS',
  'customer_consents.revoke_source': 'CONSENT_REVOKE_SOURCES',
  'custody_events.subject': 'CUSTODY_SUBJECTS',
  'custody_events.reason': 'CUSTODY_REASONS',
  'media_assets.kind': 'MEDIA_KINDS',
  'media_assets.upload_status': 'MEDIA_UPLOAD_STATUSES',
  'whatsapp_messages.direction': 'WA_DIRECTIONS',
  'whatsapp_messages.status': 'WA_MESSAGE_STATUSES',
  'notifications.channel': 'NOTIFICATION_CHANNELS',
  'notifications.status': 'NOTIFICATION_STATUSES',
  'outbox_events.status': 'OUTBOX_STATUSES',
  'devices.notification_permission': 'NOTIFICATION_PERMISSIONS',
  'devices.display_mode': 'DISPLAY_MODES',
  'devices.audio_test_result': 'AUDIO_TEST_RESULTS',
  'devices.platform': 'DEVICE_PLATFORMS',
  'auth_sessions.revoked_reason': 'SESSION_REVOKED_REASONS',
  'duty_sessions.end_reason': 'DUTY_END_REASONS',
  'tickets.vehicle_type': 'VEHICLE_TYPES',
  'media_assets.content_type': 'MEDIA_CONTENT_TYPES',
  'حالة كيانات الإعداد': 'SETUP_STATUSES',
  'tasks.cancel_reason': 'TASK_CANCEL_REASONS',
  'retrieval_cycles.handover_method': 'HANDOVER_METHODS',
  'link_codes.revoke_reason': 'LINK_CODE_REVOKE_REASONS',
  'claim_codes.revoke_reason': 'CLAIM_CODE_REVOKE_REASONS',
  'spot_allocations.release_reason': 'SPOT_RELEASE_REASONS',
  'key_slot_allocations.release_reason': 'KEY_SLOT_RELEASE_REASONS',
  'whatsapp_channel.mode': 'WA_CHANNEL_MODES',
  'whatsapp_channel.health_status': 'WA_HEALTH_STATUSES',
  'whatsapp_templates.category': 'WA_TEMPLATE_CATEGORIES',
  'whatsapp_templates.status': 'WA_TEMPLATE_STATUSES',
  'whatsapp_messages.kind': 'WA_MESSAGE_KINDS',
  'exports.kind': 'EXPORT_KINDS',
  'exports.status': 'EXPORT_STATUSES',
  'أنواع إشعار Push للموظفين = معرّفات الأصوات': 'PUSH_NOTIFICATION_TYPES',
  // §5 extra closed lists from the schema
  'notifications.skipped_reason': 'NOTIFICATION_SKIPPED_REASONS',
  'notification_attempts.outcome': 'NOTIFICATION_ATTEMPT_OUTCOMES',
  'media_assets.delete_reason': 'MEDIA_DELETE_REASONS',
  'vehicle_inspections.kind': 'INSPECTION_KINDS',
  'whatsapp_inbound_events.status': 'WA_INBOUND_EVENT_STATUSES',
  'tickets.pending_retrieval_source': 'PENDING_RETRIEVAL_SOURCES',
  'analytics_events.source': 'ANALYTICS_SOURCES',
  'idempotency_keys.status': 'IDEMPOTENCY_KEY_STATUSES',
  'action_tokens.action': 'ACTION_TOKEN_ACTIONS',
  'customer_consents.channel': 'CONSENT_CHANNELS',
  // §5 API-level values
  'POST /v1/tickets/{ticketId}/whatsapp-link#method': 'WA_LINK_METHODS',
  'POST /v1/tickets/{ticketId}/handover#verification.method': 'HANDOVER_VERIFICATION_METHODS',
  'TicketDetail.projection': 'TICKET_PROJECTIONS',
  'POST /v1/tickets/{ticketId}/manual-reconcile#target_status': 'MANUAL_RECONCILE_TARGET_STATUSES',
  'POST /v1/staff#role': 'STAFF_CREATE_ROLES',
};

/** Canon lines with a colon and backtick values that are prose, not a closed list. */
const NOT_A_LIST = new Set([
  // §5.4: «`expired` is an offer-round status, not a task status» (DEC-11)
  'توضيح على الوثيقة الأصلية',
  // §5 API values: `acknowledge_incomplete_inspection` is a boolean field (DEC-31)
  'POST /v1/tickets/{ticketId}/submit-intake',
]);

function exported(name: string): readonly string[] {
  const value = (shared as Record<string, unknown>)[name];
  if (!Array.isArray(value)) throw new Error(`@point/shared does not export the list ${name}`);
  return value as readonly string[];
}

function canonEnumLists(): { label: string; values: string[] }[] {
  const lists: { label: string; values: string[] }[] = [];
  lists.push(...labeledLists(section(canon, '## 4.')));
  const s5 = section(canon, '## 5.');
  const end = s5.findIndex((l) => l.startsWith('توضيحات:'));
  const body = end >= 0 ? s5.slice(0, end) : s5;
  // §5.1 and §5.6 are tables whose first column holds the values.
  lists.push({
    label: 'tickets.status',
    values: tableRows(section(canon, '### 5.1')).map((r) => backticks(r[0] ?? '')[0] ?? ''),
  });
  lists.push({
    label: 'driver_state',
    values: tableRows(section(canon, '### 5.6')).map((r) => backticks(r[0] ?? '')[0] ?? ''),
  });
  lists.push(...labeledLists(body));
  return lists;
}

describe('canon §4–§5 closed lists', () => {
  const lists = canonEnumLists();

  it('maps every canon list to an export (no unmapped canon list)', () => {
    const unmapped = lists
      .filter((l) => !(l.label in ENUM_LISTS) && !NOT_A_LIST.has(l.label))
      .map((l) => l.label);
    expect(unmapped).toEqual([]);
  });

  it('has no stale mapping (every mapped label still exists in the canon, once)', () => {
    const labels = lists.map((l) => l.label);
    for (const label of Object.keys(ENUM_LISTS)) {
      expect(
        labels.filter((l) => l === label),
        label,
      ).toHaveLength(1);
    }
  });

  for (const { label, values } of canonEnumLists()) {
    if (NOT_A_LIST.has(label)) continue;
    const name = ENUM_LISTS[label];
    it(`${name ?? '?'} equals canon «${label}»`, () => {
      expect(name, `unmapped canon list ${label}`).toBeDefined();
      expect([...exported(name ?? '')]).toEqual(values);
    });
  }

  it('active movement / open task statuses match canon §5.4', () => {
    const line = section(canon, '### 5.4').find((l) => l.includes('«مهمة حركة نشطة»')) ?? '';
    const [active, open] = line.split('«مهمة مفتوحة»');
    expect(backticks(active ?? '')).toEqual([...ACTIVE_MOVEMENT_TASK_STATUSES]);
    // «مهمة مفتوحة» = غير `completed`/`canceled`
    expect(backticks(open ?? '')).toEqual([...TERMINAL_TASK_STATUSES]);
    expect([...OPEN_TASK_STATUSES]).toEqual(TASK_STATUSES.filter((s) => !backticks(open ?? '').includes(s)));
  });

  it('open ticket statuses are exactly the non-terminal ones', () => {
    expect([...OPEN_TICKET_STATUSES]).toEqual(
      TICKET_STATUSES.filter((s) => !(TERMINAL_TICKET_STATUSES as readonly string[]).includes(s)),
    );
  });

  it('whatsapp_messages.status_rank matches canon §5.7', () => {
    const line = section(canon, '### 5.7').find((l) => l.includes('`status_rank`')) ?? '';
    const ranks = Object.fromEntries([...line.matchAll(/(\w+)=(\d+)/g)].map((m) => [m[1], Number(m[2])]));
    expect(ranks).toEqual(WA_MESSAGE_STATUS_RANK);
  });
});

describe('canon §6 tables', () => {
  it('TABLE_NAMES equals the canon table list', () => {
    const names = tableRows(section(canon, '## 6.')).map((r) => backticks(r[1] ?? '')[0]);
    expect([...TABLE_NAMES]).toEqual(names);
  });
});

describe('canon §7 events, jobs, realtime', () => {
  it('DOMAIN_EVENT_TYPES equals §7.1 (all groups, in order)', () => {
    const lists = labeledLists(section(canon, '### 7.1'));
    expect(lists.map((l) => l.label)).toEqual([
      'التذكرة',
      'المهمة',
      'العرض',
      'السائق',
      'العهدة',
      'التسليم',
      'الدفع',
      'التنبيهات والوقائع',
      'الحفل والوردية',
      'واتساب',
    ]);
    expect([...DOMAIN_EVENT_TYPES]).toEqual(lists.flatMap((l) => l.values));
    expect(new Set(DOMAIN_EVENT_TYPES).size).toBe(DOMAIN_EVENT_TYPES.length);
  });

  it('JOB_TYPES equals §7.2', () => {
    const line = section(canon, '### 7.2').find((l) => l.startsWith('`job.')) ?? '';
    expect([...JOB_TYPES]).toEqual(backticks(line));
  });

  it('rooms, server and client events equal §7.3', () => {
    const s = section(canon, '### 7.3');
    const after = (marker: string) => s[s.findIndex((l) => l.startsWith(marker)) + 1] ?? '';
    expect([...ROOM_PATTERNS]).toEqual(backticks(s.find((l) => l.startsWith('`user:')) ?? ''));
    expect([...WS_SERVER_EVENTS]).toEqual(backticks(after('من الخادم إلى العميل')));
    expect([...WS_CLIENT_EVENTS]).toEqual(backticks(stripParens(after('من العميل إلى الخادم'))));
  });

  it('heartbeat payload fields equal §7.3', () => {
    const s = section(canon, '### 7.3');
    const line = s[s.findIndex((l) => l.startsWith('من العميل إلى الخادم')) + 1] ?? '';
    const payload = /\(الحمولة: ([^)]*)\)/.exec(line)?.[1] ?? '';
    const fields = backticks(payload.split('؛')[0] ?? '').map((f) => f.split(':')[0]);
    expect(Object.keys(shared.ClientHeartbeatSchema.shape)).toEqual(fields);
    expect(Object.keys(shared.HttpHeartbeatSchema.shape)).toEqual([...fields, 'ws_connected']);
  });

  it('room helpers follow the canon patterns', () => {
    expect(shared.rooms.user('u1')).toBe('user:u1');
    expect(shared.rooms.poolDrivers('p1')).toBe('pool:p1:drivers');
    expect(shared.rooms.venueSupervisors('v1')).toBe('venue:v1:supervisors');
    expect(shared.rooms.orgAdmins('o1')).toBe('org:o1:admins');
  });

  it('EventEnvelope has exactly the keys of the canon §7 example', () => {
    const json = /```json\n([\s\S]*?)\n```/.exec(section(canon, '## 7.').join('\n'))?.[1] ?? '';
    const example = JSON.parse(json) as Record<string, unknown>;
    const schema = eventEnvelopeSchema(z.record(z.string(), z.unknown()));
    expect(Object.keys(schema.shape).sort()).toEqual(Object.keys(example).sort());
    // The canon example uses "uuid" placeholders; fill them to validate the rest of the shape.
    const fill = (v: unknown): unknown =>
      v === 'uuid'
        ? '0193b6f2-5c1e-7a40-9d2f-6b8e1c0a4f11'
        : v && typeof v === 'object' && !Array.isArray(v)
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]))
          : v;
    expect(schema.parse(fill(example)).type).toBe('task.claimed');
  });
});

describe('canon §8 error codes', () => {
  const rows = tableRows(section(canon, '## 8.'));

  it('ERROR_CODES equals the §8 table (each once, canon order)', () => {
    expect([...ERROR_CODES]).toEqual(rows.map((r) => backticks(r[0] ?? '')[0]));
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });

  it('every code has the §8 HTTP status', () => {
    const http = Object.fromEntries(rows.map((r) => [backticks(r[0] ?? '')[0], Number(r[1])]));
    expect(Object.fromEntries(ERROR_CODES.map((c) => [c, ERROR_CATALOG[c].http]))).toEqual(http);
  });

  it('ErrorBody has exactly the keys of the §8 envelope example', () => {
    const json = /```json\n([\s\S]*?)\n```/.exec(section(canon, '## 8.').join('\n'))?.[1] ?? '';
    const example = JSON.parse(json) as { error: Record<string, unknown> };
    expect(Object.keys(errorBodySchema.shape)).toEqual(Object.keys(example.error));
    expect(errorBodySchema.parse(example.error).code).toBe('TASK_ALREADY_CLAIMED');
  });
});

describe('canon §10 permissions', () => {
  const grant = (cell: string): PermissionGrant => {
    if (cell === '✓') return 'yes';
    if (cell === '—') return 'no';
    if (cell === 'D*') return 'drive';
    throw new Error(`Unknown grant ${cell}`);
  };
  const matrixOf = (lines: string[]) =>
    tableRows(lines).map((r) => ({
      permission: backticks(r[0] ?? '')[0] ?? '',
      row: {
        owner: grant(r[1] ?? ''),
        admin: grant(r[2] ?? ''),
        supervisor: grant(r[3] ?? ''),
        driver: grant(r[4] ?? ''),
      },
    }));
  const rows = matrixOf(section(canon, '## 10.'));

  it('PERMISSIONS equals §10 (canon order)', () => {
    expect([...PERMISSIONS]).toEqual(rows.map((r) => r.permission));
  });

  it('PERMISSION_MATRIX equals §10 cell for cell', () => {
    expect(PERMISSION_MATRIX).toEqual(Object.fromEntries(rows.map((r) => [r.permission, r.row])));
  });

  it('PERMISSION_MATRIX equals the four columns of file 09 §3 too', () => {
    const rows09 = matrixOf(section(readDoc('09_RBAC_Permissions_Matrix.md'), '## 3.'));
    expect(PERMISSION_MATRIX).toEqual(Object.fromEntries(rows09.map((r) => [r.permission, r.row])));
  });

  it('DRIVE_PERMISSIONS = the D* rows (and the set of file 09 §8.2)', () => {
    expect([...DRIVE_PERMISSIONS]).toEqual(
      rows.filter((r) => r.row.supervisor === 'drive').map((r) => r.permission),
    );
    const ref = /const DRIVE_PERMISSIONS = new Set<Permission>\(\[([^\]]*)\]\)/.exec(
      readDoc('09_RBAC_Permissions_Matrix.md'),
    )?.[1];
    expect([...DRIVE_PERMISSIONS]).toEqual([...(ref ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]));
    expect(
      rows.some((r) => r.row.owner === 'drive' || r.row.admin === 'drive' || r.row.driver === 'drive'),
    ).toBe(false);
  });

  it('ROLE_PERMISSIONS holds the ✓ grants of each role', () => {
    for (const role of ['owner', 'admin', 'supervisor', 'driver'] as const) {
      expect([...ROLE_PERMISSIONS[role]]).toEqual(
        rows.filter((r) => r.row[role] === 'yes').map((r) => r.permission),
      );
    }
  });

  it('hasPermission applies D* only to a supervisor with can_drive', () => {
    expect(shared.hasPermission({ role: 'supervisor', canDrive: false }, 'offer.accept')).toBe(false);
    expect(shared.hasPermission({ role: 'supervisor', canDrive: true }, 'offer.accept')).toBe(true);
    expect(shared.hasPermission({ role: 'driver', canDrive: false }, 'offer.accept')).toBe(true);
    expect(shared.hasPermission({ role: 'admin', canDrive: true }, 'offer.accept')).toBe(false);
    expect(shared.hasPermission({ role: 'driver', canDrive: false }, 'ticket.void')).toBe(false);
  });
});

describe('canon §11 WhatsApp messages', () => {
  const rows = tableRows(section(canon, '## 11.'));

  it('WA_TEMPLATES equals §11 row for row', () => {
    const fromCanon = rows.map((r) => ({
      id: r[0],
      name: backticks(r[1] ?? '')[0],
      kind: r[2] === 'قالب' ? 'template' : r[2] === 'جلسة' ? 'session' : `?${r[2]}`,
      purpose_ar: r[3],
      variables: [...(r[4] ?? '').matchAll(/(?:^|،\s*)(\d+)\s/g)].length,
      button: (r[5] ?? '').includes('QUICK_REPLY') ? /«([^»]+)»/.exec(r[5] ?? '')?.[1] : null,
    }));
    expect(
      WA_TEMPLATES.map((t) => ({
        id: t.id,
        name: t.name,
        kind: t.kind,
        purpose_ar: t.purpose_ar,
        variables: t.variables,
        button: t.button?.text ?? null,
      })),
    ).toEqual(fromCanon);
    expect([...WA_MESSAGE_IDS]).toEqual(rows.map((r) => r[0]));
  });

  it('only W-01 has a button, and it is the QUICK_REPLY «طلب السيارة» with the action token', () => {
    expect(WA_TEMPLATES.filter((t) => t.button).map((t) => t.id)).toEqual(['W-01']);
    expect(WA_TEMPLATES[0]?.button).toEqual({
      type: 'QUICK_REPLY',
      text: 'طلب السيارة',
      payload: 'action_token',
    });
  });

  it('§11ب: the v2 set W-01 … W-08 row for row — names, purposes, variables by name, the one button (DEC-555)', () => {
    const v2Rows = tableRows(section(canon, '## 11ب.'));
    const VAR_AR: Record<string, string> = {
      'اسم الموقع': 'venue_name',
      'رقم التذكرة': 'display_number',
      'اسم المشغل': 'operator_name',
      'وصف المركبة': 'vehicle_description',
      الرمز: 'claim_code',
    };
    const fromCanon = v2Rows.map((r) => ({
      id: r[0],
      name: backticks(r[1] ?? '')[0],
      kind: r[2] === 'قالب' ? 'template' : `?${r[2]}`,
      purpose_ar: r[3],
      variable_names: (r[4] ?? '').split('،').map((v) => VAR_AR[v.trim().replace(/^\d+\s+/, '')] ?? v),
      button: (r[5] ?? '').includes('QUICK_REPLY') ? /«([^»]+)»/.exec(r[5] ?? '')?.[1] : null,
    }));
    expect(
      shared.WA_TEMPLATES_V2.filter((t) => t.kind === 'template').map((t) => ({
        id: t.id,
        name: t.name,
        kind: t.kind,
        purpose_ar: t.purpose_ar,
        variable_names: [...t.variable_names],
        button: t.button?.text ?? null,
      })),
    ).toEqual(fromCanon);
    expect(fromCanon.map((r) => r.name)).toEqual([...shared.WA_TEMPLATE_NAMES_V2]);
    // the same purposes as §11, message by message
    expect(fromCanon.map((r) => [r.id, r.purpose_ar])).toEqual(
      rows.filter((r) => r[2] === 'قالب').map((r) => [r[0], r[3]]),
    );
  });

  it('template names and session reply names partition §11', () => {
    expect([...shared.WA_TEMPLATE_NAMES, ...shared.WA_SESSION_REPLY_NAMES]).toEqual(
      WA_TEMPLATES.map((t) => t.name),
    );
    expect(WA_TEMPLATES.filter((t) => t.kind === 'template').every((t) => t.category === 'UTILITY')).toBe(
      true,
    );
  });
});

describe('canon §12 settings keys', () => {
  it('VENUE_SETTING_KEYS / ORG_SETTING_KEYS equal §12 (canon order)', () => {
    const lines = section(canon, '## 12.');
    const orgStart = lines.findIndex((l) => l.includes('`organizations.settings`'));
    const keys = (part: string[]) => tableRows(part).map((r) => backticks(r[0] ?? '')[0]);
    expect([...shared.VENUE_SETTING_KEYS]).toEqual(keys(lines.slice(0, orgStart)));
    expect([...shared.ORG_SETTING_KEYS]).toEqual(keys(lines.slice(orgStart)));
  });
});

describe('canon §13 sounds', () => {
  const rows = tableRows(section(canon, '## 13.'));

  it('SOUND_IDS and files equal §13', () => {
    expect([...SOUND_IDS]).toEqual(rows.map((r) => backticks(r[0] ?? '')[0]));
    for (const r of rows) {
      const id = backticks(r[0] ?? '')[0] as (typeof SOUND_IDS)[number];
      expect(SOUNDS[id].source).toBe(backticks(r[1] ?? '')[0]);
      expect(SOUNDS[id].when_ar).toBe(r[2]);
      expect(existsSync(repoPath(SOUNDS[id].source)), SOUNDS[id].source).toBe(true);
    }
  });

  it('push notification types are the sound ids without `test`, plus `closed`', () => {
    expect([...shared.PUSH_NOTIFICATION_TYPES]).toEqual([...SOUND_IDS.filter((s) => s !== 'test'), 'closed']);
  });
});

describe('canon §14 screens', () => {
  const lines = section(canon, '## 14.');
  const titles = (prefix: string) => {
    const line = lines.find((l) => l.includes(`\`${prefix}-01\``)) ?? '';
    return [...line.matchAll(/`([DS]-\d\d)`\s+(.+?)(?=\s+·\s+`|$)/g)].map((m): [string, string] => [
      m[1] ?? '',
      m[2] ?? '',
    ]);
  };

  it('driver and supervisor screen ids equal §14', () => {
    expect([...DRIVER_SCREEN_IDS]).toEqual(titles('D').map(([id]) => id));
    expect([...SUPERVISOR_SCREEN_IDS]).toEqual(titles('S').map(([id]) => id));
  });

  it('screen titles match §14 (parenthesised notes aside)', () => {
    const norm = (s: string) => stripParens(s).replace(/\s+/g, ' ').trim();
    for (const [id, title] of [...titles('D'), ...titles('S')]) {
      expect(norm(SCREEN_TITLES_AR[id as keyof typeof SCREEN_TITLES_AR]), id).toBe(norm(title));
    }
  });

  it('customer screens are W-01 … W-12 of §11', () => {
    const line = lines.find((l) => l.startsWith('العميل')) ?? '';
    expect(backticks(line)).toEqual([WA_MESSAGE_IDS[0], WA_MESSAGE_IDS[WA_MESSAGE_IDS.length - 1]]);
  });
});

describe('canon §14ب lock order', () => {
  it('LOCK_LEVELS and their tables equal §14ب', () => {
    const rows = tableRows(section(canon, '## 14ب.'));
    expect([...LOCK_LEVELS]).toEqual(rows.map((r) => r[0]));
    for (const r of rows) {
      const level = r[0] as (typeof LOCK_LEVELS)[number];
      // L7: «`task_offers` (ومستلموها)» — the offer rounds and their recipients.
      const expected = [
        ...backticks(r[1] ?? ''),
        ...((r[1] ?? '').includes('ومستلموها') ? ['offer_recipients'] : []),
      ];
      expect([...LOCK_LEVEL_TABLES[level]], level).toEqual(expected);
    }
  });

  it('every locked table is a canon table, at one level only', () => {
    const all = LOCK_LEVELS.flatMap((l) => [...LOCK_LEVEL_TABLES[l]]);
    expect(new Set(all).size).toBe(all.length);
    for (const t of all) expect(TABLE_NAMES).toContain(t);
    expect(shared.TABLE_LOCK_LEVEL.tickets).toBe('L5');
    expect(shared.isLockOrderAllowed('L1', 'L4')).toBe(true);
    expect(shared.isLockOrderAllowed('L5', 'L4')).toBe(false);
  });
});
