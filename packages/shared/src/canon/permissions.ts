/**
 * Permissions and the role matrix of canon §10 (details in file 09 §3).
 *
 * Grants: `'yes'` (✓), `'no'` (—), `'drive'` (D*: the supervisor with `users.can_drive = true`,
 * only while on an open duty in a venue of their scope — DEC-22). Each row carries the canon's
 * extra-condition text as a comment; those conditions are checked by policies in the handler,
 * not by the role matrix (file 09 §8).
 */
import { z } from 'zod';
import type { Role } from './enums.js';

export const PERMISSIONS = [
  'auth.self',
  'duty.self',
  'ticket.intake',
  'ticket.read_minimal',
  'ticket.read_full',
  'ticket.read_photos',
  'ticket.reveal_phone',
  'ticket.change_phone',
  'ticket.discard_empty_draft',
  'ticket.void',
  'ticket.inspection_exception',
  'ticket.repark',
  'ticket.custody_transfer',
  'ticket.manual_reconcile',
  'wa.link',
  'retrieval.request_on_behalf',
  'retrieval.cancel',
  'offer.accept',
  'task.execute',
  'task.release_custody',
  'task.reassign',
  'handover.verify',
  'handover.resend_code',
  'handover.exception',
  'payment.record',
  'payment.reverse',
  'payment.waive',
  'cash.handover_confirm',
  'event.manage',
  'shift.manage',
  'duty.force_end',
  'venue.read',
  'venue.manage',
  'venue.layout_read',
  'driver.read',
  'driver.manage',
  'driver.assign',
  'driver.transfer',
  'staff.manage',
  'alert.read',
  'alert.manage',
  'incident.read',
  'incident.create',
  'incident.manage',
  'report.read',
  'export.create',
  'audit.read',
  'wa.channel_read',
  'wa.channel_manage',
  'wa.templates_manage',
  'outbox.manage',
  'retention.manage',
  'org.settings_manage',
  'telemetry.write',
  // V2 (V2-041 / V2-042, DEC-547): the operator's settlement statements and system subscription (O-05, O-06)
  'settlement.read',
  'settlement.dispute',
] as const;
export type Permission = (typeof PERMISSIONS)[number];
export const PermissionSchema = z.enum(PERMISSIONS);

export const PERMISSION_GRANTS = ['yes', 'no', 'drive'] as const;
export type PermissionGrant = (typeof PERMISSION_GRANTS)[number];

/** One row of canon §10: owner (O), admin (A), supervisor (S), driver (D). */
export interface PermissionRow {
  owner: PermissionGrant;
  admin: PermissionGrant;
  supervisor: PermissionGrant;
  driver: PermissionGrant;
}

const Y = 'yes';
const N = 'no';
const DRIVE = 'drive';
const row = (
  owner: PermissionGrant,
  admin: PermissionGrant,
  supervisor: PermissionGrant,
  driver: PermissionGrant,
) => ({ owner, admin, supervisor, driver }) as const satisfies PermissionRow;

/** Canon §10, row for row (O · A · S · D). Comments = the canon's «الشرط الإضافي». */
export const PERMISSION_MATRIX = {
  // حسابه فقط
  'auth.self': row(Y, Y, Y, Y),
  // تعيين نشط (أو نطاق للمشرف)؛ بدء المناوبة وحده يشترط وردية مفتوحة، والقراءة (`GET /v1/me/home`) تعمل دونها
  'duty.self': row(N, N, DRIVE, Y),
  // أثناء المناوبة، حفل مفتوح في موقعه؛ تعديل المسودة لمنشئها في `received`، ورفع الصور له في `received` أو `parking`،
  // وتحويل القناة إلى ورقية له في `parking` (DEC-40)
  'ticket.intake': row(N, N, DRIVE, Y),
  // السائق: تذاكر موقعه المفتوحة فقط وحقول دنيا
  'ticket.read_minimal': row(Y, Y, Y, Y),
  // السائق: فقط المكلّف بمهمة مفتوحة على التذكرة أو منشئها أثناء التسجيل
  'ticket.read_full': row(Y, Y, Y, Y),
  // كشرط `ticket.read_full`
  'ticket.read_photos': row(Y, Y, Y, Y),
  // سبب إلزامي + تدقيق
  'ticket.reveal_phone': row(Y, Y, Y, N),
  // السائق: منشئ التذكرة أو المكلّف، بتحقق ميداني وسبب؛ يبطل الرموز السابقة
  'ticket.change_phone': row(N, Y, Y, Y),
  // مسودته الخالية من البيانات فقط
  'ticket.discard_empty_draft': row(N, N, N, Y),
  // سبب إلزامي؛ التذكرة `received` أو `parking` فقط (DEC-45)
  'ticket.void': row(N, Y, Y, N),
  // سبب إلزامي
  'ticket.inspection_exception': row(N, N, Y, N),
  // التذكرة `ready`
  'ticket.repark': row(N, N, Y, N),
  // سبب إلزامي
  'ticket.custody_transfer': row(N, N, Y, N),
  // بعد انقطاع؛ دليل وسبب
  'ticket.manual_reconcile': row(N, Y, Y, N),
  // السائق أثناء المناوبة في موقع التذكرة
  'wa.link': row(N, N, Y, Y),
  // سبب إلزامي؛ التذكرة `parked` فقط (DEC-25)
  'retrieval.request_on_behalf': row(N, N, Y, Y),
  // السائق: قبل الإسناد فقط؛ المشرف: في أي حالة قبل التسليم، وبعد بدء الحركة يتحول الطلب إلى إعادة صف مع السائق نفسه (DEC-30)
  'retrieval.cancel': row(N, N, Y, Y),
  // مستلم العرض وأثناء المناوبة
  'offer.accept': row(N, N, DRIVE, Y),
  // المكلّف بالمهمة
  'task.execute': row(N, N, DRIVE, Y),
  // السائق المكلّف أو المشرف
  'task.release_custody': row(N, N, Y, Y),
  // سبب + تحقق العهدة
  'task.reassign': row(N, N, Y, N),
  // المكلّف بمهمة الإحضار
  'handover.verify': row(N, N, DRIVE, Y),
  // المكلّف أو المشرف؛ ضمن الحد
  'handover.resend_code': row(N, N, Y, Y),
  // تحقق هوية موثق + سبب
  'handover.exception': row(N, N, Y, N),
  // المكلّف عند التسليم
  'payment.record': row(N, N, DRIVE, Y),
  // سبب إلزامي
  'payment.reverse': row(N, Y, Y, N),
  // سبب إلزامي
  'payment.waive': row(N, N, Y, N),
  // المشرف المستلم (الإدارة احتياطًا عندما يكون المشرف الوحيد سائقًا)
  'cash.handover_confirm': row(N, Y, Y, N),
  'event.manage': row(Y, Y, Y, N),
  'shift.manage': row(Y, Y, Y, N),
  // بعد التحقق من العهدة
  'duty.force_end': row(N, N, Y, N),
  'venue.read': row(Y, Y, Y, N),
  'venue.manage': row(Y, Y, N, N),
  // السائق: مناطق ومواقف ولوحات وخانات موقع تعيينه النشط مع حالة الإشغال فقط (لإتمام الصف D-08)
  'venue.layout_read': row(Y, Y, Y, Y),
  // المشرف: سائقو مواقعه
  'driver.read': row(Y, Y, Y, N),
  // إنشاء/تعديل/تعطيل/تفعيل/إعادة تعيين السر
  'driver.manage': row(Y, Y, N, N),
  // المشرف: داخل نطاقه
  'driver.assign': row(Y, Y, Y, N),
  // المشرف: يجب أن يملك نطاق الموقعين
  'driver.transfer': row(Y, Y, Y, N),
  // الإدارة تدير المشرفين فقط؛ المالك يدير الإدارة؛ إعادة ضبط MFA للمالك فقط
  'staff.manage': row(Y, Y, N, N),
  'alert.read': row(Y, Y, Y, N),
  'alert.manage': row(Y, Y, Y, N),
  'incident.read': row(Y, Y, Y, N),
  // السائق: لتذاكر موقعه
  'incident.create': row(N, Y, Y, Y),
  'incident.manage': row(N, Y, Y, N),
  'report.read': row(Y, Y, Y, N),
  // تدقيق إلزامي
  'export.create': row(Y, Y, Y, N),
  'audit.read': row(Y, Y, N, N),
  'wa.channel_read': row(Y, Y, N, N),
  'wa.channel_manage': row(Y, N, N, N),
  'wa.templates_manage': row(Y, Y, N, N),
  'outbox.manage': row(Y, Y, N, N),
  'retention.manage': row(Y, N, N, N),
  // إعدادات المؤسسة `security.*` و`heartbeat.*`
  'org.settings_manage': row(Y, N, N, N),
  'telemetry.write': row(Y, Y, Y, Y),
  // الإصدار الثاني: كشوف التسوية واشتراك النظام وفواتيره للمشغل (O-05، O-06)، قراءة
  'settlement.read': row(Y, Y, N, N),
  // الإصدار الثاني: الاعتراض على كشف صادر بسبب (O-05)
  'settlement.dispute': row(Y, Y, N, N),
} as const satisfies Record<Permission, PermissionRow>;

function baseGrants(role: Role): readonly Permission[] {
  return PERMISSIONS.filter((p) => PERMISSION_MATRIX[p][role] === 'yes');
}

/** Base grants per role (✓ only), in canon order. D* permissions are in {@link DRIVE_PERMISSIONS}. */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: baseGrants('owner'),
  admin: baseGrants('admin'),
  supervisor: baseGrants('supervisor'),
  driver: baseGrants('driver'),
};

/**
 * D* permissions: gained by a supervisor with `can_drive = true`, and only during an open duty in
 * a venue of their scope (the duty is checked after the guard, by the policy).
 */
export const DRIVE_PERMISSIONS = [
  'duty.self',
  'ticket.intake',
  'offer.accept',
  'task.execute',
  'handover.verify',
  'payment.record',
] as const satisfies readonly Permission[];
export type DrivePermission = (typeof DRIVE_PERMISSIONS)[number];

/** Minimal actor shape for the role check. */
export interface PermissionActor {
  role: Role;
  /** `users.can_drive` (supervisors only). */
  canDrive: boolean;
}

/**
 * Role-matrix check used by the permission guard (file 09 §8.2). D* is granted to a supervisor
 * with `can_drive`; whether they are on duty is checked later by the policy.
 */
export function hasPermission(actor: PermissionActor, permission: Permission): boolean {
  const grant = PERMISSION_MATRIX[permission][actor.role];
  if (grant === 'yes') return true;
  return grant === 'drive' && actor.role === 'supervisor' && actor.canDrive;
}

export function isDrivePermission(permission: Permission): permission is DrivePermission {
  return (DRIVE_PERMISSIONS as readonly Permission[]).includes(permission);
}
