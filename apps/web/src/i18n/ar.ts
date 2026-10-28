/**
 * Arabic UI copy for the staff app (05 §7.8: no hard-coded text in components).
 * Source of every string: docs/02_Wireframes_Spec.md — §8 (shared dictionary, complete), the screen tables
 * (D-xx / S-xx) and §1.6/§1.9; component-internal strings come from 03 §3 and the design system READMEs.
 * Error texts per code are in ./errors.ts (generated from 08).
 *
 * Brand names are never written here (canon §1, scripts/check-brand.mjs): strings that name a brand use the
 * `{brand}` placeholder (staff brand) and are filled with `fmt()` + `useBrand()`.
 * Keys are stable identifiers; change the text, not the key.
 */

// ---------------------------------------------------------------- 02 §8.1 statuses

export const ticketStatus = {
  received: 'مستلمة',
  parking: 'جارٍ الصف',
  parked: 'متوقفة',
  requested: 'مطلوبة',
  assigned: 'مُسندة',
  assigned_waiting: 'محجوزة تالية',
  retrieving: 'جارٍ الإحضار',
  ready: 'جاهزة',
  delivered: 'مُسلّمة',
  reparking: 'جارٍ إعادة الصف',
  voided: 'ملغاة',
} as const;

export const driverState = {
  available: 'متاح',
  intake_parking: 'يسجل/يصف',
  retrieving: 'يحضر/يسلّم',
  busy_with_next: 'مشغول + مهمة تالية',
  on_break: 'استراحة',
  off_duty: 'خارج الوردية',
} as const;

export const connectionState = {
  online: 'متصل',
  uncertain: 'الاتصال غير مؤكد',
  offline: 'غير متصل',
} as const;

export const taskStatus = {
  queued: 'في الطابور',
  offered: 'معروض',
  broadcast: 'بث',
  assigned_waiting: 'محجوز تالٍ',
  accepted: 'مقبول',
  in_progress: 'جارٍ التنفيذ',
  completed: 'مكتمل',
  canceled: 'ملغى',
} as const;

export const taskType = {
  park: 'صف',
  retrieve: 'إحضار',
  repark: 'إعادة صف',
} as const;

export const waLinkStatus = {
  none: 'غير مربوطة',
  pending_send: 'جارٍ الإرسال',
  pending_confirmation: 'بانتظار تأكيد السائق',
  linked: 'مربوطة',
  failed: 'تعذر الإرسال',
  opted_out: 'أوقف العميل الرسائل',
} as const;

export const inspectionStatus = {
  pending: 'لم يكتمل بعد',
  complete: 'مكتمل',
  incomplete: 'غير مكتمل',
  exception_approved: 'استثناء معتمد',
} as const;

export const paymentStatus = {
  not_required: 'غير مطلوب',
  due: 'مستحق',
  collected: 'محصّل',
  waived: 'معفى',
} as const;

export const paymentMethod = {
  cash: 'نقدًا',
  pos: 'شبكة (نقاط بيع)',
} as const;

export const waMessageStatus = {
  queued: 'في الطابور',
  sent: 'أُرسلت',
  delivered: 'وصلت',
  read: 'قُرئت',
  failed: 'فشلت',
  skipped: 'تُجووزت',
  received: 'واردة',
} as const;

export const eventStatus = {
  draft: 'مسودة',
  open: 'مفتوح',
  closing: 'قيد الإغلاق',
  closed: 'مغلق',
  canceled: 'ملغى',
} as const;

export const shiftStatus = {
  scheduled: 'مجدولة',
  open: 'مفتوحة',
  closed: 'مغلقة',
} as const;

export const transferStatus = {
  pending: 'مجدول',
  blocked: 'متعثر',
  completed: 'تم',
  canceled: 'ملغى',
} as const;

export const userStatus = {
  active: 'نشط',
  disabled: 'معطّل',
} as const;

export const incidentStatus = {
  open: 'مفتوحة',
  in_review: 'قيد المراجعة',
  resolved: 'محلولة',
  closed: 'مغلقة',
} as const;

export const incidentSeverity = {
  low: 'منخفضة',
  medium: 'متوسطة',
  high: 'عالية',
} as const;

export const alertSeverity = {
  info: 'معلومة',
  warning: 'تحذير',
  critical: 'حرج',
} as const;

export const alertStatus = {
  open: 'مفتوح',
  acknowledged: 'مستلم',
  resolved: 'محلول',
} as const;

// ---------------------------------------------------------------- 02 §8.2 alert, incident and custody types

export const alertType = {
  no_drivers_on_duty: 'لا يوجد سائقون في الوردية',
  request_unaccepted: 'طلب لم يُقبل في الوقت المحدد',
  next_task_waiting_long: 'مهمة تالية تنتظر طويلًا',
  idle_driver_while_next_waiting: 'سائق متاح والطلب الأقدم محجوز تالٍ',
  ready_not_collected: 'مركبة جاهزة لم تُستلم',
  wa_send_failed: 'فشل إرسال رسالة واتساب',
  wa_channel_down: 'قناة واتساب متوقفة',
  driver_connection_lost_with_custody: 'انقطع اتصال سائق بعهدته عناصر',
  handover_code_locked: 'رمز تسليم مقفل',
  inspection_incomplete: 'فحص غير مكتمل',
  draft_abandoned: 'مسودة استلام متروكة',
  transfer_blocked: 'نقل سائق متعثر',
  outbox_lag: 'تأخر معالجة الأحداث',
  push_failed_repeatedly: 'فشل متكرر لإشعارات جهاز',
  task_stuck: 'مهمة متوقفة',
  wa_webhook_silent: 'لا تصل أحداث واتساب',
} as const;

export const incidentType = {
  key_missing: 'مفتاح مفقود',
  vehicle_damage: 'ضرر في المركبة',
  customer_absent: 'غياب العميل',
  manual_verification: 'تحقق يدوي',
  lost_ticket: 'فقد التذكرة',
  payment_discrepancy: 'فرق تحصيل',
  inspection_incomplete: 'فحص غير مكتمل',
  wrong_vehicle: 'مركبة خاطئة',
  custody_mismatch: 'عدم تطابق العهدة',
  other: 'أخرى',
} as const;

export const custodyReason = {
  intake: 'استلام من العميل',
  parked: 'صف',
  key_deposited: 'إيداع المفتاح',
  key_pickup: 'استلام المفتاح',
  retrieval_start: 'بدء الإحضار',
  handover: 'تسليم للعميل',
  repark: 'إعادة صف',
  official_transfer: 'نقل عهدة رسمي',
  withdrawal_release: 'تحرير عند السحب',
  manual_reconcile: 'مطابقة يدوية',
  correction: 'تصحيح',
} as const;

/** Custody holder; `{name}` / `{label}` are filled from the data. */
export const custodyHolder = {
  customer: 'العميل',
  driver: 'السائق {name}',
  spot: 'الموقف {label}',
  key_slot: 'الخانة {label}',
  supervisor: 'المشرف {name}',
  unknown: 'غير معروف',
} as const;

export const mediaKind = {
  photo_front: 'الأمام',
  photo_rear: 'الخلف',
  photo_right: 'الجانب الأيمن',
  photo_left: 'الجانب الأيسر',
  photo_extra: 'إضافية',
  photo_damage: 'ضرر',
} as const;

// ---------------------------------------------------------------- 02 §8.3 repeated buttons

export const buttons = {
  continue: 'متابعة',
  cancel: 'إلغاء',
  save: 'حفظ',
  confirm: 'تأكيد',
  retry: 'إعادة المحاولة',
  back: 'العودة',
  open: 'فتح',
  close: 'إغلاق',
  refresh: 'تحديث',
  syncNow: 'مزامنة الآن',
  gotIt: 'فهمت',
} as const;

// ---------------------------------------------------------------- 02 §8.4 intake pick lists

/** Stored as English keys, translated in the UI (02 §9.3 item 16). `other` opens a free-text field. */
export const vehicleColor = {
  white: 'أبيض',
  black: 'أسود',
  silver: 'فضي',
  gray: 'رمادي',
  red: 'أحمر',
  blue: 'أزرق',
  navy: 'كحلي',
  green: 'أخضر',
  beige: 'بيج',
  brown: 'بني',
  gold: 'ذهبي',
  yellow: 'أصفر',
  orange: 'برتقالي',
  other: 'أخرى',
} as const;

export const vehicleMake = {
  toyota: 'تويوتا',
  hyundai: 'هيونداي',
  nissan: 'نيسان',
  kia: 'كيا',
  lexus: 'لكزس',
  ford: 'فورد',
  chevrolet: 'شيفروليه',
  gmc: 'جي إم سي',
  mercedes: 'مرسيدس',
  bmw: 'بي إم دبليو',
  honda: 'هوندا',
  mazda: 'مازدا',
  mitsubishi: 'ميتسوبيشي',
  land_rover: 'لاند روفر',
  audi: 'أودي',
  geely: 'جيلي',
  changan: 'شانجان',
  mg: 'إم جي',
  other: 'أخرى',
} as const;

export const onBehalfReason = {
  paper_ticket: 'العميل حضر بتذكرة ورقية',
  no_whatsapp: 'العميل لا يستخدم واتساب',
  wa_down: 'واتساب متوقف',
  verbal: 'طلب شفهي من العميل',
  other: 'أخرى',
} as const;

// ---------------------------------------------------------------- shared UI states (02 §1.6, §1.9)

export const ui = {
  loading: 'جارٍ…',
  loadingPage: 'جارٍ التحميل',
  syncing: 'جارٍ المزامنة…',
  lastSync: 'آخر مزامنة {time}',
  lastSyncLabel: 'آخر مزامنة',
  requestId: 'رمز المتابعة: {id}',
  forbiddenPage: 'لا تملك صلاحية عرض هذه الصفحة.',
  notFound: 'لم نجد هذا العنصر. ربما أُغلق أو تغيّر.',
  sessionExpired: 'انتهت الجلسة. سجّل الدخول للمتابعة.',
  sessionRevoked: 'أُنهيت جلستك.',
  permissionDenied: 'لا تملك صلاحية هذا الإجراء.',
  scopeDenied: 'هذا العنصر خارج نطاق موقعك.',
  validation: 'راجع الحقول المظللة.',
  versionConflict: 'تغيّرت بيانات هذا السجل. حدّثنا الشاشة؛ راجعها ثم أعد المحاولة.',
  invalidState: 'لا يمكن تنفيذ هذا الإجراء في الحالة الحالية.',
  idempotencyInProgress: 'جارٍ تنفيذ طلبك السابق…',
  idempotencyConflict: 'حدث تعارض في الطلب. أعد المحاولة.',
  rateLimited: 'طلبات كثيرة. انتظر قليلًا ثم حاول.',
  internal: 'حدث خطأ غير متوقع. رمز المتابعة: {id}',
  unavailable: 'الخدمة غير متاحة مؤقتًا. حاول بعد قليل.',
  dutyRequired: 'ابدأ ورديتك أولًا.',
  assignmentRequired: 'لا يوجد تعيين نشط لك على هذا الموقع. تواصل مع مشرفك.',
  reasonRequired: 'اكتب سبب هذا الإجراء.',
  noResponse: 'تعذر الوصول للخادم. سنعيد إرسال الطلب نفسه دون تكرار.',
  offline: 'لا يوجد اتصال بالإنترنت.',
  /** Success toast of setup commands (02 §1.6 names the toast, not its text; docs/progress/notes/pnt-023.md). */
  saved: 'تم الحفظ.',
  /** Placeholder screens until their ticket lands (not part of 02; see docs/progress/notes/pnt-021.md). */
  placeholderTitle: 'قيد الإنشاء',
  placeholderBody: 'تُبنى هذه الشاشة في مرحلة لاحقة من الخطة.',
  notFoundPage: 'الصفحة غير موجودة.',
} as const;

// ---------------------------------------------------------------- navigation (02 §1.3, §1.4; 03 §3.2)

export const nav = {
  home: 'الرئيسية',
  vehicles: 'المركبات',
  account: 'حسابي',
  ops: 'التشغيل',
  drivers: 'السائقون',
  venues: 'المواقع والحفلات',
  reports: 'التقارير',
  admin: 'الإدارة',
  alerts: 'التنبيهات',
  menu: 'القائمة',
  mainNav: 'التنقل الرئيسي',
  sideNav: 'أقسام لوحة المشرف',
  logout: 'تسجيل الخروج',
  switchToDriver: 'التبديل إلى واجهة السائق',
  backToOps: 'العودة إلى لوحة التشغيل',
  back: 'رجوع',
} as const;

// ---------------------------------------------------------------- screens

/** D-01 — الدخول */
export const d01 = {
  title: 'تسجيل الدخول',
  phoneLabel: 'رقم الجوال',
  phonePlaceholder: '5X XXX XXXX',
  secretLabel: 'الرقم السري',
  submit: 'دخول',
  staffLink: 'دخول المشرفين والإدارة',
  forgot: 'نسيت الرقم السري؟ تواصل مع مشرفك.',
  offline: 'لا يوجد اتصال بالإنترنت.',
  phoneInvalid: 'أدخل رقم جوال سعودي صحيح يبدأ بـ 5.',
  reveal: 'إظهار',
  hide: 'إخفاء',
  lockedUntil: 'يمكنك المحاولة بعد {time}',
} as const;

/** D-02 — تغيير الرقم السري */
export const d02 = {
  title: 'تغيير الرقم السري',
  intro: 'اختر رقمًا سريًا من 6 أرقام لا يعرفه غيرك.',
  current: 'الرقم السري الحالي',
  next: 'الرقم السري الجديد',
  confirm: 'تأكيد الرقم الجديد',
  hint: 'لا تستخدم أرقامًا متكررة أو متسلسلة مثل 111111 أو 123456.',
  submit: 'حفظ والمتابعة',
  mismatch: 'الرقمان غير متطابقين.',
  currentWrong: 'الرقم السري الحالي غير صحيح.',
  weak: 'اختر رقمًا سريًا أقوى.',
} as const;

/** D-03 — بدء الوردية واختبار الصوت */
export const d03 = {
  title: 'بدء الوردية',
  assignment: 'تعيينك: {venue}',
  shiftOpenSince: 'الوردية: مفتوحة منذ {time}',
  shiftOpen: 'الوردية: مفتوحة',
  openEvents: 'الحفلات المفتوحة: {events}',
  start: 'بدء الوردية',
  logout: 'تسجيل الخروج',
  notificationsBanner: 'إشعارات الجهاز مساعدة فقط. أبقِ {brand} مفتوحًا أثناء الوردية لتسمع الطلبات.',
  noAssignment: 'لا يوجد تعيين نشط لك على أي موقع. تواصل مع مشرفك لتعيينك.',
  shiftNotOpen: 'لا توجد وردية مفتوحة في {venue} الآن. اطلب من المشرف فتح الوردية.',
  checks: {
    audio: 'الصوت',
    notifications: 'إشعارات الجهاز',
    wakeLock: 'إبقاء الشاشة مضاءة',
  },
  audio: {
    untested: 'لم يُختبر',
    ok: 'يعمل',
    notHeard: 'لم يُسمع',
    blocked: 'محجوب',
  },
  notifications: {
    off: 'غير مفعّلة',
    on: 'مفعّلة',
    denied: 'مرفوضة',
    unsupported: 'غير مدعومة على هذا المتصفح',
    needsInstall: 'تتطلب الإضافة للشاشة الرئيسية',
  },
  wakeLock: {
    supported: 'مدعوم',
    unsupported: 'غير مدعوم',
  },
  testAudio: 'تفعيل واختبار الصوت',
  enableNotifications: 'تفعيل الإشعارات',
  how: 'كيف؟',
  heardQuestion: 'هل سمعت النغمة؟',
  heardYes: 'نعم، سمعتها',
  heardNo: 'لا',
  notHeardHint: 'ارفع صوت الجهاز وأوقف الوضع الصامت ثم أعد الاختبار.',
  deniedHint: 'يمكنك تفعيلها لاحقًا من إعدادات المتصفح. الوظائف الأساسية تعمل دونها.',
  untestedConfirm: 'لم تختبر الصوت بعد، وقد لا تسمع طلبات الإحضار. هل تريد البدء الآن؟',
  testNow: 'اختبار الصوت الآن',
  startWithoutTest: 'البدء دون اختبار',
} as const;

/** D-04 — الرئيسية */
export const d04 = {
  intake: 'استلام مركبة',
  currentTask: 'المهمة الحالية',
  nextTask: 'المهمة التالية',
  offerSection: 'طلب الإحضار',
  emptyTitle: 'لا توجد طلبات إحضار الآن',
  emptyBody: 'ستسمع تنبيهًا عند وصول طلب.',
  onBreak: 'أنت في استراحة ولن تصلك الطلبات.',
  endBreak: 'إنهاء الاستراحة',
  /** Why «استلام مركبة» is disabled, by driver_state. */
  disabled: {
    intake_parking: 'أكمل تسجيل أو صف المركبة الحالية أولًا',
    retrieving: 'لديك مهمة إحضار جارية',
    busy_with_next: 'لديك مهمة إحضار جارية',
    on_break: 'أنت في استراحة',
  },
  noOpenEvent: 'لا يوجد حفل مفتوح في الموقع الآن. تواصل مع المشرف.',
  chooseEvent: 'لأي حفل هذه المركبة؟',
  /** TaskCard rows of the D-04 table: heading before «#n», the stage line, the button. */
  task: {
    intake: { heading: 'تسجيل مركبة', line: 'أكمل بيانات الاستلام', action: 'متابعة التسجيل' },
    park: { heading: 'صف', line: 'اركن المركبة ثم سجّل الموقف وخانة المفتاح', action: 'إتمام الصف' },
    repark: {
      heading: 'إعادة صف',
      line: 'أعد المركبة إلى موقف وسجّل الموقف وخانة المفتاح',
      action: 'إتمام إعادة الصف',
    },
    key: { heading: 'إحضار', line: 'استلم المفتاح من الخانة {slot}', action: 'متابعة' },
    start: { heading: 'إحضار', line: 'ابدأ الإحضار من الموقف {spot}', action: 'متابعة' },
    retrieving: { heading: 'جارٍ الإحضار', line: 'عند الوصول اضغط «جاهزة»', action: 'متابعة' },
    /** The line is «منذ {مدة}» = `components.time.sinceMinutes` (02 §1.2 «منذ 3 د»). */
    ready: { heading: 'بانتظار العميل', action: 'التسليم' },
  },
  /** The reserved next task: badge, then «منذ {مدة}» since the request and this line. */
  reserved: 'محجوزة لك',
  nextLine: 'تبدأ بعد إنهاء مهمتك الحالية. لا تبدأ الحركة قبل ذلك.',
  promoted: 'بدأت مهمتك التالية: #{n}',
  goToTask: 'الانتقال',
} as const;

/** D-05 — استلام مركبة (1): المركبة والعميل */
export const d05 = {
  title: 'استلام مركبة · #{n}',
  steps: { vehicle: 'المركبة والعميل', keyPhotos: 'المفتاح والصور' },
  event: 'الحفل: {event}',
  plateIncomplete: 'أكمل أحرف اللوحة الثلاثة وأرقامها.',
  make: 'الشركة المصنعة',
  model: 'الطراز (اختياري)',
  color: 'اللون',
  paperSerial: 'رقم التذكرة الورقية',
  paperSerialPlaceholder: '004521',
  paperHint: 'انسخ الرقم المطبوع على الكعب كما هو.',
  next: 'التالي',
  notSaved: 'لم تُحفظ الخطوة الأولى على الخادم بعد؛ سنعيد المحاولة تلقائيًا.',
  cancelTitle: 'إلغاء الاستلام؟',
  cancelConfirm: 'إلغاء الاستلام',
  cancelKeep: 'متابعة التسجيل',
  canceled: 'أُلغي الاستلام',
  // not in 02 (docs/progress/notes/pnt-035.md): labels of the «أخرى» free-text fields
  makeOther: 'اسم الشركة',
  colorOther: 'وصف اللون',
} as const;

/** D-06 — استلام مركبة (2): المفتاح والصور */
export const d06 = {
  keyTag: 'رقم علاقة المفتاح',
  photos: 'صور الحالة ({n} من {total})',
  damagePhoto: 'صورة ضرر',
  notes: 'ملاحظات الأضرار (اختياري)',
  incomplete: 'الفحص غير مكتمل: {n} من {total} صور.',
  submit: 'إتمام التسجيل',
  submitWaiting: 'إتمام التسجيل (بانتظار رفع {n} صورة)',
  continueWithout: 'المتابعة دون انتظار',
  inspectionTitle: 'الفحص غير مكتمل ({n} من {total} صور). المتابعة ستُبلغ المشرف لاعتماد استثناء.',
  completePhotos: 'إكمال الصور',
  continueAndNotify: 'متابعة وإبلاغ المشرف',
  needsConnection: 'يلزم الاتصال لإتمام التسجيل',
} as const;

/** D-07 — تأكيد التذكرة الورقية (mode C; WhatsApp modes A/B arrive with PNT-043/PNT-044) */
export const d07 = {
  paperTitle: 'تذكرة ورقية · #{n}',
  paperText: 'سلّم العميل الكعب رقم {serial}، وعلّق الجزء الآخر على المفتاح.',
  stubGiven: 'سلّمت الكعب للعميل',
  toParking: 'متابعة إلى الصف',
} as const;

/** D-08 — إتمام الصف (وإعادة الصف) */
export const d08 = {
  title: 'إتمام الصف',
  reparkTitle: 'إعادة الصف',
  early: 'العميل طلب السيارة أثناء الصف. سيُنشأ طلب الإحضار فور إتمام الصف.',
  zone: 'المنطقة',
  spot: 'الموقف',
  noSpot: 'بدون موقف محدد',
  spotNote: 'وصف المكان',
  spotNotePlaceholder: 'بجانب البوابة 3',
  board: 'لوحة المفاتيح',
  slot: 'الخانة',
  deposited: 'أودعت المفتاح في الخانة المختارة',
  submit: 'تم الصف',
  parked: 'تم صف #{n}',
  chooseBoth: 'اختر الموقف وخانة المفتاح.',
  needsConnection: 'يلزم الاتصال لتسجيل الصف',
} as const;

/** D-09 — بطاقة العرض والبث */
export const d09 = {
  accepted: 'قبلت الطلب #{n}',
  reserved: 'حُجز الطلب #{n} كمهمة تالية. لا تبدأ قبل إنهاء مهمتك الحالية.',
} as const;

/** D-10 — المهمة الحالية (الإحضار) */
export const d10 = {
  title: 'إحضار · #{n}',
  waiting: 'ينتظر العميل منذ {time}',
  keySlot: 'خانة المفتاح: {board} · {slot}',
  spot: 'الموقف: {spot} (المنطقة {zone})',
  damageNotes: 'ملاحظات الأضرار: {notes}',
  photos: 'الصور',
  pickedUp: 'استلمت المفتاح',
  startRetrieval: 'بدء الإحضار',
  ready: 'وصلت — جاهزة',
  handover: 'التسليم',
  stopAtHandover: 'توقف عند نقطة التسليم',
  startHint: 'عند البدء يصل العميل إشعار «جارٍ إحضار سيارتك».',
  readyHint: 'عند الضغط يصل العميل رمز التسليم. لا تطلب الرمز قبل هذه الخطوة.',
  needsConnection: 'يلزم الاتصال لتأكيد كل خطوة',
} as const;

/** D-11 — التسليم والتحصيل */
export const d11 = {
  title: 'التسليم · #{n}',
  askCode: 'اطلب من العميل رمز التسليم',
  codeMeta: 'المحاولات المتبقية: {n} · صالح حتى {time}',
  askStub: 'اطلب من العميل كعب التذكرة الورقية',
  stub: 'رقم الكعب',
  payment: 'التحصيل',
  amountDue: 'المبلغ المستحق: {amount}',
  method: 'طريقة التحصيل',
  posReference: 'رقم إيصال الشبكة (اختياري)',
  posHint: 'رقم الإيصال فقط — لا تُدخل رقم البطاقة.',
  received: 'استلمت المبلغ',
  submit: 'تأكيد التسليم',
  delivered: 'تم تسليم #{n}',
  customerNotified: 'وصل العميل تأكيد التسليم.',
  promoted: 'مهمتك التالية بدأت الآن: #{n}',
  newCode: 'إرسال رمز جديد',
  resent: 'أُرسل رمز جديد للعميل. الرمز السابق لم يعد صالحًا.',
  offline: 'لا يمكن التسليم دون اتصال. انتظر عودة الاتصال أو اطلب المشرف.',
} as const;

/** D-12 — المركبات */
export const d12 = {
  title: 'المركبات',
} as const;

/** D-14 — حسابي */
export const d14 = {
  title: 'حسابي',
  alerts: 'التنبيهات',
  appearance: 'المظهر',
  themeSystem: 'تلقائي',
  themeLight: 'فاتح',
  themeDark: 'داكن',
  changeSecret: 'تغيير الرقم السري',
  endShift: 'إنهاء الوردية',
  logout: 'تسجيل الخروج',
  version: 'الإصدار {version} · الجهاز {device}',
  logoutDuringDuty: 'أنهِ ورديتك قبل تسجيل الخروج حتى لا تُحسب متاحًا.',
  endAndLogout: 'إنهاء الوردية والخروج',
  endShiftConfirm: 'إنهاء الوردية؟ لن تصلك طلبات بعد الآن.',
  addToHomeLink: 'كيف أضيف {brand} إلى الشاشة الرئيسية؟',
  /** «دليل الإضافة للشاشة الرئيسية» (Sheet shared with D-03). */
  guide: {
    iphone: [
      'افتح {brand} في Safari.',
      'اضغط زر المشاركة.',
      'اختر «إضافة إلى الشاشة الرئيسية».',
      'افتح {brand} من الأيقونة الجديدة.',
      'من «حسابي» اضغط «تفعيل الإشعارات».',
    ],
    iphoneNote: 'إشعارات الويب على iPhone تتطلب إضافة الموقع للشاشة الرئيسية وإصدارًا حديثًا من iOS.',
    android: 'من قائمة المتصفح اختر «تثبيت التطبيق» أو «إضافة إلى الشاشة الرئيسية».',
    all: 'الإشعارات مساعدة فقط؛ لا تضمن صوتًا والجهاز مقفل أو صامت. أبقِ {brand} مفتوحًا أثناء الوردية.',
  },
} as const;

/** D-15 — حالات النظام */
export const d15 = {
  offline: 'لا يوجد اتصال. البيانات المعروضة من {time} وقد تكون قديمة.',
  offlineDetail: 'القبول والتسليم متوقفان حتى عودة الاتصال.',
  sessionTitle: 'انتهت جلستك',
  sessionReason: {
    transfer: 'تم نقلك إلى {venue}. سجّل الدخول لمتابعة العمل في موقعك الجديد.',
    disabled: 'تم تعطيل حسابك. تواصل مع الإدارة.',
    admin: 'أُنهيت جلستك من الإدارة. سجّل الدخول من جديد.',
    expired: 'انتهت مدة الجلسة. سجّل الدخول من جديد.',
  },
  login: 'تسجيل الدخول',
  audio: 'الصوت متوقف — اضغط هنا لتفعيله.',
  notificationsDenied: 'الإشعارات مرفوضة؛ أبقِ {brand} مفتوحًا لتسمع الطلبات.',
  update: 'يتوفر تحديث ل{brand}.',
  updateNow: 'تحديث الآن',
  whatsappDown:
    'رسائل واتساب للعملاء متوقفة مؤقتًا. استقبل الطلبات من العملاء مباشرة واستخدم التذكرة الورقية.',
  serviceUnavailable: 'النظام غير متاح مؤقتًا. اتبع الإجراء الورقي حتى عودة الخدمة.',
} as const;

/** S-01 — الدخول والتحقق الثنائي */
export const s01 = {
  title: 'دخول المشرفين والإدارة',
  phoneLabel: 'رقم الجوال',
  passwordLabel: 'كلمة المرور',
  submit: 'دخول',
  mfaTitle: 'أدخل رمز التحقق من تطبيق المصادقة',
  mfaCodeLabel: 'رمز التحقق',
  mfaSubmit: 'تحقق',
  changeTitle: 'تغيير كلمة المرور',
  currentPassword: 'كلمة المرور الحالية',
  newPassword: 'كلمة المرور الجديدة',
  confirmPassword: 'تأكيدها',
  passwordHint: 'استخدم كلمة مرور طويلة يصعب تخمينها.',
  passwordMismatch: 'كلمتا المرور غير متطابقتين.',
  changeSubmit: 'حفظ والمتابعة',
  setupTitle: 'إعداد التحقق الثنائي',
  setupBody: 'امسح الرمز بتطبيق المصادقة على جوالك ثم أدخل الرمز الظاهر.',
  setupManual: 'أو أدخل هذا المفتاح يدويًا في التطبيق:',
  setupQrAlt: 'رمز QR لإعداد التحقق الثنائي',
  setupSubmit: 'تأكيد',
  driverLink: 'دخول السائقين',
} as const;

/** Setup-item status (venues, pools, zones, spots, boards, slots). */
export const setupStatus = {
  active: 'نشط',
  inactive: 'معطّل',
} as const;

/** S-05 — السائقون */
export const s05 = {
  search: 'ابحث بالاسم أو الرقم الوظيفي أو الجوال',
  filters: {
    all: 'الكل',
    available: 'متاح',
    busy: 'مشغول',
    on_break: 'استراحة',
    off_duty: 'خارج الوردية',
    disabled: 'معطّل',
  },
  add: 'إضافة سائق',
  addTitle: 'إضافة سائق',
  fullName: 'الاسم الكامل',
  phone: 'رقم الجوال',
  employeeCode: 'الرقم الوظيفي',
  initialVenue: 'الموقع الأولي (اختياري)',
  tempSecret: 'الرقم السري المؤقت: {secret}. أعطه للسائق؛ سيُطلب منه تغييره عند أول دخول. لن يظهر مرة أخرى.',
  // not in 02 (docs/progress/notes/pnt-023.md)
  venue: 'الموقع',
  allVenues: 'كل المواقع',
  empty: 'لا يوجد سائقون مطابقون.',
  none: 'بلا تعيين',
} as const;

/** S-06 — ملف السائق */
export const s06 = {
  phone: 'رقم الجوال',
  employeeCode: 'الرقم الوظيفي',
  status: 'الحالة',
  duty: 'المناوبة الحالية',
  dutyStart: 'البداية',
  connection: 'الاتصال',
  history: 'سجل التعيينات',
  from: 'من',
  to: 'إلى',
  reason: 'السبب',
  assign: 'تعيين على موقع',
  edit: 'تعديل البيانات',
  disable: 'تعطيل الحساب',
  enable: 'تفعيل الحساب',
  resetSecret: 'إعادة تعيين الرقم السري',
  // not in 02 (docs/progress/notes/pnt-023.md)
  venue: 'الموقع',
  assignReason: 'السبب (اختياري)',
  noDuty: 'لا توجد مناوبة مفتوحة.',
  noHistory: 'لا توجد تعيينات.',
  current: 'التعيين الحالي',
  itemType: {
    vehicle: 'مركبة',
    key: 'مفتاح',
    task: 'مهمة',
    next_task: 'مهمة تالية',
    draft: 'مسودة استلام',
  },
} as const;

/** S-08 — المواقع والحفلات */
export const s08 = {
  newVenue: 'موقع جديد',
  events: 'الحفلات',
  shifts: 'الورديات',
  today: 'اليوم',
  upcoming: 'القادمة',
  closed: 'المغلقة',
  newEvent: 'حفل جديد',
  eventName: 'اسم الحفل',
  host: 'المضيف (اختياري)',
  date: 'التاريخ',
  start: 'البداية',
  end: 'النهاية',
  pricing: 'التسعير',
  included: 'مشمول',
  perVehicle: 'رسوم لكل مركبة',
  amount: 'المبلغ',
  methods: 'وسائل التحصيل',
  open: 'فتح',
  edit: 'تعديل',
  cancel: 'إلغاء',
  newShift: 'وردية جديدة',
  openShift: 'فتح الوردية',
  closeShift: 'إغلاق الوردية',
  closeShiftBody:
    'مناوبات السائقين الذين لا عهدة لديهم ولا مهام مفتوحة تُنهى آليًا؛ يمنع الإغلاق فقط سائق بعهدته عناصر أو لديه مهمة مفتوحة.',
  openEvents: 'الحفلات المفتوحة: {n}',
  shiftLine: 'الوردية: {status}',
  setup: 'إعداد الموقع',
  // not in 02 (docs/progress/notes/pnt-023.md)
  editVenue: 'تعديل الموقع',
  venueCode: 'رمز الموقع',
  venueName: 'اسم الموقع',
  venueNameEn: 'الاسم بالإنجليزية (اختياري)',
  city: 'المدينة (اختياري)',
  address: 'العنوان (اختياري)',
  pool: 'مجموعة التوزيع',
  shiftName: 'اسم الوردية (اختياري)',
  shiftEnd: 'النهاية (اختياري)',
  perVehiclePrice: '{amount} لكل مركبة',
  cancelEvent: 'إلغاء الحفل',
  emptyVenues: 'لا توجد مواقع.',
  emptyEvents: 'لا توجد حفلات في هذا القسم.',
  emptyShifts: 'لا توجد ورديات.',
  noShift: '—',
} as const;

/** S-09 — إعداد الموقع */
export const s09 = {
  sections: {
    parking: 'المناطق والمواقف',
    keys: 'لوحات المفاتيح',
    pools: 'مجموعات التوزيع',
    timers: 'المؤقتات',
    handover: 'التسليم والتحصيل',
    inspection: 'الفحص والصف',
  },
  poolsHint: 'الافتراضي مجموعة واحدة لكل موقع. لا تُنشئ مجموعة إضافية إلا عند فصل التوزيع بين حفلات متزامنة.',
  timersHint: 'القيم أولية قابلة للتعديل بعد الاختبار.',
  occupied: 'لا يمكن تعطيله الآن؛ مشغول بتذكرة مفتوحة.',
  spotsPattern: 'A-01 إلى A-40',
  slotsPattern: '1 إلى 120',
  // not in 02 (docs/progress/notes/pnt-023.md); setting labels are the «المعنى» column of canon §12
  newZone: 'منطقة جديدة',
  zoneName: 'اسم المنطقة',
  addSpots: 'إضافة مواقف',
  newBoard: 'لوحة جديدة',
  boardName: 'اسم اللوحة',
  addSlots: 'إضافة خانات',
  newPool: 'مجموعة جديدة',
  poolName: 'اسم المجموعة',
  defaultPool: 'الافتراضية',
  prefix: 'البادئة',
  from: 'من',
  to: 'إلى',
  disable: 'تعطيل',
  enable: 'تفعيل',
  zonesCount: 'المناطق: {n}',
  spotsCount: 'المواقف: {n}',
  boardsCount: 'اللوحات: {n}',
  slotsCount: 'الخانات: {n}',
  poolsCount: 'المجموعات: {n}',
  emptyZones: 'لا توجد مناطق بعد.',
  emptyBoards: 'لا توجد لوحات مفاتيح بعد.',
  ttlAboveReminder: 'مهلة العرض الفردي أكبر من تذكيره، وكل القيم أعداد موجبة.',
  outOfRange: 'القيمة خارج الحدود المسموحة ({min}–{max}).',
  units: { s: 'ثانية', min: 'دقيقة', ms: 'مللي ثانية' },
  parkingModes: { assigned_spots: 'مواقف مرقمة', free_text: 'وصف المكان', mixed: 'مختلط' },
  settings: {
    'dispatch.single_offer_reminder_s': 'تذكير العرض الفردي',
    'dispatch.single_offer_ttl_s': 'انتهاء العرض الفردي',
    'dispatch.broadcast_reminder_s': 'تذكير واحد للبث المفتوح',
    'dispatch.unaccepted_escalation_s': 'تصعيد للمشرف من وقت دخول الطابور دون قبول',
    'dispatch.next_task_wait_alert_s': 'تنبيه مهمة تالية تنتظر طويلًا',
    'dispatch.idle_driver_alert': 'تنبيه المشرف بوجود متاح بينما الأقدم محجوز تالٍ',
    'dispatch.accept_grace_ms': 'سماحية وصول القبول بعد انتهاء العرض بسبب تأخر الشبكة',
    'dispatch.offline_drivers_last': 'تأخير السائقين ذوي الاتصال غير المؤكد في ترتيب العرض الفردي',
    'handover.code_ttl_min': 'صلاحية رمز التسليم من الجاهزية',
    'handover.max_attempts': 'محاولات الرمز قبل القفل',
    'handover.max_resends': 'حد إعادة الإرسال',
    'ready.uncollected_alert_min': 'تنبيه مركبة جاهزة لم تُستلم',
    'pricing.default_mode': 'الافتراضي للحفلات الجديدة',
    'pricing.default_fee_halalas': 'الرسوم الافتراضية',
    'pricing.allowed_methods': 'وسائل التحصيل',
    'inspection.required_photos': 'صور الفحص الإلزامية',
    'inspection.max_extra_photos': 'صور إضافية',
    'link.qr_ttl_min': 'صلاحية رمز ربط QR',
    'parking.mode': 'نمط الصف',
    'keys.require_slot': 'إلزام خانة مفتاح عند الصف',
  },
} as const;

// ---------------------------------------------------------------- component-internal strings (03 §3)

export const components = {
  loadingLabel: 'جارٍ…',
  close: 'إغلاق',
  phonePrefix: '+966',
  code: {
    label: 'رمز التسليم',
    digit: 'الرقم {n}',
    attemptsLeft: 'المحاولات المتبقية: {n}',
    locked: 'تواصل مع المشرف',
  },
  offer: {
    single: 'طلب إحضار — لك',
    broadcast: 'طلب إحضار — لكل السائقين',
    accept: 'قبول الطلب',
    reserve: 'حجز كمهمة تالية',
    reserveNote: 'احجزه فقط وأنت متوقف. لا تستخدم الجوال أثناء القيادة.',
    viewOnly: 'لديك مهمة تالية محجوزة؛ لا يمكنك حجز أخرى.',
    waitingSince: 'ينتظر منذ {time}',
    waitingSinceLabel: 'ينتظر منذ',
    requiresConnection: 'يتطلب اتصالًا',
    announce: 'طلب إحضار جديد، تذكرة {n}',
    layer: 'طلبات الإحضار',
  },
  ring: {
    remaining: 'متبقٍ {n} ثانية',
  },
  task: {
    current: 'المهمة الحالية',
    next: 'المهمة التالية',
    nextBadge: 'تالية',
  },
  stepper: {
    key: 'المفتاح',
    retrieve: 'الإحضار',
    ready: 'جاهزة',
    handover: 'التسليم',
  },
  plate: {
    label: 'رقم اللوحة',
    other: 'لوحة أخرى',
    otherHint: 'اكتب اللوحة كما هي',
    saudi: 'لوحة سعودية',
    letters: 'أحرف اللوحة',
    selected: 'الأحرف المختارة',
    deleteLast: 'حذف آخر حرف',
    delete: 'حذف',
    aria: 'لوحة: {letters}، {digits}',
  },
  photo: {
    uploading: 'جارٍ الرفع',
    retry: 'إعادة المحاولة',
    capture: 'تصوير {angle}',
    recapture: 'إعادة تصوير {angle}',
    photoOf: 'صورة {angle}',
    extra: 'صورة إضافية',
  },
  qr: {
    title: 'اربط تذكرة سيارتك على واتساب',
    step1: 'امسح الرمز بكاميرا جوالك',
    step2: 'اضغط «إرسال» في واتساب',
    expiresIn: 'ينتهي الرمز خلال {ttl}',
    expiresInLabel: 'ينتهي الرمز خلال',
    expired: 'انتهت صلاحية الرمز',
    driverHint: 'ارفع سطوع الشاشة',
    alt: 'رمز QR لربط التذكرة على واتساب',
  },
  spot: {
    search: 'ابحث برقم الخانة',
    searchLabel: 'بحث عن خانة',
    choose: 'اختر الموقف',
    occupied: 'مشغول',
    note: 'ملاحظة نصية بدل الخانة',
  },
  search: {
    placeholder: 'ابحث برقم اللوحة أو رقم التذكرة',
    label: 'بحث',
    clear: 'مسح البحث',
  },
  filters: 'تصفية',
  colors: 'لون المركبة',
  queue: {
    unassigned: 'غير مُسند',
    waiting: 'ينتظر',
    changed: 'تغيّر',
  },
  driverRow: {
    current: 'الحالية',
    next: 'التالية',
    custody: 'العهدة: {n}',
  },
  alert: {
    ack: 'إقرار',
    resolve: 'حل',
    acked: 'أُقِرّ',
  },
  timeline: {
    failed: 'لم تُسلَّم الرسالة',
  },
  table: {
    prev: 'السابق',
    next: 'التالي',
  },
  dialog: {
    reason: 'السبب (إلزامي)',
  },
  banner: {
    enableAudio: 'تفعيل الصوت',
  },
  money: {
    currency: 'ر.س',
  },
  time: {
    sinceMinutes: 'منذ {n} د',
  },
} as const;

/** Everything in one object for discovery; prefer the named exports above in code. */
export const ar = {
  ticketStatus,
  driverState,
  connectionState,
  taskStatus,
  taskType,
  waLinkStatus,
  inspectionStatus,
  paymentStatus,
  paymentMethod,
  waMessageStatus,
  eventStatus,
  shiftStatus,
  transferStatus,
  userStatus,
  incidentStatus,
  incidentSeverity,
  alertSeverity,
  alertStatus,
  alertType,
  incidentType,
  custodyReason,
  custodyHolder,
  mediaKind,
  buttons,
  vehicleColor,
  vehicleMake,
  onBehalfReason,
  ui,
  nav,
  d01,
  d02,
  d03,
  d04,
  d05,
  d06,
  d07,
  d08,
  d09,
  d10,
  d11,
  d12,
  d14,
  d15,
  s01,
  setupStatus,
  s05,
  s06,
  s08,
  s09,
  components,
} as const;

// ================================================================== supervisor/admin/owner screens
// S-02…S-13 (PNT-074…PNT-092). Texts in «»-quotes of 02 §4 (and 03 / 13 where cited) are verbatim; strings 02
// does not define are listed in docs/progress/notes/web-supervisor.md (DEC-PROPOSED) for 02 §8.5.

/** Shared by the staff screens. */
export const staff = {
  venue: 'الموقع',
  event: 'الحفل',
  allOpenEvents: 'كل الحفلات المفتوحة',
  alertsCount: 'التنبيهات ({n})',
  enableAlertSound: 'تفعيل صوت التنبيهات',
  done: 'تم تنفيذ الإجراء.',
  yes: 'نعم',
  no: 'لا',
  none: '—',
  since: 'منذ {time}',
  withHolder: 'بعهدة {name}',
  me: 'أنا',
  system: 'النظام',
  customerViaWhatsapp: 'العميل عبر واتساب',
  status: 'الحالة',
  type: 'النوع',
  severity: 'الشدة',
  allTypes: 'كل الأنواع',
  from: 'من',
  to: 'إلى',
  time: 'الوقت',
  reason: 'السبب',
  note: 'ملاحظة',
  driver: 'السائق',
  amount: 'المبلغ',
  method: 'وسيلة التحصيل',
  ticket: 'التذكرة',
  loadError: 'تعذر تحميل البيانات.',
  noResults: 'لا توجد نتائج.',
  minValue: 'الحد الأدنى {n}',
  maxValue: 'الحد الأعلى {n}',
  wholeNumber: 'أدخل عددًا صحيحًا.',
  required: 'هذا الحقل مطلوب.',
} as const;

/** Custody subjects (`custody_events.subject`). */
export const custodySubject = {
  vehicle: 'المركبة',
  key: 'المفتاح',
} as const;

/** `payments.status` (not in 02 §8.1). */
export const paymentRecordStatus = {
  recorded: 'مسجّل',
  reversed: 'معكوس',
} as const;

/** `whatsapp_channel.health_status` (02 S-13: «سليمة/متدهورة/متوقفة»). */
export const waHealth = {
  healthy: 'سليمة',
  degraded: 'متدهورة',
  down: 'متوقفة',
} as const;

/** `whatsapp_channel.mode` (02 S-13: «حي/محاكي»). */
export const waChannelMode = {
  live: 'حي',
  simulator: 'محاكي',
} as const;

/** `whatsapp_templates.status`. */
export const waTemplateStatus = {
  draft: 'مسودة',
  pending: 'بانتظار الاعتماد',
  approved: 'معتمد',
  rejected: 'مرفوض',
  paused: 'موقوف مؤقتًا',
  disabled: 'معطّل',
} as const;

/** `outbox_events.status`. */
export const outboxStatus = {
  pending: 'معلّق',
  processing: 'قيد المعالجة',
  done: 'تم',
  failed: 'فشل',
  dead: 'متوقف نهائيًا',
  canceled: 'ملغى',
} as const;

/** `exports.kind`. */
export const exportKind = {
  event_summary: 'ملخص الحفل',
  tickets: 'التذاكر',
  payments: 'التحصيل',
  drivers: 'أداء السائقين',
  messages: 'الرسائل',
  audit: 'سجل التدقيق',
} as const;

/** Timeline lines per `ticket_events.type` (S-03); `{spot}` / `{slot}` / `{kind}` filled from `data`. */
export const ticketEventText = {
  'ticket.created': 'بدء الاستلام',
  'ticket.intake_submitted': 'إصدار التذكرة',
  'ticket.parked': 'صف المركبة',
  'ticket.parked_at': 'صف في {spot} وإيداع المفتاح في {slot}',
  'ticket.retrieval_requested': 'طلب السيارة',
  'ticket.retrieval_requested_early': 'طلب مبكر أثناء الصف',
  'ticket.assigned': 'قبول الطلب',
  'ticket.assigned_waiting': 'حجز كمهمة تالية',
  'ticket.retrieving': 'بدء الإحضار',
  'ticket.ready': 'جاهزة',
  'ticket.delivered': 'تسليم للعميل',
  'ticket.reparking': 'إعادة الصف',
  'ticket.retrieval_canceled': 'إلغاء طلب الإحضار',
  'ticket.voided': 'إلغاء التذكرة',
  'ticket.customer_phone_changed': 'تغيير جوال العميل',
  'ticket.wa_link_changed': 'ربط واتساب: {status}',
  'ticket.inspection_completed': 'اكتمل الفحص',
  'ticket.inspection_exception_approved': 'اعتماد استثناء الفحص',
  'ticket.manually_reconciled': 'مطابقة يدوية',
  'ticket.photo_uploaded': 'رفع صورة {kind}',
} as const;

/** S-02 — لوحة التشغيل */
export const s02 = {
  title: 'لوحة التشغيل',
  noDriversBanner: 'لا يوجد سائقون في الوردية!',
  staleBanner: 'بيانات قديمة — آخر مزامنة {time}',
  kpi: {
    openRequests: 'طلبات مفتوحة',
    oldestWait: 'أقدم انتظار',
    avgAccept: 'متوسط القبول',
    available: 'متاح',
    busyBreak: 'مشغول {busy} · استراحة {onBreak}',
    failedMessages: 'رسائل فاشلة',
    criticalAlerts: 'تنبيهات حرجة',
  },
  tabs: {
    queue: 'الطابور',
    active: 'الجارية',
    next: 'التالية',
    alerts: 'التنبيهات',
    failed: 'الرسائل الفاشلة',
    custody: 'العهدة',
    drivers: 'السائقون',
  },
  tabsLabel: 'أقسام لوحة التشغيل',
  queueHeading: 'الطابور (الأقدم أولًا)',
  queueState: {
    queued: 'في الطابور',
    offered: 'معروض على {driver}',
    offeredAnyone: 'معروض',
    broadcast: 'بث',
    assigned_waiting: 'محجوز تالٍ لـ{driver}',
    accepted: 'مقبول — {driver}',
    in_progress: 'جارٍ الإحضار — {driver}',
  },
  escalation: {
    late: 'متأخر',
    longWait: 'انتظار طويل',
    notCollected: 'لم تُستلم',
  },
  reassign: 'إعادة إسناد',
  emptyQueue: 'لا توجد طلبات الآن',
  emptyActive: 'لا توجد مهام جارية.',
  emptyNext: 'لا توجد مهام تالية.',
  emptyFailed: 'لا توجد رسائل فاشلة.',
  emptyCustody: 'لا توجد مشكلات عهدة.',
  emptyAlerts: 'لا توجد تنبيهات مفتوحة.',
  noEvent: 'لا يوجد حفل مفتوح في هذا الموقع.',
  openEvent: 'فتح حفل',
  searchResults: 'نتائج البحث',
  custodyLine: '{subject} — {holder}',
  failedLine: 'فشل إرسال {purpose}',
} as const;

/** S-03 — تفاصيل التذكرة وسجلها */
export const s03 = {
  screen: 'تفاصيل التذكرة',
  title: 'تفاصيل التذكرة · #{n}',
  actions: 'الإجراءات',
  createdBy: 'سجّلها: {name} {time}',
  parkedBy: 'صفّها: {name} {time}',
  retrievedBy: 'أحضرها: {name}',
  deliveredBy: 'سلّمها: {name}',
  phone: 'الجوال:',
  revealPhone: 'إظهار الرقم',
  channel: 'قناة العميل:',
  channelName: { whatsapp: 'واتساب', paper: 'تذكرة ورقية' },
  inspection: 'الفحص:',
  payment: 'التحصيل:',
  spot: 'الموقف:',
  key: 'المفتاح:',
  tabs: {
    timeline: 'الخط الزمني',
    custody: 'العهدة',
    messages: 'الرسائل',
    photos: 'الصور',
    payments: 'التحصيل',
    incidents: 'الوقائع',
  },
  tabsLabel: 'أقسام التذكرة',
  custodyChain: '{from} ← {to}',
  messageDirection: { outbound: 'إلى العميل', inbound: 'من العميل' },
  emptyCustody: 'لا توجد حركات عهدة.',
  emptyMessages: 'لا توجد رسائل.',
  emptyPhotos: 'لا توجد صور.',
  emptyPayments: 'لا يوجد تحصيل مسجّل.',
  emptyIncidents: 'لا توجد وقائع مرتبطة.',
  noActions: 'لا توجد إجراءات متاحة لهذه التذكرة الآن.',
  action: {
    reassign: 'إعادة الإسناد',
    releaseCustody: 'إقرار إعادة المفتاح',
    cancelRetrieval: 'إلغاء طلب الإحضار',
    repark: 'إعادة الصف لغياب العميل',
    handoverException: 'تسليم استثنائي دون رمز',
    resendCode: 'إعادة إرسال رمز التسليم',
    custodyTransfer: 'نقل عهدة رسمي',
    revealPhone: 'إظهار الجوال',
    onBehalf: 'طلب نيابة عن العميل',
    voidTicket: 'إلغاء التذكرة',
    inspectionException: 'اعتماد استثناء الفحص',
    waiver: 'إعفاء من الرسوم',
    reverse: 'عكس تحصيل',
    openIncident: 'فتح واقعة',
    recordPayment: 'تسجيل التحصيل',
  },
  reassign: {
    title: 'إعادة إسناد #{n}',
    toQueue: 'إعادته للطابور (يُوزع حسب الأولوية)',
    toDriver: 'إسناده لسائق متاح',
    destination: 'الوجهة',
    keyHeld: 'المفتاح بعهدة {name} — أقرّ بإعادته للخانة أولًا',
    confirm: 'تأكيد إعادة الإسناد',
    noAvailable: 'لا يوجد سائق متاح الآن.',
    overridePriority: 'تجاوز أولوية الطلب الأقدم (يُسجّل في التدقيق)',
  },
  release: {
    slot: 'خانة المفتاح',
  },
  cancel: {
    afterMovement:
      'بدأ {driver} إحضار #{n}. الإلغاء يعيد المركبة لإعادة الصف مع {driver} نفسه، ويبقى مشغولًا بها حتى إتمام الصف، ويُبطل رمز التسليم. يصل العميل رسالة الإلغاء (W-07) فقط.',
    confirm: 'تأكيد الإلغاء',
  },
  exception: {
    title: 'تسليم دون رمز (استثناء)',
    phoneLast4: 'مطابقة آخر 4 أرقام من جوال العميل',
    last4: 'آخر 4 أرقام',
    document: 'مطابقة استمارة المركبة أو الهوية',
    documentNote: 'ملاحظة التحقق',
    documentHint: 'مثل: اطّلعت على الهوية الوطنية',
    contents: 'وصف محتويات المركبة',
    minTwo: 'اختر طريقتي تحقق على الأقل؛ رقم اللوحة وحده لا يكفي.',
    paymentSection: 'التحصيل',
    collectedBy: 'المحصّل',
    posReference: 'مرجع جهاز نقاط البيع',
    posHint: 'رمز الموافقة أو رقم الإيصال القصير — لا تكتب رقم البطاقة',
    confirm: 'تأكيد التسليم الاستثنائي',
  },
  reveal: {
    reasons: {
      no_show: 'التواصل مع العميل لعدم الحضور',
      fix_number: 'تصحيح رقم',
      incident: 'واقعة',
      other: 'أخرى',
    },
    reasonLegend: 'سبب الإظهار',
    otherReason: 'اكتب السبب',
    audit: 'يُسجّل هذا الإجراء في سجل التدقيق.',
    call: 'اتصال',
    remaining: 'يعود الرقم مقنّعًا خلال {s} ث',
  },
  void: {
    custodyReturned: 'تحققت أن المركبة والمفتاح عادا للعميل أو لم يُستلما',
  },
  reverse: {
    warning: 'العكس بلا بديل يعيد التذكرة مستحقة؛ لتصحيح الوسيلة استخدم البديل',
    withReplacement: 'تسجيل تحصيل بديل',
  },
  onBehalf: {
    legend: 'سبب الطلب',
  },
  transfer: {
    subject: 'العنصر',
    holder: 'الحائز الجديد',
    holderType: { driver: 'سائق', supervisor: 'أنا (المشرف)', spot: 'موقف', key_slot: 'خانة مفتاح' },
    target: 'الحائز',
  },
  incident: {
    title: 'فتح واقعة',
  },
} as const;

/** S-04 — مركز التنبيهات */
export const s04 = {
  title: 'مركز التنبيهات',
  statusFilter: { open: 'مفتوحة', acknowledged: 'مستلمة', resolved: 'محلولة' },
  resolveTitle: 'حل التنبيه',
  resolveNote: 'ملاحظة الحل',
  resolveNoteRequired: 'اكتب ملاحظة الحل.',
  empty: 'لا توجد تنبيهات مفتوحة.',
} as const;

/** S-07 — نقل سائق */
export const s07 = {
  screen: 'نقل سائق',
  title: 'نقل سائق · {name} ({code})',
  steps: { destination: 'الوجهة', schedule: 'الموعد', confirm: 'التحقق والتأكيد' },
  from: 'من: {venue} (الحالي)',
  to: 'إلى',
  toHint: 'مواقع نطاقك فقط',
  schedule: 'الموعد',
  now: 'الآن',
  later: 'في وقت محدد',
  at: 'الوقت',
  checklist: 'التحقق من العهدة',
  vehicles: 'مركبات بعهدته: {n}',
  keys: 'مفاتيح بعهدته: {n}',
  movement: 'مهمة جارية أو صف/إعادة صف: {v}',
  acceptedBeforeKey: 'إحضار مقبول قبل استلام المفتاح: {v}',
  acceptedNote: '(يُعاد للطابور إن وُجد)',
  nextTask: 'مهمة تالية محجوزة: {v}',
  nextNote: 'ستُعاد لطابور {venue}',
  offers: 'عروض فردية حية',
  offersNote: 'ستُسحب',
  mustRelease: '#{n} — يجب إعادته أو نقله رسميًا',
  after: 'بعد النقل: تُنهى جلسته الحالية، وتنقطع صلاحياته في {venue}، ويحتفظ السجل التاريخي بموقعه الأصلي.',
  reason: 'سبب النقل (إلزامي)',
  confirm: 'تأكيد النقل',
  successNow: 'تم نقل {name} إلى {venue}. أُنهيت جلسته في {from}.',
  successScheduled: 'جُدول نقل {name} إلى {venue} الساعة {time}.',
  pending: 'نقل {status} إلى {venue} — {time}',
  cancelPending: 'إلغاء النقل المجدول',
  noAssignment: 'لا يوجد تعيين نشط لهذا السائق.',
  timeRequired: 'اختر موعد النقل.',
} as const;

/** S-10 — إغلاق الحفل والمطابقة */
export const s10 = {
  title: 'إغلاق الحفل · {name}',
  steps: { start: 'بدء الإغلاق', reconcile: 'المطابقة', close: 'الإغلاق' },
  startBody: 'بدء الإغلاق يمنع تسجيل مركبات جديدة في هذا الحفل، وتستمر الطلبات الحالية.',
  openTickets: 'تذاكر مفتوحة: {n}',
  pendingRequests: 'طلبات معلقة: {n}',
  openTasks: 'مهام مفتوحة: {n}',
  driverCustody: 'عهدة لدى سائقين: {n}',
  cashOutstanding: 'تحصيل غير مسلّم: {amount}',
  unsettled: 'تحصيل مستحق: {n}',
  integrity: 'خلل في سلامة التحصيل: {n}',
  openTicketsHeading: 'التذاكر المفتوحة',
  requestsHeading: 'الطلبات والمهام المفتوحة',
  custodyHeading: 'العهدة لدى السائقين',
  unsettledHeading: 'التحصيل المستحق',
  cashByDriver: 'التحصيل حسب السائق',
  discrepancies: 'الفروقات',
  warnings: 'تحذيرات لا تمنع الإغلاق',
  openIncidents: 'وقائع مفتوحة: {n}',
  failedMessages: 'رسائل فاشلة: {n}',
  keyOf: 'مفتاح #{n}',
  transferCustody: 'نقل عهدة',
  collected: 'مسجّل {amount}',
  handed: 'مُسلّم {amount}',
  outstanding: 'بعهدته {amount}',
  difference: 'الفرق {amount}',
  receiveCash: 'استلام نقد',
  expected: 'المبلغ المتوقع',
  received: 'المبلغ المستلم',
  differencePreview: 'الفرق: {amount}',
  cashDiffOf: 'فرق تحصيل {name} {amount}',
  openIncident: 'فتح واقعة',
  close: 'إغلاق الحفل',
  closed: 'أُغلق الحفل. التقرير متاح.',
  viewReport: 'عرض التقرير',
  blockedHint: 'لا يمكن الإغلاق قبل حل البنود المظللة.',
  allClear: 'لا توجد بنود مانعة.',
} as const;

/** S-11 — التقارير والتصدير */
export const s11 = {
  title: 'التقارير والتصدير',
  period: 'الفترة',
  periodInvalid: 'اختر فترة صحيحة: «من» لا يتجاوز «إلى».',
  chooseEvent: 'اختر حفلًا لعرض ملخصه.',
  cards: {
    eventSummary: 'ملخص الحفل',
    drivers: 'أداء السائقين',
    payments: 'التحصيل',
    messages: 'الرسائل',
  },
  summary: {
    vehicles: 'عدد المركبات',
    delivered: 'المسلّمة',
    canceled: 'الدورات الملغاة (منفصلة)',
    reparks: 'إعادات الصف',
    accept: 'زمن القبول',
    start: 'زمن بدء الإحضار',
    requestToReady: 'الطلب حتى الجاهزية',
    readyToDelivered: 'الجاهزية حتى التسليم',
    openAtClose: 'تذاكر مفتوحة عند الإغلاق',
    p90: 'p90 {v}',
  },
  canceledNote: 'الدورات الملغاة لا تدخل متوسط التسليم وتظهر منفصلة.',
  driversCols: {
    intakes: 'الاستلامات',
    retrievals: 'الإحضارات',
    delivered: 'المسلّمة',
    accept: 'متوسط القبول',
    expired: 'العروض المنتهية',
  },
  paymentsCols: {
    reversed: 'العكس',
    waived: 'الإعفاءات',
    outstanding: 'المستحق',
  },
  messagesCols: {
    sent: 'المرسلة',
    delivered: 'الواصلة',
    read: 'المقروءة',
    failed: 'الفاشلة حسب السبب',
  },
  export: 'تصدير CSV',
  exportBody: 'يُسجّل التصدير في سجل التدقيق.',
  exportKind: 'نوع التصدير',
  exportStatus: {
    pending: 'جارٍ التجهيز…',
    running: 'جارٍ التجهيز…',
    ready: 'جاهز للتنزيل',
    failed: 'تعذر التصدير',
    expired: 'انتهت صلاحية رابط التنزيل',
  },
  download: 'تنزيل',
} as const;

/** S-12 — الوقائع */
export const s12 = {
  title: 'الوقائع',
  create: 'فتح واقعة',
  description: 'الوصف',
  owner: 'المسؤول',
  history: 'سجل التحديثات',
  resolution: 'الحل',
  resolutionRequired: 'اكتب الحل قبل إغلاق الواقعة.',
  descriptionRequired: 'اكتب وصف الواقعة.',
  assignMe: 'تعييني مسؤولًا',
  unassigned: 'بلا مسؤول',
  empty: 'لا توجد وقائع.',
  opened: 'فُتحت {time} — {name}',
  updated: 'آخر تحديث {time}',
  resolvedAt: 'حُلّت {time} — {name}',
  closedAt: 'أُغلقت {time}',
  moveTo: 'نقل الحالة إلى',
} as const;

/** S-13 — الإدارة */
export const s13 = {
  title: 'الإدارة',
  sections: {
    staff: 'الموظفون',
    channel: 'قناة واتساب',
    templates: 'القوالب',
    outbox: 'صندوق الأحداث',
    audit: 'سجل التدقيق',
    retention: 'سياسة الاحتفاظ',
    org: 'إعدادات المؤسسة',
  },
  channel: {
    displayName: 'اسم العرض',
    number: 'الرقم',
    status: 'الحالة',
    quality: 'تقييم الجودة',
    healthChanged: 'آخر تغيّر للحالة',
    mode: 'الوضع',
    secrets: 'الأسرار',
    secretConfigured: { true: 'مضبوط', false: 'غير مضبوط' },
    secretNames: { access_token: 'رمز الوصول', app_secret: 'سر التطبيق', verify_token: 'رمز التحقق' },
    businessAccountId: 'معرّف حساب الأعمال',
    phoneNumberId: 'معرّف الرقم',
    phoneDisplay: 'الرقم الظاهر',
    apiVersion: 'إصدار الواجهة',
    accessTokenRef: 'مرجع رمز الوصول',
    appSecretRef: 'مرجع سر التطبيق',
    verifyTokenRef: 'مرجع رمز التحقق',
    refsHint: 'مراجع لمدير الأسرار فقط؛ لا تُكتب الأسرار هنا.',
    empty: 'لم تُضبط القناة بعد.',
  },
  templates: {
    approval: 'حالة الاعتماد',
    lastSync: 'آخر مزامنة',
    sync: 'مزامنة من Meta',
    preview: 'معاينة',
    empty: 'لا توجد قوالب.',
  },
  outbox: {
    attempts: 'المحاولات',
    lastError: 'آخر خطأ',
    age: 'العمر',
    olderThan: 'أقدم من (ثانية)',
    empty: 'لا توجد أحداث عالقة أو فاشلة.',
  },
  audit: {
    actor: 'الفاعل',
    action: 'الإجراء',
    entity: 'الكيان',
    entityId: 'معرّف الكيان',
    before: 'قبل',
    after: 'بعد',
    search: 'بحث',
    empty: 'لا توجد سجلات مطابقة.',
  },
  retention: {
    photos_days: 'الصور (أيام)',
    wa_messages_days: 'رسائل واتساب (أيام)',
    tickets_months: 'التذاكر (أشهر)',
    audit_months: 'سجل التدقيق (أشهر)',
    wa_raw_days: 'أجسام Webhook الخام (أيام)',
    analytics_months: 'القياسات (أشهر)',
    warning: 'تُطبّق المدد بمهمة دورية، وتُستثنى التذاكر المرتبطة بوقائع مفتوحة.',
    approved: 'معتمدة من المالك',
    proposed: 'قيم مقترحة بانتظار اعتماد المالك',
  },
  org: {
    security: 'الأمان',
    heartbeat: 'النبض',
    supervisor_mfa_required: 'إلزام التحقق الثنائي للمشرفين',
    driver_session_hours: 'مدة جلسة السائق بالساعات',
    staff_session_hours: 'مدة جلسة الطاقم بالساعات',
    max_login_attempts: 'عدد محاولات الدخول قبل القفل',
    admin_idle_minutes: 'دقائق خمول الإدارة',
    reveal_phone_per_hour: 'حد كشف الجوال في الساعة',
    interval_s: 'الفاصل بالثواني',
    uncertain_after_s: 'حد «غير مؤكد» بالثواني',
    offline_after_s: 'حد «منقطع» بالثواني',
    heartbeatRule: 'الفاصل أقل من حد «غير مؤكد»، وحد «غير مؤكد» أقل من حد «منقطع».',
    notice: 'تغيير إعدادات الأمان يسري على الجلسات الجديدة، وإعدادات النبض تصل للأجهزة فورًا.',
  },
  notBuilt: 'يُبنى هذا القسم في تذكرة لاحقة.',
} as const;
