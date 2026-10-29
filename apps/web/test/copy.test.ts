import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as arMain from '@/i18n/ar';
import * as arStaff from '@/i18n/ar.staff';

/**
 * Screen copy is 02's text word for word (05 §7.8). Every string of the screen dictionaries below must occur
 * in docs/02_Wireframes_Spec.md (a `{placeholder}` matches 02's own placeholder or its example value), except
 * the keys listed as not in 02 — those are proposed for 02 §8 in docs/progress/notes/pnt-023.md / pnt-035.md.
 */
/** The dictionary is split by area (driver first load vs the lazy staff chunks); the checks cover both. */
const ar = { ...arMain, ...arStaff };

const spec = readFileSync(new URL('../../../docs/02_Wireframes_Spec.md', import.meta.url), 'utf8');
const canon = readFileSync(new URL('../../../docs/00_Glossary_Canon.md', import.meta.url), 'utf8');

function flatten(value: unknown, prefix = ''): Array<[string, string]> {
  if (typeof value === 'string') return [[prefix, value]];
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
    flatten(v, prefix ? `${prefix}.${k}` : k),
  );
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Text → regex: `{x}` matches `{…}` or an example value in 02. */
const pattern = (text: string) =>
  new RegExp(
    text
      .split(/\{[a-zA-Z0-9_]+\}/)
      .map(escape)
      .join('(?:\\{[^}]+\\}|[^\\n«»|]+?)'),
  );

const NOT_IN_02: Record<string, string[]> = {
  s05: ['venue', 'allVenues', 'empty', 'none'],
  s06: ['venue', 'assignReason', 'noDuty', 'noHistory', 'current', 'itemType'],
  s08: [
    'closeShiftBody', // 02 S-08 sentence without the `shift_closed` identifier
    'openShift',
    'editVenue',
    'venueCode',
    'venueName',
    'venueNameEn',
    'city',
    'address',
    'pool',
    'shiftName',
    'shiftEnd',
    'perVehiclePrice',
    'cancelEvent',
    'emptyVenues',
    'emptyEvents',
    'emptyShifts',
    'noShift',
  ],
  s09: [
    'newZone',
    'zoneName',
    'addSpots',
    'newBoard',
    'boardName',
    'addSlots',
    'newPool',
    'poolName',
    'defaultPool',
    'prefix',
    'disable',
    'enable',
    'zonesCount',
    'spotsCount',
    'boardsCount',
    'slotsCount',
    'poolsCount',
    'emptyZones',
    'emptyBoards',
    'outOfRange',
    'units',
    'parkingModes',
    'settings', // labels from canon §12 (checked below)
  ],
  d05: ['makeOther', 'colorOther'], // labels of the «أخرى» free-text inputs
  // 02 D-07 without the customer brand (canon §1 rule 2), the dialog without a sender number, the panel with
  // no code to show — docs/progress/notes/driver-gaps.md
  d07: ['sentTo', 'confirmTitleUnknown', 'noCode'],
  d13: ['consent'], // 02 D-05's sentence without the customer brand (canon §1 rule 2) — notes/s5-web.md
};

const SCREENS = {
  s05: ar.s05,
  s06: ar.s06,
  s08: ar.s08,
  s09: ar.s09,
  d03: ar.d03,
  d04: ar.d04,
  d05: ar.d05,
  d06: ar.d06,
  d07: ar.d07,
  d08: ar.d08,
  d09: ar.d09,
  d10: ar.d10,
  d11: ar.d11,
  d12: ar.d12,
  d13: ar.d13,
  d14: ar.d14,
} as const;

describe('screen copy comes from 02', () => {
  for (const [name, dict] of Object.entries(SCREENS)) {
    it(name, () => {
      const skip = NOT_IN_02[name] ?? [];
      const missing = flatten(dict)
        .filter(([key]) => !skip.some((s) => key === s || key.startsWith(`${s}.`)))
        .filter(([, text]) => !pattern(text).test(spec))
        .map(([key, text]) => `${key}: ${text}`);
      expect(missing).toEqual([]);
    });
  }

  it('the live in-page texts of the driver are 14 §5.1 word for word (14 is their final reference)', () => {
    const notifications = readFileSync(
      new URL('../../../docs/14_Notification_Matrix_Templates.md', import.meta.url),
      'utf8',
    );
    const missing = flatten(ar.live)
      .filter(([, text]) => !pattern(text).test(notifications))
      .map(([key, text]) => `${key}: ${text}`);
    expect(missing).toEqual([]);
  });

  it('S-09 setting labels are the «المعنى» column of canon §12', () => {
    const section = canon.slice(canon.indexOf('## 12.'), canon.indexOf('## 13.'));
    const adapted = ['dispatch.accept_grace_ms', 'parking.mode']; // `expires_at` worded out; §12 has no meaning text
    for (const [key, label] of Object.entries(ar.s09.settings)) {
      if (adapted.includes(key)) continue;
      const row = section.split('\n').find((l) => l.startsWith(`| \`${key}\` |`));
      expect(row, key).toBeDefined();
      expect(row, key).toContain(label);
    }
  });
});
