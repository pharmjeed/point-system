/**
 * The make and colour labels the server writes for people (W-01 `{{3}}`, CSV exports) are 02 §8.4 word for word,
 * and a typed «أخرى» value passes through (DEC-350).
 */
import { describe, expect, it } from 'vitest';
import {
  VEHICLE_COLOR_LABELS_AR,
  VEHICLE_MAKE_LABELS_AR,
  vehicleColorLabelAr,
  vehicleMakeLabelAr,
} from '../src/index.js';
import { readDoc, section } from './docs.js';

const lists = section(readDoc('02_Wireframes_Spec.md'), '### 8.4 ');

/** "- **الألوان (المفتاح ← النص):** `white` أبيض · … · `other` أخرى (نص حر)." → [['white','أبيض'], …] */
function pairs(title: string): Array<[string, string]> {
  const line = lists.find((l) => l.startsWith(`- **${title}`)) ?? '';
  const list = line.slice(line.indexOf(':**') + 3).replace(/\.\s*$/, '');
  return list
    .split(' · ')
    .map((part) => /^`([a-z0-9_]+)`\s+(.+)$/.exec(part.trim()))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => [m[1] as string, (m[2] as string).replace(/\s*\(نص حر\)\s*$/, '').trim()]);
}

describe('02 §8.4 vehicle labels', () => {
  it('colours and makes: keys and Arabic labels in the order of 02', () => {
    expect(Object.entries(VEHICLE_COLOR_LABELS_AR)).toEqual(pairs('الألوان'));
    expect(Object.entries(VEHICLE_MAKE_LABELS_AR)).toEqual(pairs('الشركات الشائعة'));
    expect(Object.keys(VEHICLE_MAKE_LABELS_AR)).toHaveLength(19);
  });

  it('keys become labels; typed text, unknown values and null pass through', () => {
    expect(vehicleMakeLabelAr('toyota')).toBe('تويوتا');
    expect(vehicleMakeLabelAr('land_rover')).toBe('لاند روفر');
    expect(vehicleColorLabelAr('white')).toBe('أبيض');
    expect(vehicleMakeLabelAr('بروتون')).toBe('بروتون');
    expect(vehicleColorLabelAr('عنابي')).toBe('عنابي');
    expect(vehicleMakeLabelAr('constructor')).toBe('constructor'); // never a prototype property
    expect(vehicleMakeLabelAr(null)).toBeNull();
    expect(vehicleColorLabelAr(undefined)).toBeNull();
  });
});
