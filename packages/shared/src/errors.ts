/**
 * Error codes (canon §8) and their catalog (docs/08_Error_Codes_Guide.md §4: HTTP status,
 * `retryable`, log level, associated supervisor alert, and the exact English/Arabic texts).
 *
 * The UI branches on `code` only. `message_ar` is ready to display; `message` is for developers
 * and logs. `retryable` is true only when re-sending the very same request with the same
 * `Idempotency-Key` may succeed without any user change.
 */
import { z } from 'zod';
import type { AlertType } from './canon/enums.js';

/** Every code of canon §8, once, in canon order. */
export const ERROR_CODES = [
  'AUTH_UNAUTHENTICATED',
  'AUTH_INVALID_CREDENTIALS',
  'AUTH_ACCOUNT_DISABLED',
  'AUTH_ACCOUNT_LOCKED',
  'AUTH_MFA_REQUIRED',
  'AUTH_MFA_INVALID',
  'AUTH_MFA_SETUP_REQUIRED',
  'AUTH_SECRET_CHANGE_REQUIRED',
  'AUTH_SESSION_EXPIRED',
  'AUTH_SESSION_REVOKED',
  'PERMISSION_DENIED',
  'SCOPE_VENUE_DENIED',
  'ASSIGNMENT_REQUIRED',
  'DUTY_REQUIRED',
  'NOT_TASK_ASSIGNEE',
  'NOT_OFFER_RECIPIENT',
  'RESOURCE_NOT_FOUND',
  'TICKET_NOT_FOUND',
  'OFFER_NOT_FOUND',
  'VALIDATION_FAILED',
  'PHONE_INVALID',
  'PLATE_INVALID',
  'CONSENT_REQUIRED',
  'REASON_REQUIRED',
  'PAGINATION_CURSOR_INVALID',
  'VERSION_CONFLICT',
  'IDEMPOTENCY_KEY_REQUIRED',
  'IDEMPOTENCY_KEY_REUSED',
  'IDEMPOTENCY_IN_PROGRESS',
  'INVALID_STATE_TRANSITION',
  'DRIVER_NOT_AVAILABLE',
  'DRIVER_ON_BREAK',
  'DUTY_ALREADY_STARTED',
  'DUTY_END_BLOCKED_CUSTODY',
  'SHIFT_NOT_OPEN',
  'EVENT_NOT_OPEN',
  'OFFER_EXPIRED',
  'OFFER_REVOKED',
  'TASK_ALREADY_CLAIMED',
  'OLDER_REQUEST_PENDING',
  'NEXT_TASK_ALREADY_RESERVED',
  'MOVEMENT_IN_PROGRESS',
  'TASK_NOT_STARTABLE',
  'REASSIGN_BLOCKED_MOVEMENT',
  'CUSTODY_RELEASE_REQUIRED',
  'RETRIEVAL_ALREADY_ACTIVE',
  'TICKET_NOT_PARKED',
  'TICKET_CLOSED',
  'INTAKE_INCOMPLETE',
  'INSPECTION_INCOMPLETE',
  'DRAFT_HAS_DATA',
  'PAPER_SERIAL_IN_USE',
  'KEY_TAG_IN_USE',
  'KEY_SLOT_OCCUPIED',
  'PARKING_SPOT_OCCUPIED',
  'KEY_NOT_PICKED_UP',
  'CUSTODY_HOLDER_MISMATCH',
  'CUSTODY_OPEN',
  'HANDOVER_NOT_READY',
  'HANDOVER_CODE_INVALID',
  'HANDOVER_CODE_EXPIRED',
  'HANDOVER_CODE_LOCKED',
  'HANDOVER_CODE_CONSUMED',
  'PAPER_STUB_MISMATCH',
  'RESEND_LIMIT_REACHED',
  'PAYMENT_PENDING',
  'PAYMENT_AMOUNT_MISMATCH',
  'PAYMENT_METHOD_NOT_ALLOWED',
  'PAYMENT_ALREADY_RECORDED',
  'PAYMENT_ALREADY_REVERSED',
  'TRANSFER_BLOCKED_CUSTODY',
  'TRANSFER_SCOPE_DENIED',
  'TRANSFER_ALREADY_PENDING',
  'ASSIGNMENT_CONFLICT',
  'DRIVER_DISABLED',
  'EVENT_CLOSE_BLOCKED',
  'EVENT_ALREADY_CLOSED',
  'SHIFT_CLOSE_BLOCKED',
  'SHIFT_ALREADY_OPEN',
  'WA_CONSENT_MISSING',
  'WA_NOT_LINKED',
  'WA_LINK_CODE_EXPIRED',
  'WA_CUSTOMER_OPTED_OUT',
  'WA_TEMPLATE_NOT_APPROVED',
  'WA_CHANNEL_UNAVAILABLE',
  'WA_SEND_FAILED',
  'WA_WEBHOOK_SIGNATURE_INVALID',
  'WA_WEBHOOK_VERIFY_FAILED',
  'MEDIA_TOO_LARGE',
  'MEDIA_TYPE_UNSUPPORTED',
  'MEDIA_UPLOAD_INCOMPLETE',
  'PAYLOAD_TOO_LARGE',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
  'SERVICE_UNAVAILABLE',
  'DEPENDENCY_TIMEOUT',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
export const ErrorCodeSchema = z.enum(ERROR_CODES);

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

export const LOG_LEVELS = ['info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface ErrorDef {
  /** HTTP status; the response status always equals it (08 §1.3). */
  http: number;
  /** Short English text for developers and logs (08 `message_en`); never shown to drivers. */
  message: string;
  /** Arabic text ready to display (08 `message_ar`). */
  message_ar: string;
  /** Re-sending the same request with the same `Idempotency-Key` may succeed. */
  retryable: boolean;
  /** Log level of the rejection (08 §4 «السجل»). */
  log: LogLevel;
  /**
   * Supervisor alert type associated with the code (08 §4 «التنبيه»). Whether the rejecting path
   * raises it itself is described per code in 08 (e.g. `wa_channel_down` is raised by the channel
   * health monitor, `transfer_blocked` only for scheduled transfers).
   */
  alert?: AlertType;
}

/** The full catalog of 08 §4, grouped as in 08. */
export const ERROR_CATALOG: Readonly<Record<ErrorCode, ErrorDef>> = {
  // 08 §4.1 الدخول والجلسة
  AUTH_UNAUTHENTICATED: {
    http: 401,
    retryable: false,
    log: 'info',
    message: 'Sign in to continue.',
    message_ar: 'سجّل الدخول للمتابعة.',
  },
  AUTH_INVALID_CREDENTIALS: {
    http: 401,
    retryable: false,
    log: 'warn',
    message: 'Invalid credentials.',
    message_ar: 'بيانات الدخول غير صحيحة.',
  },
  AUTH_ACCOUNT_DISABLED: {
    http: 403,
    retryable: false,
    log: 'warn',
    message: 'This account is disabled. Contact your administrator.',
    message_ar: 'هذا الحساب معطّل. راجع الإدارة.',
  },
  AUTH_ACCOUNT_LOCKED: {
    http: 423,
    retryable: false,
    log: 'warn',
    message: 'Too many attempts. Try again later.',
    message_ar: 'أُوقف الدخول مؤقتًا لكثرة المحاولات. حاول لاحقًا.',
  },
  AUTH_MFA_REQUIRED: {
    http: 401,
    retryable: false,
    log: 'info',
    message: 'The verification step expired. Sign in again.',
    message_ar: 'انتهت خطوة التحقق. سجّل الدخول مجددًا.',
  },
  AUTH_MFA_INVALID: {
    http: 401,
    retryable: false,
    log: 'warn',
    message: 'Incorrect verification code.',
    message_ar: 'رمز التحقق غير صحيح.',
  },
  AUTH_MFA_SETUP_REQUIRED: {
    http: 403,
    retryable: false,
    log: 'info',
    message: 'Set up two-factor authentication to continue.',
    message_ar: 'فعّل التحقق الثنائي لإكمال الدخول.',
  },
  AUTH_SECRET_CHANGE_REQUIRED: {
    http: 403,
    retryable: false,
    log: 'info',
    message: 'Change your temporary PIN or password to continue.',
    message_ar: 'غيّر الرقم السري المؤقت قبل المتابعة.',
  },
  AUTH_SESSION_EXPIRED: {
    http: 401,
    retryable: false,
    log: 'info',
    message: 'Your session expired. Sign in again.',
    message_ar: 'انتهت الجلسة. سجّل الدخول مجددًا.',
  },
  AUTH_SESSION_REVOKED: {
    http: 401,
    retryable: false,
    log: 'info',
    message: 'Your session was ended. Sign in again.',
    message_ar: 'أُنهيت جلستك. سجّل الدخول مجددًا.',
  },
  // 08 §4.2 الصلاحية والنطاق
  PERMISSION_DENIED: {
    http: 403,
    retryable: false,
    log: 'warn',
    message: "You don't have permission for this action.",
    message_ar: 'لا تملك صلاحية هذا الإجراء.',
  },
  SCOPE_VENUE_DENIED: {
    http: 403,
    retryable: false,
    log: 'warn',
    message: 'This is outside your venue scope.',
    message_ar: 'هذا خارج نطاق موقعك.',
  },
  ASSIGNMENT_REQUIRED: {
    http: 403,
    retryable: false,
    log: 'info',
    message: 'You have no active assignment at this venue.',
    message_ar: 'لا يوجد تعيين نشط لك في هذا الموقع. راجع المشرف.',
  },
  DUTY_REQUIRED: {
    http: 409,
    retryable: false,
    log: 'info',
    message: 'Start your shift first.',
    message_ar: 'ابدأ ورديتك أولًا.',
  },
  NOT_TASK_ASSIGNEE: {
    http: 403,
    retryable: false,
    log: 'warn',
    message: "This task isn't assigned to you.",
    message_ar: 'هذه المهمة ليست مسندة إليك.',
  },
  NOT_OFFER_RECIPIENT: {
    http: 403,
    retryable: false,
    log: 'warn',
    message: "This request wasn't offered to you.",
    message_ar: 'لم يُعرض هذا الطلب عليك.',
  },
  // 08 §4.3 الموارد والتحقق من المدخلات
  RESOURCE_NOT_FOUND: {
    http: 404,
    retryable: false,
    log: 'info',
    message: 'Resource not found.',
    message_ar: 'العنصر غير موجود.',
  },
  TICKET_NOT_FOUND: {
    http: 404,
    retryable: false,
    log: 'info',
    message: 'Ticket not found.',
    message_ar: 'التذكرة غير موجودة.',
  },
  OFFER_NOT_FOUND: {
    http: 404,
    retryable: false,
    log: 'info',
    message: 'This offer is no longer available.',
    message_ar: 'هذا الطلب لم يعد متاحًا.',
  },
  VALIDATION_FAILED: {
    http: 422,
    retryable: false,
    log: 'info',
    message: 'Some fields are invalid.',
    message_ar: 'تحقّق من الحقول المحددة.',
  },
  PHONE_INVALID: {
    http: 422,
    retryable: false,
    log: 'info',
    message: 'Invalid phone number.',
    message_ar: 'رقم الجوال غير صالح. تأكد من الرقم ومفتاح الدولة.',
  },
  PLATE_INVALID: {
    http: 422,
    retryable: false,
    log: 'info',
    message: 'Invalid plate number.',
    message_ar: 'رقم اللوحة غير صالح. تحقّق من الأرقام والحروف.',
  },
  CONSENT_REQUIRED: {
    http: 422,
    retryable: false,
    log: 'info',
    message: 'Customer consent is required for WhatsApp.',
    message_ar: 'فعّل موافقة العميل على واتساب أو اختر التذكرة الورقية.',
  },
  REASON_REQUIRED: {
    http: 422,
    retryable: false,
    log: 'info',
    message: 'A reason is required for this action.',
    message_ar: 'اكتب سبب هذا الإجراء.',
  },
  PAGINATION_CURSOR_INVALID: {
    http: 400,
    retryable: false,
    log: 'info',
    message: 'Invalid pagination cursor.',
    message_ar: 'تعذّر تحميل المزيد. حدّث القائمة.',
  },
  // 08 §4.4 التزامن والتكرار والحالة
  VERSION_CONFLICT: {
    http: 409,
    retryable: false,
    log: 'info',
    message: 'The record changed. Refresh and try again.',
    message_ar: 'تغيّرت البيانات. حدّثنا الشاشة، أعد المحاولة.',
  },
  IDEMPOTENCY_KEY_REQUIRED: {
    http: 428,
    retryable: false,
    log: 'warn',
    message: 'The Idempotency-Key header is required.',
    message_ar: 'تعذّر إرسال الطلب. حدّث التطبيق.',
  },
  IDEMPOTENCY_KEY_REUSED: {
    http: 422,
    retryable: false,
    log: 'warn',
    message: 'The idempotency key was reused with a different request.',
    message_ar: 'تعذّر تنفيذ الطلب. أعد المحاولة.',
  },
  IDEMPOTENCY_IN_PROGRESS: {
    http: 409,
    retryable: true,
    log: 'info',
    message: 'The same request is still being processed.',
    message_ar: 'جارٍ تنفيذ الطلب…',
  },
  INVALID_STATE_TRANSITION: {
    http: 409,
    retryable: false,
    log: 'info',
    message: "This action isn't allowed in the current state.",
    message_ar: 'لا يمكن تنفيذ هذا الإجراء في الحالة الحالية.',
  },
  // 08 §4.5 المناوبة والتوفر
  DRIVER_NOT_AVAILABLE: {
    http: 409,
    retryable: false,
    log: 'info',
    message: 'You already have an active task.',
    message_ar: 'لديك مهمة جارية. أكملها أولًا.',
  },
  DRIVER_ON_BREAK: {
    http: 409,
    retryable: false,
    log: 'info',
    message: "You're on break. End your break first.",
    message_ar: 'أنت في استراحة. أنهِ الاستراحة أولًا.',
  },
  DUTY_ALREADY_STARTED: {
    http: 409,
    retryable: false,
    log: 'info',
    message: 'Your shift has already started.',
    message_ar: 'ورديتك بدأت بالفعل.',
  },
  DUTY_END_BLOCKED_CUSTODY: {
    http: 409,
    retryable: false,
    log: 'info',
    message: "You can't end your shift while holding a vehicle, key or task.",
    message_ar: 'لا يمكن إنهاء الوردية وبعهدتك مركبة أو مفتاح أو مهمة.',
  },
  SHIFT_NOT_OPEN: {
    http: 409,
    retryable: false,
    log: 'info',
    message: 'There is no open shift at your venue.',
    message_ar: 'لا توجد وردية مفتوحة في موقعك. راجع المشرف.',
  },
  EVENT_NOT_OPEN: {
    http: 409,
    retryable: false,
    log: 'info',
    message: "The event isn't open.",
    message_ar: 'الحفل غير مفتوح للاستلام.',
  },
  // 08 §4.6 التوزيع والعروض
  OFFER_EXPIRED: {
    http: 410,
    retryable: false,
    log: 'info',
    message: 'This offer has expired.',
    message_ar: 'انتهى وقت هذا الطلب.',
  },
  OFFER_REVOKED: {
    http: 410,
    retryable: false,
    log: 'info',
    message: 'This offer was withdrawn.',
    message_ar: 'سُحب هذا الطلب.',
  },
  TASK_ALREADY_CLAIMED: {
    http: 409,
    retryable: false,
    log: 'info',
    message: 'Another driver accepted this request.',
    message_ar: 'قبل الطلب سائق آخر.',
  },
  OLDER_REQUEST_PENDING: {
    http: 409,
    retryable: false,
    log: 'info',
    message: 'An older request must be accepted first.',
    message_ar: 'يوجد طلب أقدم. اقبله أولًا.',
  },
  NEXT_TASK_ALREADY_RESERVED: {
    http: 409,
    retryable: false,
    log: 'info',
    message: 'You already have a reserved next task.',
    message_ar: 'لديك مهمة تالية محجوزة بالفعل.',
  },
  MOVEMENT_IN_PROGRESS: {
    http: 409,
    retryable: false,
    log: 'info',
    message: 'Finish your current movement first.',
    message_ar: 'أنهِ حركتك الحالية قبل بدء حركة جديدة.',
  },
  TASK_NOT_STARTABLE: {
    http: 409,
    retryable: false,
    log: 'info',
    message: "This task can't be started now.",
    message_ar: 'لا يمكن بدء هذه المهمة الآن.',
  },
  REASSIGN_BLOCKED_MOVEMENT: {
    http: 409,
    retryable: false,
    log: 'info',
    message: "Movement has started; it can't be reassigned.",
    message_ar: 'بدأت الحركة؛ لا يمكن إعادة الإسناد. تواصل مع السائق.',
  },
  CUSTODY_RELEASE_REQUIRED: {
    http: 409,
    retryable: false,
    log: 'info',
    message: 'Confirm the key was returned before withdrawing.',
    message_ar: 'أكّد إعادة المفتاح إلى خانته قبل سحب المهمة.',
  },
  RETRIEVAL_ALREADY_ACTIVE: {
    http: 409,
    retryable: false,
    log: 'info',
    message: 'A retrieval is already active for this ticket.',
    message_ar: 'يوجد طلب إحضار نشط لهذه التذكرة.',
  },
  // 08 §4.7 التذاكر والاستلام
  TICKET_NOT_PARKED: {
    http: 409,
    retryable: false,
    log: 'info',
    message: "The vehicle isn't parked yet.",
    message_ar: 'المركبة ليست متوقفة بعد؛ أكمل الاستلام أولًا.',
  },
  TICKET_CLOSED: {
    http: 409,
    retryable: false,
    log: 'info',
    message: 'This ticket is closed.',
    message_ar: 'التذكرة مغلقة (سُلّمت أو أُلغيت).',
  },
  INTAKE_INCOMPLETE: {
    http: 422,
    retryable: false,
    log: 'info',
    message: 'Intake details are incomplete.',
    message_ar: 'أكمل بيانات الاستلام الناقصة.',
  },
  INSPECTION_INCOMPLETE: {
    http: 409,
    retryable: false,
    log: 'info',
    message: 'Inspection photos are incomplete.',
    message_ar: 'صور الفحص ناقصة. أكملها أو تابع وسيُبلَّغ المشرف.',
    alert: 'inspection_incomplete',
  },
  DRAFT_HAS_DATA: {
    http: 409,
    retryable: false,
    log: 'info',
    message: 'The draft has data; a supervisor must void it.',
    message_ar: 'المسودة فيها بيانات؛ يلزم إلغاؤها من المشرف.',
    alert: 'draft_abandoned',
  },
  PAPER_SERIAL_IN_USE: {
    http: 409,
    retryable: false,
    log: 'info',
    message: 'This paper ticket number is already used in this event.',
    message_ar: 'رقم التذكرة الورقية مستخدم في هذا الحفل.',
  },
  KEY_TAG_IN_USE: {
    http: 409,
    retryable: false,
    log: 'info',
    message: 'This key tag is already in use.',
    message_ar: 'رقم علاقة المفتاح مستخدم لمركبة أخرى.',
  },
  // 08 §4.8 العهدة والمواقف
  KEY_SLOT_OCCUPIED: {
    http: 409,
    retryable: false,
    log: 'info',
    message: 'This key slot is occupied.',
    message_ar: 'خانة المفتاح مشغولة. اختر خانة أخرى.',
  },
  PARKING_SPOT_OCCUPIED: {
    http: 409,
    retryable: false,
    log: 'info',
    message: 'This parking spot is occupied.',
    message_ar: 'الموقف مشغول. اختر موقفًا آخر أو اكتب ملاحظة.',
  },
  KEY_NOT_PICKED_UP: {
    http: 409,
    retryable: false,
    log: 'info',
    message: 'Confirm key pickup first.',
    message_ar: 'أكّد استلام المفتاح أولًا.',
  },
  CUSTODY_HOLDER_MISMATCH: {
    http: 409,
    retryable: false,
    log: 'warn',
    message: "You aren't holding this item.",
    message_ar: 'هذه العهدة ليست لديك.',
  },
  CUSTODY_OPEN: {
    http: 409,
    retryable: false,
    log: 'info',
    message: 'Open custody must be settled first.',
    message_ar: 'توجد عهدة مفتوحة يجب إقفالها أو نقلها أولًا.',
  },
  // 08 §4.9 التسليم
  HANDOVER_NOT_READY: {
    http: 409,
    retryable: false,
    log: 'info',
    message: "The vehicle isn't ready for handover.",
    message_ar: 'المركبة ليست جاهزة للتسليم. اضغط «جاهزة» أولًا.',
  },
  HANDOVER_CODE_INVALID: {
    http: 422,
    retryable: false,
    log: 'info',
    message: 'Incorrect handover code.',
    message_ar: 'الرمز غير صحيح.',
  },
  HANDOVER_CODE_EXPIRED: {
    http: 410,
    retryable: false,
    log: 'info',
    message: 'The handover code has expired.',
    message_ar: 'انتهت صلاحية الرمز. أرسل رمزًا جديدًا للعميل.',
  },
  HANDOVER_CODE_LOCKED: {
    http: 423,
    retryable: false,
    log: 'warn',
    message: 'Verification is locked after too many attempts.',
    message_ar: 'قُفل التحقق بعد محاولات خاطئة. اتصل بالمشرف.',
    alert: 'handover_code_locked',
  },
  HANDOVER_CODE_CONSUMED: {
    http: 409,
    retryable: false,
    log: 'warn',
    message: 'This code was already used.',
    message_ar: 'استُخدم هذا الرمز من قبل.',
  },
  PAPER_STUB_MISMATCH: {
    http: 422,
    retryable: false,
    log: 'info',
    message: "The paper stub number doesn't match.",
    message_ar: 'رقم كعب التذكرة لا يطابق.',
  },
  RESEND_LIMIT_REACHED: {
    http: 429,
    retryable: false,
    log: 'info',
    message: 'The resend limit has been reached.',
    message_ar: 'وصلت للحد الأقصى لإعادة إرسال الرمز. اتصل بالمشرف.',
  },
  // 08 §4.10 التحصيل
  PAYMENT_PENDING: {
    http: 409,
    retryable: false,
    log: 'info',
    message: 'Record the payment before handover.',
    message_ar: 'سجّل التحصيل قبل التسليم.',
  },
  PAYMENT_AMOUNT_MISMATCH: {
    http: 422,
    retryable: false,
    log: 'info',
    message: "The amount doesn't match the event fee.",
    message_ar: 'المبلغ لا يطابق رسوم الحفل.',
  },
  PAYMENT_METHOD_NOT_ALLOWED: {
    http: 422,
    retryable: false,
    log: 'info',
    message: "This payment method isn't allowed for this event.",
    message_ar: 'وسيلة التحصيل غير مسموحة في هذا الحفل.',
  },
  PAYMENT_ALREADY_RECORDED: {
    http: 409,
    retryable: false,
    log: 'info',
    message: 'A payment is already recorded for this ticket.',
    message_ar: 'التحصيل مسجّل مسبقًا لهذه التذكرة.',
  },
  PAYMENT_ALREADY_REVERSED: {
    http: 409,
    retryable: false,
    log: 'info',
    message: 'This payment was already reversed.',
    message_ar: 'هذا التحصيل معكوس مسبقًا.',
  },
  // 08 §4.11 النقل والتعيين والحسابات
  TRANSFER_BLOCKED_CUSTODY: {
    http: 409,
    retryable: false,
    log: 'info',
    message: 'The driver holds custody or an active task.',
    message_ar: 'لا يمكن نقل السائق وبعهدته مركبة أو مفتاح أو مهمة.',
    alert: 'transfer_blocked',
  },
  TRANSFER_SCOPE_DENIED: {
    http: 403,
    retryable: false,
    log: 'warn',
    message: 'A transfer requires scope over both venues.',
    message_ar: 'النقل يحتاج صلاحية على الموقعين.',
  },
  TRANSFER_ALREADY_PENDING: {
    http: 409,
    retryable: false,
    log: 'info',
    message: 'A transfer is already pending for this driver.',
    message_ar: 'يوجد طلب نقل مفتوح لهذا السائق.',
  },
  ASSIGNMENT_CONFLICT: {
    http: 409,
    retryable: false,
    log: 'info',
    message: 'The driver already has an active assignment.',
    message_ar: 'للسائق تعيين نشط آخر؛ استخدم النقل.',
  },
  DRIVER_DISABLED: {
    http: 409,
    retryable: false,
    log: 'info',
    message: "The driver's account is disabled.",
    message_ar: 'حساب السائق معطّل.',
  },
  // 08 §4.12 الحفلات والورديات
  EVENT_CLOSE_BLOCKED: {
    http: 409,
    retryable: false,
    log: 'info',
    message: 'Event close is blocked by open items.',
    message_ar: 'لا يمكن إغلاق الحفل: توجد عناصر مفتوحة.',
  },
  EVENT_ALREADY_CLOSED: {
    http: 409,
    retryable: false,
    log: 'info',
    message: 'The event is already closed.',
    message_ar: 'الحفل مغلق.',
  },
  SHIFT_CLOSE_BLOCKED: {
    http: 409,
    retryable: false,
    log: 'info',
    message: 'Shift close is blocked by drivers holding custody or open tasks.',
    message_ar: 'لا يمكن إغلاق الوردية: سائقون بعهدتهم عناصر أو لديهم مهام مفتوحة.',
  },
  SHIFT_ALREADY_OPEN: {
    http: 409,
    retryable: false,
    log: 'info',
    message: 'A shift is already open for this dispatch pool.',
    message_ar: 'توجد وردية مفتوحة لهذه المجموعة بالفعل.',
  },
  // 08 §4.13 واتساب
  WA_CONSENT_MISSING: {
    http: 409,
    retryable: false,
    log: 'info',
    message: 'There is no valid WhatsApp consent for this customer.',
    message_ar: 'لا توجد موافقة سارية من العميل على واتساب.',
  },
  WA_NOT_LINKED: {
    http: 409,
    retryable: false,
    log: 'info',
    message: "The ticket isn't linked to WhatsApp.",
    message_ar: 'التذكرة غير مربوطة بواتساب.',
  },
  WA_LINK_CODE_EXPIRED: {
    http: 410,
    retryable: false,
    log: 'info',
    message: 'The link code has expired.',
    message_ar: 'انتهت صلاحية رمز الربط. أنشئ رمزًا جديدًا.',
  },
  WA_CUSTOMER_OPTED_OUT: {
    http: 409,
    retryable: false,
    log: 'info',
    message: 'The customer opted out of WhatsApp messages.',
    message_ar: 'أوقف العميل رسائل واتساب. استخدم QR من جوال العميل أو التذكرة الورقية.',
  },
  WA_TEMPLATE_NOT_APPROVED: {
    http: 409,
    retryable: false,
    log: 'error',
    message: "The message template isn't approved.",
    message_ar: 'قالب الرسالة غير معتمد. راجع الإدارة.',
    alert: 'wa_send_failed',
  },
  WA_CHANNEL_UNAVAILABLE: {
    http: 503,
    retryable: true,
    log: 'warn',
    message: 'WhatsApp is currently unavailable.',
    message_ar: 'واتساب متعطل حاليًا. استخدم التذكرة الورقية.',
    alert: 'wa_channel_down',
  },
  WA_SEND_FAILED: {
    http: 502,
    retryable: false,
    log: 'error',
    message: 'WhatsApp message delivery failed.',
    message_ar: 'تعذّر إرسال رسالة واتساب.',
    alert: 'wa_send_failed',
  },
  WA_WEBHOOK_SIGNATURE_INVALID: {
    http: 401,
    retryable: false,
    log: 'warn',
    message: 'Invalid webhook signature.',
    message_ar: 'توقيع Webhook غير صالح', // 08 §4.13 has «—»; canon §8 meaning (DEC-51 proposal)
  },
  WA_WEBHOOK_VERIFY_FAILED: {
    http: 403,
    retryable: false,
    log: 'warn',
    message: 'Webhook verification failed.',
    message_ar: 'فشل تحقق إعداد Webhook', // 08 §4.13 has «—»; canon §8 meaning (DEC-51 proposal)
  },
  // 08 §4.14 الوسائط
  MEDIA_TOO_LARGE: {
    http: 413,
    retryable: false,
    log: 'info',
    message: 'The image is too large.',
    message_ar: 'الصورة كبيرة جدًا. أعد التصوير أو المحاولة.',
  },
  MEDIA_TYPE_UNSUPPORTED: {
    http: 415,
    retryable: false,
    log: 'info',
    message: 'Unsupported file type.',
    message_ar: 'نوع الملف غير مدعوم. استخدم الكاميرا أو صورة JPG.',
  },
  MEDIA_UPLOAD_INCOMPLETE: {
    http: 409,
    retryable: false,
    log: 'info',
    message: "The upload isn't complete.",
    message_ar: 'لم يكتمل رفع الصورة. أعد المحاولة.',
  },
  // 08 §4.15 المنصة
  PAYLOAD_TOO_LARGE: {
    http: 413,
    retryable: false,
    log: 'warn',
    message: 'The request body is too large.',
    message_ar: 'البيانات المرسلة أكبر من المسموح.',
  },
  RATE_LIMITED: {
    http: 429,
    retryable: true,
    log: 'warn',
    message: 'Too many requests.',
    message_ar: 'طلبات كثيرة. انتظر قليلًا ثم حاول.',
  },
  INTERNAL_ERROR: {
    http: 500,
    retryable: true,
    log: 'error',
    message: 'An unexpected error occurred.',
    message_ar: 'حدث خطأ غير متوقع. أعد المحاولة.',
  },
  SERVICE_UNAVAILABLE: {
    http: 503,
    retryable: true,
    log: 'error',
    message: 'The service is temporarily unavailable.',
    message_ar: 'الخدمة غير متاحة مؤقتًا. سنعيد المحاولة تلقائيًا.',
  },
  DEPENDENCY_TIMEOUT: {
    http: 504,
    retryable: true,
    log: 'warn',
    message: 'An external service timed out.',
    message_ar: 'تأخر رد خدمة خارجية. أعد المحاولة.',
  },
};

/** Alias used by docs/08 §9.1 (`ERRORS[code]`). */
export const ERRORS = ERROR_CATALOG;

/** Codes whose `retryable` is true (07 §1.6). */
export const RETRYABLE_ERROR_CODES: readonly ErrorCode[] = ERROR_CODES.filter(
  (c) => ERROR_CATALOG[c].retryable,
);

/** Codes that must carry a `Retry-After` header: every 429 and 503, plus `IDEMPOTENCY_IN_PROGRESS` (08 §1.3/5). */
export function requiresRetryAfter(code: ErrorCode): boolean {
  const { http } = ERROR_CATALOG[code];
  return http === 429 || http === 503 || code === 'IDEMPOTENCY_IN_PROGRESS';
}

/** A business/domain rejection carrying a canon error code (08 §9.1). */
export class DomainError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = 'DomainError';
  }

  get http(): number {
    return ERROR_CATALOG[this.code].http;
  }

  get retryable(): boolean {
    return ERROR_CATALOG[this.code].retryable;
  }
}

/**
 * True for a {@link DomainError}, including one created by another copy of this package
 * (source vs. dist), recognised by its name and a canon code.
 */
export function isDomainError(error: unknown): error is DomainError {
  if (error instanceof DomainError) return true;
  return (
    error instanceof Error &&
    error.name === 'DomainError' &&
    isErrorCode((error as { code?: unknown }).code) &&
    typeof (error as { details?: unknown }).details === 'object'
  );
}
