# واجهات API والتكاملات للإصدار الثاني (مسودة، DEC-459)

نفس قواعد 07: غلاف الأخطاء، `Idempotency-Key` على كل أمر يكتب، `version` للتعارض، والرموز من 08 مع رموز جديدة بنفس الأسلوب.

## 1. مسارات العميل `/v1/customer/*` (رمز وصول قصير + رمز تحديث، لا كوكي)

| المسار | الوظيفة |
|---|---|
| `POST /v1/customer/auth/otp` · `POST /v1/customer/auth/verify` · `POST /v1/customer/auth/refresh` · `POST /v1/customer/auth/logout` | الدخول برمز التحقق (V2-D11) |
| `GET/PATCH /v1/customer/me` · `DELETE /v1/customer/me` | الحساب، وحذفه برمز تحقق |
| `POST /v1/customer/consents` | الموافقات بإصدار النص |
| `GET/POST/DELETE /v1/customer/vehicles[/{id}]` | السيارات |
| `GET /v1/customer/locations` · `GET /v1/customer/locations/{venueId}` | المواقع المعتمدة وأسعارها |
| `GET /v1/customer/pass` | سر بطاقة الدخول المشفّر للجهاز (يولّد QR بلا اتصال) |
| `GET /v1/customer/visits[/{ticketId}]` | الزيارات، والجارية بحالتها الحية وصورها |
| `POST /v1/customer/visits/{ticketId}/request` | طلب السيارة (نفس أمر الطلب في 10، بفاعل العميل) |
| `GET /v1/customer/visits/{ticketId}/handover-code` | رمز التسليم عند الجاهزية فقط (DEC-38) |
| `POST /v1/customer/visits/{ticketId}/pay` | جلسة دفع للزيارة |
| `POST /v1/customer/visits/{ticketId}/rating` | التقييم |
| `POST /v1/customer/subscriptions` · `GET /v1/customer/subscriptions` · `POST …/{id}/cancel` · `POST …/{id}/resume` · `PUT …/{id}/vehicles` | الاشتراكات |
| `GET/POST/DELETE /v1/customer/payment-methods[/{id}]` | البطاقات المحفوظة (رموز البوابة) |
| `GET /v1/customer/invoices[/{id}]` | الفواتير وPDF |
| `POST /v1/customer/devices` | رمز الإشعارات للجهاز |
| `GET /v1/customer/home` | قراءة واحدة لشاشة `C-06`: الزيارة الجارية، الاشتراكات الحية، أقرب المواقع (DEC-482) |

### 1.1 العقود المعتمدة في V2-011 (DEC-482)

المخططات في `packages/shared/src/customer/` (المدخل `@point/shared/customer`)، يستعملها التطبيق ويطبّقها الخادم في V2-010 كما هي. الأغلفة والرموز كما في 07/08: `{ data, meta }` و`{ error }`.

- **الدخول (V2-D11 كما عدّله DEC-460 — واتساب فقط):** `POST /v1/customer/auth/otp` بالجسم `{ phone_e164, device_id, platform, locale }` (جوال سعودي `+9665XXXXXXXX` فقط، `platform` من `ios|android`، `locale` لغة قالب المصادقة) ويرد `{ channel: 'whatsapp', phone_masked, expires_at, resend_available_at, attempts_left }`. الرمز 6 أرقام، صلاحيته 300 ث، وإعادة الإرسال بعد 60 ث من وقت الخادم (قبلها `RATE_LIMITED` مع `details.retry_after_s`)، والرمز الجديد لا يعيد المحاولات. `POST /v1/customer/auth/verify` بالجسم `{ phone_e164, code, device_id, platform }`: الخطأ `CUSTOMER_OTP_INVALID` مع `details.attempts_left`، والخامس يقفل الرقم 15 دقيقة `CUSTOMER_OTP_LOCKED` مع `details.locked_until` (يرفض الطلب والتحقق معًا مدة القفل)، والمنتهي `CUSTOMER_OTP_EXPIRED`. النجاح ينشئ الحساب أول مرة ويرد `{ token_type: 'Bearer', access_token, access_expires_at, refresh_token, refresh_expires_at, account: CustomerMe, is_new_account }`. لا `Idempotency-Key` لمسارات الدخول (حد معدل كـ`/v1/auth/login`).
- **الجلسة:** رمز الوصول 15 دقيقة في `Authorization: Bearer`، ورمز التحديث 60 يومًا لكل جهاز ويُدوَّر في كل `POST /v1/customer/auth/refresh` (`{ refresh_token, device_id }` ← زوج جديد). رمز وصول منتهٍ ← `401 AUTH_SESSION_EXPIRED` (يحدّث التطبيق مرة ويعيد الطلب بالمفتاح نفسه)؛ رمز تحديث منتهٍ أو ملغى أو **مستعمل سابقًا** ← `401 AUTH_SESSION_REVOKED` ويُلغى الجلسة كلها (كشف السرقة). `POST /v1/customer/auth/logout` (`{ refresh_token }`) يلغي جلسة الجهاز ويرد `{ logged_out: true }`.
- **الحساب `CustomerMe`:** `{ id, phone_e164, phone_masked, display_name, locale, status, consents: { terms, privacy, marketing }, profile_complete, vehicles_count, created_at }`، ولكل موافقة `{ kind, current_version, granted, answered_version, answered_at, document_url }` (`granted` إجابة الإصدار الساري فقط، و`null` إن لم يُجب). `profile_complete` يحسبه الخادم: اسم + الشروط والخصوصية بالإصدار الساري؛ و`false` يعيد التطبيق إلى `C-04` (ومنه بعد نشر إصدار جديد من نص مطلوب). `PATCH /v1/customer/me` بـ`{ display_name?, locale? }` (الاسم 2–60 حرفًا بعد التقليم).
- **الموافقات:** `POST /v1/customer/consents` بـ`{ consents: [{ kind, version, granted }] }` لأنواع `terms|privacy|marketing` (و`card_on_file` في مسار الدفع C-10)، صفوف إلحاقية؛ الشروط والخصوصية لا تُرسل إلا `granted: true` (سحبها = حذف الحساب C-20)؛ إصدار غير الساري ← `CUSTOMER_CONSENT_VERSION_STALE` مع `details.kind` و`details.current_version`؛ الرد `CustomerMe`.
- **السيارات:** `POST /v1/customer/vehicles` بـ`{ plate: { country: 'SA', digits, letters_ar }, vehicle_make?, vehicle_model?, vehicle_color?, vehicle_type? }`؛ اللوحة تُطبَّع بقاعدة `tickets` (`normalizeSaudiPlate`: أرقام بأي خط، 1–4، وثلاثة من الحروف السبعة عشر بمقابلها اللاتيني) والخطأ `PLATE_INVALID` مع `details.field`/`reason` كما في 08؛ الشركة واللون مفاتيح 02 §8.4 أو نص «أخرى»؛ الحد 5 سيارات `CUSTOMER_VEHICLE_LIMIT` (`details.max`)، واللوحة المكررة في الحساب `CUSTOMER_VEHICLE_DUPLICATE`. الرد `{ id, plate: { country, digits, letters_ar, letters_en, raw, display }, vehicle_make, vehicle_model, vehicle_color, vehicle_type, in_active_visit, created_at }` و`GET` يرد `{ items }` (بلا مؤشر صفحات).
- **المواقع:** `GET /v1/customer/locations?q&filter&lat&lng&cursor&limit` (`filter` من `subscribed|subscribable|open_now`، `limit` حتى 50) يرد `{ items }` و`meta.next_cursor`؛ العنصر `{ venue_id, name_ar, name_en, category, operator_name_ar, operator_name_en, city, lat, lng, distance_m, open_now, subscriptions_enabled, pay_per_visit_halalas, monthly_from_halalas }` (المبالغ بالهللة شاملة الضريبة، و`open_now` بتوقيت الموقع على ساعة الخادم). `GET /v1/customer/locations/{venueId}` يضيف `{ address, timezone, opening_hours, photo_urls, plans: [{ plan_id, name_ar, vehicles_included, monthly_price_halalas, yearly_price_halalas }] }`، وغير المعتمد `VENUE_NOT_LISTED`.
- **`venue_public_profiles.opening_hours`:** `{ always_open: boolean, days: { sun|mon|tue|wed|thu|fri|sat: [{ open: 'HH:MM', close: 'HH:MM' }] } }` بالتوقيت المحلي للموقع؛ `close` قبل `open` يمتد بعد منتصف الليل، و`24:00` إغلاق عند منتصف الليل، واليوم الغائب مغلق.
- **الرئيسية:** `GET /v1/customer/home?lat&lng` يرد `{ display_name, current_visit, subscriptions, nearby_locations (≤ 5), vehicles_count }`؛ الزيارة `{ ticket_id, venue_id, venue_name_ar, venue_name_en, status, plate_display, received_at }` بلا خانة مفتاح ولا موقف، والاشتراك `{ subscription_id, venue_id, venue_name_ar, venue_name_en, status, billing_cycle, current_period_end, cancel_at_period_end }` (الشكلان الكاملان مع C-12 وC-14).
- **`Idempotency-Key`** إلزامي على `PATCH /v1/customer/me` و`POST /v1/customer/consents` و`POST /v1/customer/vehicles`، والمفتاح المكرر لجسم مختلف `IDEMPOTENCY_KEY_REUSED`.
- **الأخطاء في التطبيق:** يقرأ `code` نصًا حرًا (رمز يضيفه الخادم لاحقًا لا يكسر نسخة مثبتة) ويعرض نص القاموس للرموز المعروفة وإلا `message_ar`.

الاتصال الفوري للعميل: Socket.IO على `/ws` بجلسة العميل، غرفة لكل حساب، والأحداث: `visit.updated`، `subscription.updated`. والإشعارات عبر APNs وFCM.

### 1.2 المنفَّذ في الخادم (V2-010، DEC-495…DEC-499)

المسارات الاثنا عشر لـ`CUSTOMER_ROUTES` تخدمها وحدة `packages/server/src/modules/customer-accounts/` بالمخططات المشتركة كما هي (الرد يُفحص بالمخطط في الاختبارات)، ووثّقها قسم `Customer` في `07_openapi.yaml`.

- **الهوية والجلسة (DEC-497):** `Authorization: Bearer` فقط، بلا كوكي ولا CSRF. رمزا الجلسة معتمان (`pca.…` للوصول 15 دقيقة، `pcr.…` للتحديث 60 يومًا من الدخول)، ولا يُخزَّن منهما إلا sha256 في `customer_account_sessions` (جلسة حية واحدة لكل حساب وجهاز). كل تحديث يدوّر الاثنين، ورمز تحديث غير الحالي أو من جهاز آخر يلغي الجلسة. لا تفتح جلسة العميل مسار موظف أو منصة ولا العكس، والإقلاع يرفض الخلط.
- **رمز الدخول (DEC-496):** قالب المصادقة `point_customer_otp_v1` (عربي/إنجليزي، زر نسخ) على رقم بوينت عبر `job.customer_otp_send` بعد COMMIT؛ `customer_otp_challenges` تحفظ HMAC للرمز ونسخة مشفرة واحدة تُمحى بعد الإرسال. حدود: انتظار 60 ث، 5 رموز للرقم و10 للجهاز في الساعة، 5 أخطاء ثم قفل 15 دقيقة. في التطوير والاختبار يستقبله `tools/wa-simulator`، وفي الاختبار المرحلي لا يُرسل إلا لـ`WA_TEST_RECIPIENT_ALLOWLIST`.
- **الحساب والموافقات (DEC-498):** الإصدارات والروابط من `CUSTOMER_TERMS_VERSION` / `CUSTOMER_PRIVACY_VERSION` / `CUSTOMER_MARKETING_VERSION` و`CUSTOMER_*_URL`؛ الموافقات إلحاقية؛ أفعال العميل في `customer_audit_log` الإلحاقي.
- **السيارات والمواقع (DEC-499):** `normalizeSaudiPlate` المشتركة (وقاعدة `tickets` صارت تستعملها)، الحد 5 تحت قفل صف الحساب؛ المواقع من نموذج القراءة العام لـV2-004 (`listPublicLocations`/`getPublicLocation`: ملفات معتمدة لمواقع نشطة لمشغلين نشطين، `open_now`، صور موقّعة قصيرة العمر) مع المسافة والترتيب ومؤشر الصفحات، والباقات والاشتراكات فارغة حتى جداولها (V2-03x).
- **مفاتيح التكرار:** `customer_idempotency_keys` لكل حساب، بالبروتوكول 07 §1.4.
- **التشغيل مع التطبيق:** `apps/customer/README.md` («الخادم الحقيقي»).

## 2. مسارات المشغل الجديدة (تحت `/v1` كما هي)

| المسار | الوظيفة |
|---|---|
| `POST /v1/tickets/intake-pass` | استلام بمسح بطاقة الدخول (O-01): يتحقق من الرمز المتغير، ينشئ التذكرة `channel='app'` ويحدد الأهلية |
| `GET /v1/venues/{venueId}/public-profile` · `PUT …` · `POST …/photos` · `POST …/submit` | ملف الموقع العام (O-04، V2-004 مبني): القراءة، الحفظ مسودة باستبدال كامل (`expected_version` 0 للإنشاء)، رابط رفع صورة موقّع، الإرسال للمراجعة؛ `venue.manage` (DEC-490 … DEC-494) |
| `GET /v1/settlement/statements[/{id}]` | كشوف التسوية للمشغل (قراءة، O-05) |
| `GET /v1/operator/subscription` | اشتراك النظام وفواتيره (O-06) |

## 3. مسارات المنصة `/v1/platform/*` (أدوار المنصة، MFA)

المشغلون والعقود، المواقع واعتمادها (V2-004 مبني: `GET /v1/platform/venues[/{venueId}]`، `POST …/{venueId}/approve|send-back|hide|unhide`، `PUT …/{venueId}/pricing` بـ`platform.plan_manage`)، الباقات والأسعار، العملاء والاشتراكات (قراءة ودعم)، المدفوعات والاستردادات، كشوف التسوية (إنشاء، إصدار، تسجيل الدفع)، الفواتير، الإعدادات، وسجل المنصة — بمقابل كل شاشة `P-##`.

## 4. Webhooks واردة

| المسار | المصدر | المعالجة |
|---|---|---|
| `POST /webhooks/payments/{gateway}` | بوابة الدفع | توقيع، تخزين خام، معالجة مرة واحدة عبر Outbox (V2 §4.3) — **مبني لـMoyasar: `POST /webhooks/payments/moyasar`** (أدناه) |
| `POST /webhooks/einvoicing` | مزود الفوترة | حالة الإبلاغ/الاعتماد للفاتورة |
| `/webhooks/whatsapp` | Meta | كما هو |

### 4.1 Webhook بوابة الدفع (المنفَّذ في V2-021، DEC-511، DEC-512)

- **المسار:** `POST /webhooks/payments/moyasar` (canon §9.8، فئة حد المعدل `webhook`، بلا جلسة ولا CSRF). الجسم كما يرسله Moyasar: `{ id, type, created_at, secret_token, account_name, live, data }`، و`data` كائن الدفعة؛ الأنواع `payment_paid`، `payment_failed`، `payment_refunded`، `payment_voided`، `payment_authorized`، `payment_captured`، `payment_abandoned`، `payment_verified`.
- **التحقق:** لا توقيع ترويسة لدى Moyasar؛ السر المشترك الذي يُضبط عند إنشاء الـWebhook يصل في `secret_token` داخل الجسم، فيُقرأ الجسم خامًا ويُقارن السر بزمن ثابت مع `MOYASAR_WEBHOOK_SECRET_REF` (والسابق أثناء التدوير) قبل أي معالجة. غيابه أو اختلافه أو جسم غير JSON ← `401 PAYMENT_WEBHOOK_SIGNATURE_INVALID` ولا يُحفظ شيء؛ سر صحيح بلا `id`/`type` ← `422 VALIDATION_FAILED`؛ سر غير مضبوط ← `503` (تعيد البوابة المحاولة).
- **التخزين:** `gateway_webhook_events` مرة لكل `(gateway, event_id)` بلا `secret_token`، وبطاقة مختزلة إلى العلامة وآخر 4 أرقام (لا رقم مقنّع ولا اسم حامل ولا رمز بطاقة محفوظة)، و`body_sha256` للبايتات الأصلية؛ مع `job.payment_webhook_process` في المعاملة نفسها، ثم `200` بلا جسم (والمكرر كذلك).
- **المعالجة (العامل):** لا يُوثق بـ`data` الحدث: يقرأ العامل الدفعة من البوابة (`GET /v1/payments/{id}`) خارج أي معاملة، ثم يطبق سجلها على `online_payments` بالانتقالات الأمامية فقط (`initiated → authorized → paid | failed`، ثم `partially_refunded` / `refunded`)، فالمكرر والمتأخر والمعكوس الترتيب لا يرجع الحالة. كل انتقال في `platform_audit_log` (وفي `audit_log` للمشغل لزيارة) و`customer_audit_log` في المعاملة نفسها. دفعة لا تعرفها بوينت ← `outcome = unknown_payment` وتنبيه `payment_unknown`؛ تعارض (مبلغ آخر، أو `failed` تسميها البوابة `paid`) ← لا يُطبق وتنبيه `payment_mismatch`. عودة العميل من صفحة 3-D Secure لا تغيّر شيئًا وحدها.

### 4.2 الاسترداد والمطابقة (V2-021، DEC-513، DEC-514)

- `POST /v1/platform/payments/{paymentId}/refunds` (`platform.refund_issue`: المالية والمالك، ✓ `Idempotency-Key`) بـ`{ amount_halalas?, reason }`: جزئي أو كامل (غياب المبلغ = كل المتبقي)، لا يتجاوز المدفوع ناقص المسترد وما ينتظر (`REFUND_AMOUNT_EXCEEDS_PAID`)، ومن `paid`/`partially_refunded` فقط (`PAYMENT_NOT_REFUNDABLE`). يرد `201 { refund (requested), payment }`، والبوابة يستدعيها `job.payment_refund_send` بعد COMMIT (استرداد بعد آخر للدفعة)، فتصير `succeeded` أو `failed` مع تنبيه `payment_refund_failed`.
- `job.payments_reconcile` يوميًا (`PAYMENTS_RECONCILE_CRON_UTC`): مدفوعات البوابة ليوم الرياض السابق مقابل `online_payments`، وكل فرق بند في `payment_reconciliation_runs.mismatches` وتنبيه في `platform_alerts`.

## 5. رموز خطأ جديدة (مقترحة، بنمط 08)

رموز العميل المعتمدة في V2-011 بنصوصها ورمز HTTP في `CUSTOMER_ERROR_CATALOG` (`packages/shared/src/customer/errors.ts`، DEC-482)، ومعها رموز 08 التي يعيدها مسار العميل كما هي (`CUSTOMER_REUSED_ERROR_CODES`).

`CUSTOMER_OTP_INVALID`، `CUSTOMER_OTP_EXPIRED`، `CUSTOMER_OTP_LOCKED`، `CUSTOMER_CONSENT_VERSION_STALE`، `CUSTOMER_VEHICLE_LIMIT`، `CUSTOMER_VEHICLE_DUPLICATE`، `PASS_INVALID`، `PASS_EXPIRED`، `SUBSCRIPTION_NOT_ACTIVE`، `SUBSCRIPTION_VEHICLE_NOT_COVERED`، `SUBSCRIPTION_ALREADY_EXISTS`، `PAYMENT_REQUIRED`، `PAYMENT_FAILED`، `PAYMENT_ALREADY_RECORDED`، `VENUE_NOT_LISTED`، `OPERATOR_SUSPENDED`، `ACCOUNT_DELETED`.

## 6. واتساب في الإصدار الثاني (V2-D02)

القناة الواحدة كما هي برقم بوينت. القوالب W-01…W-08 تُعاد صياغتها بعلامة «بوينت» واسم الموقع، ويُضاف:
- رابط اختياري لتحميل التطبيق في رسالة الترحيب.
- قالب مصادقة لرمز التحقق: القناة الوحيدة لرمز الدخول، بلا SMS (DEC-460).
- العميل الذي له حساب ويستخدم الواتساب: الرسائل تُربط بحسابه، وتظهر الزيارة في تطبيقه.

## 7. المتاجر

| المتطلب | Apple App Store | Google Play |
|---|---|---|
| حساب مطوّر باسم المنشأة | Apple Developer Program (منظمة، رقم D-U-N-S) | Google Play Console (منظمة) |
| حذف الحساب من داخل التطبيق | إلزامي | إلزامي (ومعه رابط ويب) |
| تصريح الخصوصية | App Privacy | Data safety |
| الدفع | بوابة دفع خارجية للخدمة الفعلية، بلا IAP (V2-D09) | كذلك |
| الاختبار قبل النشر | TestFlight | Internal / Closed testing |
| الإذن بالكاميرا | لا يلزم العميل (السائق هو من يمسح) | كذلك |
| الإشعارات | APNs بشهادة/مفتاح المنشأة | FCM |
