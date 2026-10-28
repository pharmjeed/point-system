import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as ar from '@/i18n/ar';

/**
 * Screen copy is 02's text word for word (05 §7.8). Every string of the screen dictionaries below must occur
 * in docs/02_Wireframes_Spec.md (a `{placeholder}` matches 02's own placeholder or its example value), except
 * the keys listed as not in 02 — those are proposed for 02 §8 in docs/progress/notes/pnt-023.md / pnt-035.md.
 */
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
};

const SCREENS = { s05: ar.s05, s06: ar.s06, s08: ar.s08, s09: ar.s09 } as const;

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
