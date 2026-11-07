/**
 * The V2 platform layer (docs/v2/02_Platform_and_Operators.md, DEC-461 … DEC-465): platform roles, the platform
 * permission matrix, the `/v1/platform/*` route registry, operator statuses and the platform tables.
 *
 * Kept apart from the staff canon on purpose: a platform account is never a member of an operator organization,
 * no staff role holds a platform permission and no platform role holds a staff permission (V2-002). `ROUTES`
 * stays the routes of canon §9; the platform routes are `PLATFORM_ROUTES` (DEC-462).
 */
import { z } from 'zod';
import type { HttpMethod, IdempotencyMode, RateLimitClass } from './routes.js';

/** `platform_users.role` (`ck_platform_users_role`). */
export const PLATFORM_ROLES = [
  'platform_owner',
  'platform_admin',
  'platform_finance',
  'platform_support',
] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];
export const PlatformRoleSchema = z.enum(PLATFORM_ROLES);

export const PLATFORM_USER_STATUSES = ['active', 'disabled'] as const;
export type PlatformUserStatus = (typeof PLATFORM_USER_STATUSES)[number];

/** `organizations.operator_status` — the operator lifecycle of 02 §4. */
export const OPERATOR_STATUSES = ['invited', 'trial', 'active', 'suspended', 'terminated'] as const;
export type OperatorStatus = (typeof OPERATOR_STATUSES)[number];
export const OperatorStatusSchema = z.enum(OPERATOR_STATUSES);

/** `venue_public_profiles.status` and `.category` (03 §2). */
export const VENUE_PUBLIC_STATUSES = ['draft', 'submitted', 'approved', 'hidden'] as const;
export type VenuePublicStatus = (typeof VENUE_PUBLIC_STATUSES)[number];
export const VENUE_CATEGORIES = [
  'hall',
  'office',
  'mall',
  'hospital',
  'residential',
  'hotel',
  'club',
  'other',
] as const;
export type VenueCategory = (typeof VENUE_CATEGORIES)[number];

/** `operator_contracts.saas_cycle`. */
export const SAAS_CYCLES = ['monthly', 'yearly'] as const;
export type SaasCycle = (typeof SAAS_CYCLES)[number];

/** `platform_sessions.revoked_reason` (`consumed` = a used MFA challenge). */
export const PLATFORM_SESSION_REVOKED_REASONS = [
  'logout',
  'disabled',
  'secret_reset',
  'admin',
  'expired_cleanup',
  'consumed',
] as const;
export type PlatformSessionRevokedReason = (typeof PLATFORM_SESSION_REVOKED_REASONS)[number];

/** The tables of migration 0008_platform.sql (outside canon §6, which lists the V1 tables). */
export const PLATFORM_TABLE_NAMES = [
  'platform_users',
  'platform_sessions',
  'platform_idempotency_keys',
  'platform_audit_log',
  'operator_contracts',
  'venue_public_profiles',
] as const;
export type PlatformTableName = (typeof PLATFORM_TABLE_NAMES)[number];

/**
 * Platform sign-in limits (DEC-464): there is no organization to read `security.*` from, so the platform uses
 * the V1 defaults of the most protected staff accounts (owner/admin, canon §12) as fixed values.
 */
export const PLATFORM_SECURITY = {
  /** absolute session lifetime */
  session_hours: 12,
  /** a session idle longer than this is expired (`reason: idle`) */
  idle_minutes: 30,
  /** the n-th consecutive failure locks the account */
  max_login_attempts: 5,
  lock_minutes: 15,
  /** the single-use step between the password and the TOTP code */
  mfa_challenge_minutes: 5,
} as const;

/**
 * Platform permissions (02 §2: one per screen family P-01 … P-12, plus `platform.self`). The routes of each are
 * built by the later V2 tickets; V2-002 serves `platform.self` only.
 */
export const PLATFORM_PERMISSIONS = [
  'platform.self',
  'platform.overview_read',
  'platform.operator_read',
  'platform.operator_manage',
  'platform.venue_review',
  'platform.plan_manage',
  'platform.customer_read',
  'platform.customer_manage',
  'platform.subscription_read',
  'platform.payment_read',
  'platform.refund_issue',
  'platform.settlement_manage',
  'platform.invoice_read',
  'platform.settings_manage',
  'platform.audit_read',
  'platform.user_manage',
] as const;
export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number];
export const PlatformPermissionSchema = z.enum(PLATFORM_PERMISSIONS);

type G = boolean;
/** [owner, admin, finance, support] */
const prow = (owner: G, admin: G, finance: G, support: G) =>
  ({
    platform_owner: owner,
    platform_admin: admin,
    platform_finance: finance,
    platform_support: support,
  }) as const;
const Y = true;
const N = false;

/** The platform role matrix (docs/v2/02 §2.1; the screen column of 02 §2). */
export const PLATFORM_PERMISSION_MATRIX = {
  // تسجيل الدخول والخروج وإعداد التحقق الثنائي و`GET /v1/platform/me`
  'platform.self': prow(Y, Y, Y, Y),
  // P-01 النظرة العامة — الكل
  'platform.overview_read': prow(Y, Y, Y, Y),
  // P-02 / P-03 المشغلون (قراءة)
  'platform.operator_read': prow(Y, Y, N, N),
  // P-02 / P-03 إضافة مشغل، العقد، التعليق بسبب
  'platform.operator_manage': prow(Y, Y, N, N),
  // P-04 طلبات إدراج المواقع واعتماد الملف العام
  'platform.venue_review': prow(Y, Y, N, N),
  // P-05 باقات الاشتراك وأسعارها
  'platform.plan_manage': prow(Y, N, Y, N),
  // P-06 العملاء (بحث بالجوال مقنّعًا)
  'platform.customer_read': prow(Y, N, Y, Y),
  // P-06 تعليق الحساب
  'platform.customer_manage': prow(Y, N, Y, Y),
  // P-07 الاشتراكات
  'platform.subscription_read': prow(Y, N, Y, N),
  // P-08 المدفوعات والمطابقة
  'platform.payment_read': prow(Y, N, Y, N),
  // P-06 / P-08 الاسترداد بسبب (مال يخرج: المالية والمالك فقط، DEC-465)
  'platform.refund_issue': prow(Y, N, Y, N),
  // P-09 التسوية: إصدار، اعتماد، تسجيل الدفع
  'platform.settlement_manage': prow(Y, N, Y, N),
  // P-10 الفواتير
  'platform.invoice_read': prow(Y, N, Y, N),
  // P-11 الإعدادات
  'platform.settings_manage': prow(Y, N, N, N),
  // P-12 سجل المنصة
  'platform.audit_read': prow(Y, N, N, N),
  // حسابات موظفي المنصة (إضافة وتعطيل)
  'platform.user_manage': prow(Y, N, N, N),
} as const satisfies Record<PlatformPermission, Record<PlatformRole, boolean>>;

/** Grants per platform role, in permission order. */
export const PLATFORM_ROLE_PERMISSIONS: Record<PlatformRole, readonly PlatformPermission[]> = {
  platform_owner: PLATFORM_PERMISSIONS.filter((p) => PLATFORM_PERMISSION_MATRIX[p].platform_owner),
  platform_admin: PLATFORM_PERMISSIONS.filter((p) => PLATFORM_PERMISSION_MATRIX[p].platform_admin),
  platform_finance: PLATFORM_PERMISSIONS.filter((p) => PLATFORM_PERMISSION_MATRIX[p].platform_finance),
  platform_support: PLATFORM_PERMISSIONS.filter((p) => PLATFORM_PERMISSION_MATRIX[p].platform_support),
};

export function hasPlatformPermission(role: PlatformRole, permission: PlatformPermission): boolean {
  return PLATFORM_PERMISSION_MATRIX[permission]?.[role] === true;
}

export function isPlatformPermission(value: unknown): value is PlatformPermission {
  return typeof value === 'string' && (PLATFORM_PERMISSIONS as readonly string[]).includes(value);
}

/** Every platform route lives under this prefix; no staff route may (DEC-462). */
export const PLATFORM_PATH_PREFIX = '/v1/platform/';

export interface PlatformRouteDef {
  method: HttpMethod;
  path: string;
  permission: PlatformPermission | 'public';
  idempotent: boolean;
  idempotency: IdempotencyMode;
  rateLimitClass: RateLimitClass;
  /** the V2 ticket that serves it */
  ticket: string;
}

type PRow = readonly [
  HttpMethod,
  string,
  PlatformPermission | 'public',
  IdempotencyMode,
  RateLimitClass,
  string,
];

// [method, path, permission, x-idempotency, x-rate-limit-class, ticket]
const PLATFORM_ROWS: readonly PRow[] = [
  ['POST', '/v1/platform/auth/login', 'public', 'none', 'auth', 'V2-002'],
  ['POST', '/v1/platform/auth/mfa/verify', 'public', 'none', 'auth', 'V2-002'], // the mfa_token of the login
  ['POST', '/v1/platform/auth/mfa/setup', 'platform.self', 'none', 'write', 'V2-002'],
  ['POST', '/v1/platform/auth/mfa/confirm', 'platform.self', 'none', 'write', 'V2-002'],
  ['POST', '/v1/platform/auth/secret/change', 'platform.self', 'none', 'write', 'V2-002'],
  ['POST', '/v1/platform/auth/logout', 'platform.self', 'none', 'write', 'V2-002'],
  ['GET', '/v1/platform/me', 'platform.self', 'none', 'read', 'V2-002'],
  // P-04 venue listings (V2-004, DEC-490 … DEC-494); prices are P-05's permission (V2-D05, DEC-493)
  ['GET', '/v1/platform/venues', 'platform.venue_review', 'none', 'read', 'V2-004'],
  ['GET', '/v1/platform/venues/{venueId}', 'platform.venue_review', 'none', 'read', 'V2-004'],
  ['POST', '/v1/platform/venues/{venueId}/approve', 'platform.venue_review', 'required', 'command', 'V2-004'],
  ['POST', '/v1/platform/venues/{venueId}/send-back', 'platform.venue_review', 'required', 'command', 'V2-004'],
  ['POST', '/v1/platform/venues/{venueId}/hide', 'platform.venue_review', 'required', 'command', 'V2-004'],
  ['POST', '/v1/platform/venues/{venueId}/unhide', 'platform.venue_review', 'required', 'command', 'V2-004'],
  ['PUT', '/v1/platform/venues/{venueId}/pricing', 'platform.plan_manage', 'required', 'command', 'V2-004'],
];

/** The `/v1/platform/*` routes (docs/07_openapi.yaml tag `platform`), checked by test/platform.test.ts. */
export const PLATFORM_ROUTES: readonly PlatformRouteDef[] = PLATFORM_ROWS.map(
  ([method, path, permission, idempotency, rateLimitClass, ticket]) => ({
    method,
    path,
    permission,
    idempotent: idempotency === 'required',
    idempotency,
    rateLimitClass,
    ticket,
  }),
);

const PLATFORM_BY_KEY = new Map(PLATFORM_ROUTES.map((r) => [`${r.method} ${r.path}`, r]));

export function findPlatformRoute(method: HttpMethod, path: string): PlatformRouteDef | undefined {
  return PLATFORM_BY_KEY.get(`${method} ${path}`);
}

export function isPlatformPath(path: string): boolean {
  return path.startsWith(PLATFORM_PATH_PREFIX) || path === '/v1/platform';
}

/** The `platform.self` routes a restricted platform session may still use (`allowed_paths`, 08 §4.1). */
export const PLATFORM_SELF_PATHS: readonly string[] = PLATFORM_ROUTES.filter(
  (r) => r.permission === 'platform.self',
).map((r) => `${r.method} ${r.path}`);
