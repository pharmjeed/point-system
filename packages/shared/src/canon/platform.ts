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

/**
 * The operator lifecycle commands of 02 §4 (V2-005, DEC-486): `from` → `to`. `terminated` is final (no command leaves
 * it, nothing is deleted); `invited` is not created by the console (the owner is created with the operator).
 */
export const OPERATOR_TRANSITIONS = {
  activate: { from: ['invited', 'trial'], to: 'active' },
  suspend: { from: ['trial', 'active'], to: 'suspended' },
  reactivate: { from: ['suspended'], to: 'active' },
  terminate: { from: ['suspended'], to: 'terminated' },
} as const satisfies Record<string, { from: readonly OperatorStatus[]; to: OperatorStatus }>;
export type OperatorTransition = keyof typeof OPERATOR_TRANSITIONS;

/** The statuses under which the staff app opens nothing new (events, shifts, duty, intake): OPERATOR_SUSPENDED. */
export const OPERATOR_BLOCKED_STATUSES = [
  'suspended',
  'terminated',
] as const satisfies readonly OperatorStatus[];

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
  [
    'POST',
    '/v1/platform/venues/{venueId}/send-back',
    'platform.venue_review',
    'required',
    'command',
    'V2-004',
  ],
  ['POST', '/v1/platform/venues/{venueId}/hide', 'platform.venue_review', 'required', 'command', 'V2-004'],
  ['POST', '/v1/platform/venues/{venueId}/unhide', 'platform.venue_review', 'required', 'command', 'V2-004'],
  ['PUT', '/v1/platform/venues/{venueId}/pricing', 'platform.plan_manage', 'required', 'command', 'V2-004'],
  // P-01 … P-03 (V2-003): counts, operators, their contracts and staff (read-only), the operator's first owner
  ['GET', '/v1/platform/overview', 'platform.overview_read', 'none', 'read', 'V2-003'],
  ['GET', '/v1/platform/operators', 'platform.operator_read', 'none', 'read', 'V2-003'],
  ['POST', '/v1/platform/operators', 'platform.operator_manage', 'required', 'write', 'V2-003'],
  ['GET', '/v1/platform/operators/{orgId}', 'platform.operator_read', 'none', 'read', 'V2-003'],
  ['GET', '/v1/platform/operators/{orgId}/users', 'platform.operator_read', 'none', 'read', 'V2-003'],
  ['GET', '/v1/platform/operators/{orgId}/contracts', 'platform.operator_read', 'none', 'read', 'V2-003'],
  [
    'POST',
    '/v1/platform/operators/{orgId}/contracts',
    'platform.operator_manage',
    'required',
    'write',
    'V2-003',
  ],
  [
    'POST',
    '/v1/platform/operators/{orgId}/contracts/{contractId}/end',
    'platform.operator_manage',
    'required',
    'write',
    'V2-003',
  ],
  [
    'POST',
    '/v1/platform/operators/{orgId}/owner/temporary-password',
    'platform.operator_manage',
    'required',
    'write',
    'V2-003',
  ],
  // the operator lifecycle of 02 §4 (V2-005)
  [
    'POST',
    '/v1/platform/operators/{orgId}/activate',
    'platform.operator_manage',
    'required',
    'write',
    'V2-005',
  ],
  [
    'POST',
    '/v1/platform/operators/{orgId}/suspend',
    'platform.operator_manage',
    'required',
    'write',
    'V2-005',
  ],
  [
    'POST',
    '/v1/platform/operators/{orgId}/reactivate',
    'platform.operator_manage',
    'required',
    'write',
    'V2-005',
  ],
  [
    'POST',
    '/v1/platform/operators/{orgId}/terminate',
    'platform.operator_manage',
    'required',
    'write',
    'V2-005',
  ],
  // P-06 / P-08 refunds of online payments (V2-021, DEC-513): the gateway is called by the worker after COMMIT
  [
    'POST',
    '/v1/platform/payments/{paymentId}/refunds',
    'platform.refund_issue',
    'required',
    'command',
    'V2-021',
  ],
  // P-06 customers (V2-024, DEC-526 … DEC-528): search by phone (masked), the account, suspend / reactivate / revoke
  ['GET', '/v1/platform/customers', 'platform.customer_read', 'none', 'read', 'V2-024'],
  ['GET', '/v1/platform/customers/{accountId}', 'platform.customer_read', 'none', 'read', 'V2-024'],
  [
    'POST',
    '/v1/platform/customers/{accountId}/suspend',
    'platform.customer_manage',
    'required',
    'write',
    'V2-024',
  ],
  [
    'POST',
    '/v1/platform/customers/{accountId}/reactivate',
    'platform.customer_manage',
    'required',
    'write',
    'V2-024',
  ],
  [
    'POST',
    '/v1/platform/customers/{accountId}/sessions/revoke',
    'platform.customer_manage',
    'required',
    'write',
    'V2-024',
  ],
  // P-08 payments, reconciliation and finance alerts (V2-024, DEC-529, DEC-530); the refund is V2-021's row above
  ['GET', '/v1/platform/payments', 'platform.payment_read', 'none', 'read', 'V2-024'],
  ['GET', '/v1/platform/payments/{paymentId}', 'platform.payment_read', 'none', 'read', 'V2-024'],
  ['GET', '/v1/platform/reconciliation-runs', 'platform.payment_read', 'none', 'read', 'V2-024'],
  ['GET', '/v1/platform/reconciliation-runs/{runId}', 'platform.payment_read', 'none', 'read', 'V2-024'],
  ['GET', '/v1/platform/alerts', 'platform.payment_read', 'none', 'read', 'V2-024'],
  ['POST', '/v1/platform/alerts/{alertId}/resolve', 'platform.payment_read', 'required', 'command', 'V2-024'],
  // P-05 subscription plans (V2-030, DEC-531): per venue; a price change is a new plan and the old one retired
  ['GET', '/v1/platform/plans', 'platform.plan_manage', 'none', 'read', 'V2-030'],
  ['POST', '/v1/platform/plans', 'platform.plan_manage', 'required', 'command', 'V2-030'],
  ['POST', '/v1/platform/plans/{planId}/retire', 'platform.plan_manage', 'required', 'command', 'V2-030'],
  // P-07 subscriptions and their report (V2-035, DEC-537): counts and amounts, masked customers
  ['GET', '/v1/platform/subscriptions', 'platform.subscription_read', 'none', 'read', 'V2-035'],
  ['GET', '/v1/platform/subscriptions/report', 'platform.subscription_read', 'none', 'read', 'V2-035'],
  [
    'GET',
    '/v1/platform/subscriptions/{subscriptionId}',
    'platform.subscription_read',
    'none',
    'read',
    'V2-035',
  ],
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
