/**
 * V2-002 (DEC-462, DEC-465): the platform canon is apart from the staff canon — its permissions, matrix and routes —
 * and equals docs/v2/02 §2.1, docs/07_openapi.yaml (tag Platform) and the 0008 migration's check values.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  OPERATOR_STATUSES,
  PERMISSIONS,
  PLATFORM_PERMISSIONS,
  PLATFORM_PERMISSION_MATRIX,
  PLATFORM_ROLES,
  PLATFORM_ROLE_PERMISSIONS,
  PLATFORM_ROUTES,
  PLATFORM_SELF_PATHS,
  PLATFORM_TABLE_NAMES,
  ROUTES,
  TABLE_NAMES,
  VENUE_CATEGORIES,
  hasPlatformPermission,
  isPlatformPath,
} from '../src/index.js';
import { backticks, readDoc, repoPath, section, tableRows } from './docs.js';

const migration = readFileSync(repoPath('packages/db/migrations/0008_platform.sql'), 'utf8');
const checkValues = (name: string) => {
  const m = new RegExp(`${name}\\s+CHECK \\((\\w+) IN \\(([^)]*)\\)`).exec(migration);
  return (m?.[2] ?? '').split(',').map((v) => v.trim().replace(/^'|'$/g, ''));
};

describe('platform canon vs docs/v2/02 §2.1', () => {
  const rows = tableRows(section(readDoc('v2/02_Platform_and_Operators.md'), '### 2.1'));

  it('the matrix equals the table row for row', () => {
    const fromDoc = rows.map((r) => ({
      permission: backticks(r[0] ?? '')[0],
      grants: r.slice(2, 6).map((c) => c === '✓'),
    }));
    expect(fromDoc.map((r) => r.permission)).toEqual([...PLATFORM_PERMISSIONS]);
    for (const r of fromDoc) {
      const m = PLATFORM_PERMISSION_MATRIX[r.permission as keyof typeof PLATFORM_PERMISSION_MATRIX];
      expect(
        PLATFORM_ROLES.map((role) => m[role]),
        r.permission,
      ).toEqual(r.grants);
    }
  });

  it('the owner holds every platform permission; every role holds platform.self and P-01', () => {
    expect(PLATFORM_ROLE_PERMISSIONS.platform_owner).toEqual([...PLATFORM_PERMISSIONS]);
    for (const role of PLATFORM_ROLES) {
      expect(hasPlatformPermission(role, 'platform.self')).toBe(true);
      expect(hasPlatformPermission(role, 'platform.overview_read')).toBe(true);
    }
    expect(hasPlatformPermission('platform_support', 'platform.refund_issue')).toBe(false);
  });
});

describe('separation from the staff canon (DEC-462)', () => {
  it('no permission is shared between the two matrices', () => {
    const staff = new Set<string>(PERMISSIONS);
    expect(PLATFORM_PERMISSIONS.filter((p) => staff.has(p))).toEqual([]);
    expect(PLATFORM_PERMISSIONS.every((p) => p.startsWith('platform.'))).toBe(true);
    expect(PERMISSIONS.some((p) => p.startsWith('platform.'))).toBe(false);
  });

  it('every platform route is under /v1/platform/ and no canon route is', () => {
    expect(PLATFORM_ROUTES.every((r) => isPlatformPath(r.path))).toBe(true);
    expect(ROUTES.filter((r) => isPlatformPath(r.path))).toEqual([]);
    const keys = PLATFORM_ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('the restricted session reaches exactly the platform.self routes', () => {
    expect(PLATFORM_SELF_PATHS).toEqual([
      'POST /v1/platform/auth/mfa/setup',
      'POST /v1/platform/auth/mfa/confirm',
      'POST /v1/platform/auth/secret/change',
      'POST /v1/platform/auth/logout',
      'GET /v1/platform/me',
    ]);
  });

  it('the platform tables are not canon §6 tables', () => {
    expect(PLATFORM_TABLE_NAMES.filter((t) => (TABLE_NAMES as readonly string[]).includes(t))).toEqual([]);
    for (const t of PLATFORM_TABLE_NAMES) expect(migration).toContain(`CREATE TABLE ${t} (`);
  });
});

describe('platform canon vs migration 0008', () => {
  it('roles, operator statuses and venue categories are the CHECK values', () => {
    expect(checkValues('ck_platform_users_role')).toEqual([...PLATFORM_ROLES]);
    expect(checkValues('ck_organizations_operator_status')).toEqual([...OPERATOR_STATUSES]);
    expect(checkValues('ck_venue_public_profiles_category')).toEqual([...VENUE_CATEGORIES]);
  });
});
