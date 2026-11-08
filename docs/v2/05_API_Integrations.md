# واجهات API والتكاملات للإصدار الثاني (مسودة، DEC-459)

نفس قواعد 07: غلاف الأخطاء، `Idempotency-Key` على كل أمر يكتب، `version` للتعارض، والرموز من 08 مع رموز جديدة بنفس الأسلوب.

## 1. مسارات العميل `/v1/customer/*` (رمز وصول قصير + رمز تحديث، لا كوكي)

| المسار | الوظيفة |
|---|---|
| `POST /v1/customer/auth/otp` · `POST /v1/customer/auth/verify` · `POST /v1/customer/auth/refresh` · `POST /v1/customer/auth/logout` | الدخول برمز التحقق (V2-D11) |
| `GET/PATCH /v1/customer/me` · `DELETE /v1/customer/me` · `POST /v1/customer/auth/reauth/verify` | الحساب، وحذفه برمز تحقق جديد (§1.3) |
| `POST /v1/customer/consents` | الموافقات بإصدار النص |
| `GET/POST/DELETE /v1/customer/vehicles[/{id}]` | السيارات |
| `GET /v1/customer/locations` · `GET /v1/customer/locations/{venueId}` | المواقع المعتمدة وأسعارها |
| `GET /v1/customer/pass` | سر بطاقة الدخول المشفّر للجهاز (يولّد QR بلا اتصال) |
| `GET /v1/customer/visits[/{ticketId}]` | الزيارات، والجارية بحالتها الحية وصورها |
| `POST /v1/customer/visits/{ticketId}/request` | طلب السيارة (نفس أمر الطلب في 10، بفاعل العميل) |
| `GET /v1/customer/visits/{ticketId}/handover-code` | رمز التسليم عند الجاهزية فقط (DEC-38) |
| `POST /v1/customer/visits/{ticketId}/pay` · `GET /v1/customer/payments/{paymentId}` | جلسة دفع للزيارة، وحالتها بعد 3-D Secure (§1.5، V2-022) |
| `POST /v1/customer/visits/{ticketId}/rating` | التقييم |
| `POST /v1/customer/subscriptions` · `GET /v1/customer/subscriptions` · `POST …/{id}/cancel` · `POST …/{id}/resume` · `PUT …/{id}/vehicles` | الاشتراكات |
| `GET/POST /v1/customer/payment-methods` · `PATCH/DELETE /v1/customer/payment-methods/{paymentMethodId}` | البطاقات المحفوظة (رموز البوابة، §1.5، V2-023) |
| `GET /v1/customer/invoices` · `GET /v1/customer/invoices/{invoiceId}` | الفواتير المبسطة والإشعارات الدائنة، وPDF برابط خاص قصير (C-17، V2-040، DEC-548) |
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

الاتصال الفوري للعميل: Socket.IO على `/ws` بجلسة العميل، غرفة لكل حساب، والأحداث: `visit.updated`، `subscription.updated`. والإشعارات عبر APNs وFCM (من خلال Expo Push API، V2-016). المنفَّذ في §1.5.

### 1.2 المنفَّذ في الخادم (V2-010، DEC-495…DEC-499)

المسارات الاثنا عشر لـ`CUSTOMER_ROUTES` تخدمها وحدة `packages/server/src/modules/customer-accounts/` بالمخططات المشتركة كما هي (الرد يُفحص بالمخطط في الاختبارات)، ووثّقها قسم `Customer` في `07_openapi.yaml`.

- **الهوية والجلسة (DEC-497):** `Authorization: Bearer` فقط، بلا كوكي ولا CSRF. رمزا الجلسة معتمان (`pca.…` للوصول 15 دقيقة، `pcr.…` للتحديث 60 يومًا من الدخول)، ولا يُخزَّن منهما إلا sha256 في `customer_account_sessions` (جلسة حية واحدة لكل حساب وجهاز). كل تحديث يدوّر الاثنين، ورمز تحديث غير الحالي أو من جهاز آخر يلغي الجلسة. لا تفتح جلسة العميل مسار موظف أو منصة ولا العكس، والإقلاع يرفض الخلط.
- **رمز الدخول (DEC-496):** قالب المصادقة `point_customer_otp_v1` (عربي/إنجليزي، زر نسخ) على رقم بوينت عبر `job.customer_otp_send` بعد COMMIT؛ `customer_otp_challenges` تحفظ HMAC للرمز ونسخة مشفرة واحدة تُمحى بعد الإرسال. حدود: انتظار 60 ث، 5 رموز للرقم و10 للجهاز في الساعة، 5 أخطاء ثم قفل 15 دقيقة. في التطوير والاختبار يستقبله `tools/wa-simulator`، وفي الاختبار المرحلي لا يُرسل إلا لـ`WA_TEST_RECIPIENT_ALLOWLIST`.
- **الحساب والموافقات (DEC-498):** الإصدارات والروابط من `CUSTOMER_TERMS_VERSION` / `CUSTOMER_PRIVACY_VERSION` / `CUSTOMER_MARKETING_VERSION` و`CUSTOMER_*_URL`؛ الموافقات إلحاقية؛ أفعال العميل في `customer_audit_log` الإلحاقي.
- **السيارات والمواقع (DEC-499):** `normalizeSaudiPlate` المشتركة (وقاعدة `tickets` صارت تستعملها)، الحد 5 تحت قفل صف الحساب؛ المواقع من نموذج القراءة العام لـV2-004 (`listPublicLocations`/`getPublicLocation`: ملفات معتمدة لمواقع نشطة لمشغلين نشطين، `open_now`، صور موقّعة قصيرة العمر) مع المسافة والترتيب ومؤشر الصفحات، والباقات والاشتراكات فارغة حتى جداولها (V2-03x).
- **مفاتيح التكرار:** `customer_idempotency_keys` لكل حساب، بالبروتوكول 07 §1.4.
- **التشغيل مع التطبيق:** `apps/customer/README.md` («الخادم الحقيقي»).

### 1.3 حذف السيارة وحذف الحساب (V2-012، V2-017، DEC-505…DEC-508)

ثلاثة مسارات في `CUSTOMER_ROUTES` (مجموعة واحدة في آخر السجل) وفي قسم `Customer` من `07_openapi.yaml`:

- **`DELETE /v1/customer/vehicles/{vehicleId}`** (`C-15`، `Idempotency-Key`، بلا جسم): إزالة ناعمة (`removed_at`) لا حذف فعلي، تحت قفل صف الحساب، فتتحرر اللوحة لإضافة لاحقة؛ الرد `{ vehicle_id, removed_at }`. سيارة حساب آخر أو غير موجودة أو أُزيلت سابقًا ← `RESOURCE_NOT_FOUND` (`resource: customer_vehicle`) بالرد نفسه، وسيارة `in_active_visit` ← `CUSTOMER_VEHICLE_IN_ACTIVE_VISIT` (409) ولا يُكتب شيء.
- **`POST /v1/customer/auth/reauth/verify`** (`C-20`، Bearer، بلا `Idempotency-Key`، صنف `auth`): يطلب التطبيق رمزًا لرقم الحساب نفسه بمسار الدخول `POST /v1/customer/auth/otp` (القالب والحدود نفسها، واتساب فقط)، ثم يرسل `{ code }` هنا. القواعد كتحقق الدخول (`CUSTOMER_OTP_INVALID`/`_LOCKED`/`_EXPIRED`)؛ النجاح يستهلك الرمز ويرد `{ reauth_token, expires_at }`: دليل لمرة واحدة مرتبط بالجلسة نفسها، صالح `CUSTOMER_REAUTH_TTL_S` = 300 ث، لا يُخزَّن منه إلا sha256 (`customer_account_sessions.reauth_hash`)، والأحدث يحل محل السابق.
- **`DELETE /v1/customer/me`** (`C-20`، `Idempotency-Key`) بالجسم `{ reauth_token }`: بلا دليل أو بدليل ليس الحي لهذه الجلسة أو منتهٍ ← `CUSTOMER_REAUTH_REQUIRED` (403، `reason`: `missing`/`invalid`/`expired`؛ 403 لا 401 كي لا يُخرج التطبيقَ)، وأثناء زيارة جارية ← `CUSTOMER_ACCOUNT_VISIT_ACTIVE` (409). في معاملة واحدة: `status = 'deleted'` و`deleted_at`، يُمحى الاسم ويصير الجوال `NULL` وتبقى بصمته `phone_hash = HMAC-SHA256(CODE_PEPPER, customer_phone:<phone>)` (لا تُعكس، ويسجّل الرقم نفسه حسابًا **جديدًا** لاحقًا)، تُزال السيارات، تُلغى كل الجلسات (`account_closed`) وتُسقط رموز الإشعارات وأدلة إعادة التحقق، يُغلق رمز دخول مفتوح للرقم، وتُحذف ردود الأوامر المخزنة للحساب في `customer_idempotency_keys` (قد تحمل الاسم والجوال). يبقى: `customer_audit_log` (`customer.account.deleted` بالأعداد فقط) و`customer_account_consents`، وصفوف `customers` لدى المشغلين وتذاكرهم وبياناتها بحسب احتفاظ كل مشغل في الإصدار الأول (V2-D12) — لا شيء يمتد إلى بيانات المشغل. الرد `{ deleted: true, deleted_at }`. بعدها رمز الوصول أو التحديث الحالي للحساب ← `ACCOUNT_DELETED` (410) فيعود التطبيق إلى `C-01`، وإعادة الطلب بالمفتاح نفسه ترد `ACCOUNT_DELETED` أيضًا (الحارس قبل التكرار)، فيعدّها التطبيق نجاحًا. الاشتراكات ووسائل الدفع تُلغى هنا حين تُبنى (V4/V3).

### 1.4 بطاقة الدخول (V2-013، DEC-500)

- **`GET /v1/customer/pass`** (`C-11`، Bearer، بلا `Idempotency-Key`، صنف `read`، `Cache-Control: private, no-store`) يرد `CustomerPass`: `{ scheme: 'P1', account_id, secret, step_seconds: 30, server_time, rotated_at, refresh_after, vehicles: [{ vehicle_id, plate_display, vehicle_make, vehicle_color }] }`. السر (32 بايتًا base64url، 43 حرفًا) يُنشأ في أول طلب ويُخزَّن مشفرًا (`customer_passes`)، ويُدوَّر في أول طلب بعد `refresh_after` (30 يومًا) ويبقى السابق صالحًا 7 أيام لجهاز بلا اتصال. يحفظه التطبيق في التخزين الآمن ولا يعرضه.
- **صيغة الرمز** (`generatePassToken` / `verifyPassToken` في `@point/shared/customer`، الكود نفسه في التطبيق والخادم):

  ```
  P1.<account>.<vehicle>.<step>.<mac>
  account  = base64url(16 بايت uuid الحساب)                      22 حرفًا
  vehicle  = base64url(16 بايت uuid السيارة المختارة) أو «-»       22 حرفًا
  step     = floor(unix_seconds / 30) عشريًا، بساعة الجهاز + (server_time − ساعة الجهاز وقت الجلب)
  mac      = base64url(أول 10 بايتات من HMAC-SHA256(secret, "point-pass:v1:<account uuid>:<vehicle uuid أو ->:<step>"))
  ```

  الخادم يقبل التوقيع بالسر الحالي أو السابق في مهلته، ثم الخطوة الحالية ± 1 (`PASS_EXPIRED` بـ`stale`/`future` خارجها)، ثم خطوة أكبر من آخر خطوة استُعملت في استلام (`already_used`)؛ وغير ذلك `PASS_INVALID` (`malformed` / `bad_signature` / `account_unavailable` لحساب معلّق أو محذوف أو بلا بطاقة).
- **زيارات الحساب** (V2-014، DEC-504): `listAccountVisits` على الخادم هي مصدر `current_visit` في `GET /v1/customer/home` وقراءات الزيارة الجارية للسيارة والحساب؛ مساراها `GET /v1/customer/visits[/{ticketId}]` مع `C-12`/`C-16` (V2-015، V2-017).

### 1.5 الزيارة الحية والإشعارات (V2-015، V2-016، DEC-516 … DEC-520)

ستة مسارات في `CUSTOMER_ROUTES` (مجموعة واحدة بعد بطاقة الدخول) وفي قسم `Customer` من `07_openapi.yaml`، يخدمها `CustomerVisitsController` في `packages/server/src/use-cases/http/`:

- **`GET /v1/customer/visits?cursor&limit`** (`C-16`): `listAccountVisits` (DEC-504) الأحدث أولًا بمؤشر صفحات معتم (`meta.next_cursor`، حتى 50): `{ ticket_id, venue_*, operator_*, status, open, channel, plate_display, received_at, delivered_at, duration_min, payment: { entitlement, payment_status, fee_halalas }, rated }`.
- **`GET /v1/customer/visits/{ticketId}`** (`C-12`، `Cache-Control: no-store`): الملخص ومعه `timeline` (`received`، `parked`، `requested`، `accepted`، `on_the_way`، `ready`، `delivered` من التذكرة ودورتها الحالية)، و`request: { can_request, pending_early, requested_at }`، و`handover: { method: app_code|whatsapp|staff, code_available, code_expires_at }`، و`photos` صور فحص الاستلام روابط موقّعة ≤ 300 ث (تُقرأ من جديد في كل عرض)، و`rating`/`can_rate`، والشركة واللون. **لا خانة مفتاح ولا موقف ولا رمز ولا موظفين** (V2-D12). زيارة حساب آخر أو تذكرة ملغاة أو معرّف مجهول ← `RESOURCE_NOT_FOUND` (`resource: customer_visit`) بالرد نفسه.
- **`POST /v1/customer/visits/{ticketId}/request`** (`Idempotency-Key`، جسم فارغ، 201): أمر زر «طلب السيارة» نفسه (`applyCustomerRequest`، 10 §7.2/§7.3) بمصدر `app` (`retrieval_cycles.request_source` و`tickets.pending_retrieval_source`، ترحيل `0013`) وفاعل العميل: L1 ثم L5؛ `parked` بلا دورة ← `requested`؛ أثناء الصف ← `requested_early` (DEC-13، يُحوَّل عند الصف بوقته)؛ دورة مفتوحة أو طلب مبكر قائم ← `RETRIEVAL_ALREADY_ACTIVE`؛ مُسلَّمة ← `TICKET_CLOSED`. الرد `{ outcome, visit }`؛ التدقيق `retrieval.request` في `audit_log` المشغل و`customer.visit.requested` في `customer_audit_log`.
- **`GET /v1/customer/visits/{ticketId}/handover-code`** (`no-store`): `{ ticket_id, code, expires_at, attempts_left }` لتذكرة تطبيق `ready` برمز حي فقط، من `claim_codes.code_ciphertext` (DEC-38، DEC-517)؛ غير جاهزة ← `HANDOVER_NOT_READY`؛ وإلا `HANDOVER_CODE_UNAVAILABLE` بـ`reason` (`whatsapp`، `staff`، `locked`، `expired`، `none`). يُدوَّن `customer.visit.handover_code_shown` بلا الرمز.
- **`POST /v1/customer/visits/{ticketId}/rating`** (`C-13`، `Idempotency-Key`، 201) بـ`{ stars: 1..5, note? ≤ 500 }`: مرة لكل زيارة بعد التسليم (`customer_visit_ratings`)؛ قبله `CUSTOMER_VISIT_NOT_DELIVERED`، والثاني `CUSTOMER_VISIT_ALREADY_RATED`.
- **`POST /v1/customer/devices`** (`Idempotency-Key`) بـ`{ provider: 'expo', push_token | null }`: رمز Expo لجلسة الجهاز (`customer_account_sessions.push_token`)؛ `null` يزيله؛ الرمز لجلسة حية واحدة (ينتقل من جلسة أخرى)؛ يُسقطه الخروج وحذف الحساب وكل إلغاء للجلسة (قيد `ck_customer_sessions_revoked_push`). الرد `{ push_registered, provider, registered_at }` بلا الرمز.

**رمز التسليم لتذكرة التطبيق (DEC-517):** يصدر عند «جاهزة» بمنطق رمز التسليم نفسه (HMAC + نسخة مشفرة واحدة + مؤقت الانتهاء) ويظهر في `C-12` بدل W-05؛ نسخته المشفرة تُمحى عند الاستعمال أو الإلغاء أو الانتهاء؛ «إعادة الإرسال» في D-11 تدوّره لتذكرة التطبيق بلا رسالة؛ ويبقى استثناء المشرف بالتحقق من الهوية البديل.

**الاتصال الفوري للعميل (DEC-520):** Socket.IO على `WS_PATH` نفسه، **namespace `/customer`**، والمصافحة بترويسة `Authorization: Bearer <access token>` وحدها (لا كوكي؛ جلسة موظف لا تفتحه ورمز عميل لا يفتح namespace الموظفين). يُضم المقبس إلى غرفة حسابه `customer:<accountId>` وحدها. `visit.updated` `{ ticket_id, status, open }` بغلاف `{ id, type, occurred_at, payload }` بلا معرّف مشغل أو موقع أو موظف، يُنشر مع كل `ticket.updated` لتذكرة صف `customers` مربوط بالحساب؛ و`subscription.updated` محجوز (V4)؛ و`session.revoked` عند إلغاء الجلسة. يُعاد فحص **الجلسة** (لا رمز الوصول ذي 15 دقيقة) كل دقيقة، والتطبيق يعيد قراءة الزيارة عند كل اتصال وإعادة اتصال (التسليم مرة واحدة على الأكثر، 11 §9.4).

**الإشعارات (DEC-519، DEC-520):** `job.customer_push_send` بعد COMMIT من `customer_push_messages` (صف لكل إشعار وجلسة، بالمعرّفات فقط) يكتبه مخطط في معاملة الحدث: استلام السيارة (`ticket.intake_submitted` لتذكرة تطبيق)، قبول الطلب (أول `ticket.assigned`/`assigned_waiting` للدورة)، الجاهزية (`ticket.ready`)، التذكير (`alert.raised` من نوع `ready_not_collected`)؛ لتذاكر `app` فقط (تذكرة واتساب للحساب تبقى على W-xx). المرسل `CustomerPushSender`: محوّل Expo Push API (`CUSTOMER_PUSH_MODE=live` في الإنتاج وحده، رمز الوصول بالمرجع `CUSTOMER_PUSH_ACCESS_TOKEN_REF`، اختياري) أو المحاكي (كل بيئة أخرى، لا اتصال بالشبكة)؛ `job.customer_push_receipts` يقرأ الإيصالات بعد `CUSTOMER_PUSH_RECEIPT_DELAY_S`، و`DeviceNotRegistered` يُسقط الرمز. **الحمولة على شاشة القفل:** العنوان اسم علامة العميل، والنص جملة ثابتة لكل نوع (واسم الموقع في «استلمنا سيارتك» وحده كما في 01 §3)، و`data = { type: 'visit', kind, visit_id }` — بلا لوحة ولا موقف ولا مفتاح ولا رمز ولا اسم ولا جوال (DEC-23).

### 1.6 الدفع للزيارة والبطاقات المحفوظة (V2-022، V2-023، DEC-521 … DEC-525)

- **`POST /v1/customer/visits/{ticketId}/pay`** (`C-12` ← `C-10`، Bearer، `Idempotency-Key`) بالجسم `{ source: { type: 'token', token } | { type: 'applepay', token } | { type: 'saved', payment_method_id }, save_card?, card_on_file_version? }`. البطاقة تُرمَّز على الجهاز بالمفتاح العام (`POST /v1/tokens` لدى Moyasar) أو يسلّم الجهاز رمز Apple Pay، ولا تصل بيانات البطاقة الخادم أبدًا (SAQ-A، DEC-510)؛ والخادم يرسل الرمز وحده. **المبلغ يحدده الخادم:** رسوم التذكرة (`tickets.fee_halalas`، لقطة الحفل `per_vehicle`، شاملة الضريبة 15%) — ما يحصّله السائق نقدًا تمامًا؛ و`pay_per_visit_halalas` للموقع سعر عرض في `C-07`/`C-08` لا يُحصَّل وحده (DEC-521). الرفض: تذكرة حساب آخر أو غير موجودة `RESOURCE_NOT_FOUND` (`resource: visit`)؛ `VISIT_NOT_PAYABLE` (409) بـ`reason` (`delivered`، `voided`، `entitlement` لأهلية غير `none`، `not_due` لرسوم `not_required`/`waived`، `below_minimum` لأقل من 1.00 ريال)؛ مدفوعة في التطبيق أو نقدًا/شبكة `PAYMENT_ALREADY_RECORDED` (بـ`payment_id`/`method`/`collected_by` للنقد، وبـ`online_payment_id` و`method: app` للتطبيق)؛ دفعة سابقة للزيارة تنتظر 3-D Secure منذ أقل من `VISIT_PAYMENT_PENDING_S` (15 دقيقة) `PAYMENT_IN_PROGRESS` (409، `online_payment_id`، `retry_after_s`)؛ رفض البوابة `PAYMENT_FAILED` (402) بعد حفظ `failed`. `save_card` (لبطاقة `token` فقط) يلزمه `card_on_file_version` الساري (`CUSTOMER_CARD_ON_FILE_VERSION`) وإلا `CUSTOMER_CONSENT_REQUIRED` (422) أو `CUSTOMER_CONSENT_VERSION_STALE`. الرد `201` `CustomerVisitPayment`: `{ payment_id, ticket_id, status, amount_halalas, vat_halalas, currency, card_brand, card_last4, failure_code, transaction_url, callback_url, paid_at, saved_payment_method_id, receipt }`؛ `initiated` مع `transaction_url` يفتحه التطبيق في متصفح داخلي حتى يصل `callback_url` (رابط التطبيق `CUSTOMER_PAY_CALLBACK_URL`)، و**العودة لا تغيّر شيئًا**: الحالة النهائية من Webhook البوابة بعد قراءتها (DEC-512). المفتاح نفسه لا ينشئ إلا دفعة واحدة (`given_id` مشتق من الحساب والمفتاح).
- **`GET /v1/customer/payments/{paymentId}`** (قراءة): دفعة الحساب نفسه (وإلا `RESOURCE_NOT_FOUND`)، يستطلعها التطبيق بعد 3-D Secure؛ `receipt` بيانات الفاتورة المبسطة (`C-17`) من الدفعة نفسها بلا تخزين جديد حتى مزود الفوترة (V2-040).
- **`GET /v1/customer/payment-methods`** · **`POST …`** (`{ token, card_on_file_version, make_default? }`، رمز `save_only` من الجهاز؛ العلامة وآخر 4 أرقام والانتهاء من البوابة `GET /v1/tokens/{id}`، والأولى افتراضية) · **`PATCH …/{paymentMethodId}`** (`{ is_default: true }`) · **`DELETE …/{paymentMethodId}`** (إزالة ناعمة، وحذف الرمز لدى البوابة بعد COMMIT بـ`job.payment_method_token_delete`). بطاقة حساب آخر أو محذوفة `RESOURCE_NOT_FOUND` (`resource: payment_method`). حذف الحساب (§1.3) يزيل البطاقات ويحذف رموزها لدى البوابة كذلك.
- **بوابة التسليم (O-03):** دفعة `paid` تجعل التذكرة `collected` بأهلية `app_paid` في معاملة انتقالها (DEC-522)، فلا يطلب D-11 نقدًا وتظهر «مدفوع في التطبيق»؛ ودفعة `initiated` غير مدفوعة: يحصّل السائق نقدًا، وإن نجحت بعد ذلك تُسترد كاملة تلقائيًا (`double_payment`، DEC-523).
- **في `C-12`:** ملخص `payment` لـ`GET /v1/customer/visits[/{ticketId}]` يحمل أيضًا `payable_in_app` و`online_payment` (`{ payment_id, status, paid_at }` لأحدث دفعة في التطبيق)، والدفعة حين تُدفع (أو تُسترد كاملة قبل التسليم) تنشر `visit.updated` للحساب (§1.5)، ويستطلع التطبيق `GET /v1/customer/payments/{paymentId}` بعد 3-D Secure. منطقة «ادفع» في `VisitPaymentSlot` (DEC-525).

## 2. مسارات المشغل الجديدة (تحت `/v1` كما هي)

| المسار | الوظيفة |
|---|---|
| `POST /v1/tickets/intake-pass` | استلام بمسح بطاقة الدخول (O-01، **مبني V2-013**، DEC-501): `{ pass_token, ticket_id, expected_version }` يجعل مسودة D-05 للسائق تذكرة `channel = app` (200)، أو بلا `ticket_id` (و`event_id` كـ`POST /v1/tickets`) ينشئها (201)؛ يرد `{ ticket, customer: { first_name, phone_masked, vehicle_prefilled }, task?, driver_state? }`؛ `ticket.intake`، `Idempotency-Key`، نطاق الاستلام و`OPERATOR_SUSPENDED`؛ والأهلية كما حُددت عند الإنشاء (DEC-502) |
| `GET /v1/venues/{venueId}/public-profile` · `PUT …` · `POST …/photos` · `POST …/submit` | ملف الموقع العام (O-04، V2-004 مبني): القراءة، الحفظ مسودة باستبدال كامل (`expected_version` 0 للإنشاء)، رابط رفع صورة موقّع، الإرسال للمراجعة؛ `venue.manage` (DEC-490 … DEC-494) |
| `GET /v1/settlement-statements` · `GET /v1/settlement-statements/{statementId}` · ✓ `POST …/{statementId}/dispute` | كشوف التسوية للمشغل (O-05، **مبني V2-041**، DEC-547): الصادرة وما بعدها فقط ببنودها الفعالة وفواتيرها، والاعتراض بسبب؛ `settlement.read` / `settlement.dispute` (المالك والإدارة) |
| `GET /v1/system-subscription` · `GET /v1/system-subscription/invoices/{invoiceId}` | اشتراك النظام وفواتيره (O-06، **مبني V2-042**، DEC-547): العقد الساري وسجله، المواقع النشطة، فواتير بوينت برابط PDF قصير؛ `settlement.read` |

## 3. مسارات المنصة `/v1/platform/*` (أدوار المنصة، MFA)

**مبني في V5 (V2-040 … V2-042، DEC-544 … DEC-548):** `GET /v1/platform/settlements[/{statementId}]`، ✓ `POST /v1/platform/settlements/generate` و`POST …/{statementId}/adjustments|issue|record-payment|resolve-dispute|void` (`platform.settlement_manage`)، و`GET /v1/platform/invoices[/{invoiceId}]` (`platform.invoice_read`) — التفاصيل في `02_Platform_and_Operators.md` §5.4 و07 §8.

المشغلون والعقود، المواقع واعتمادها (V2-004 مبني: `GET /v1/platform/venues[/{venueId}]`، `POST …/{venueId}/approve|send-back|hide|unhide`، `PUT …/{venueId}/pricing` بـ`platform.plan_manage`)، الباقات والأسعار، العملاء والاشتراكات (قراءة ودعم)، المدفوعات والاستردادات، كشوف التسوية (إنشاء، إصدار، تسجيل الدفع)، الفواتير، الإعدادات، وسجل المنصة — بمقابل كل شاشة `P-##`.

## 4. Webhooks واردة

| المسار | المصدر | المعالجة |
|---|---|---|
| `POST /webhooks/payments/{gateway}` | بوابة الدفع | توقيع، تخزين خام، معالجة مرة واحدة عبر Outbox (V2 §4.3) — **مبني لـMoyasar: `POST /webhooks/payments/moyasar`** (أدناه) |
| `POST /webhooks/einvoicing` | مزود الفوترة | حالة الإبلاغ/الاعتماد للفاتورة — **مبني (V2-040، DEC-543)**، §4.3 |
| `/webhooks/whatsapp` | Meta | كما هو |

### 4.1 Webhook بوابة الدفع (المنفَّذ في V2-021، DEC-511، DEC-512)

- **المسار:** `POST /webhooks/payments/moyasar` (canon §9.8، فئة حد المعدل `webhook`، بلا جلسة ولا CSRF). الجسم كما يرسله Moyasar: `{ id, type, created_at, secret_token, account_name, live, data }`، و`data` كائن الدفعة؛ الأنواع `payment_paid`، `payment_failed`، `payment_refunded`، `payment_voided`، `payment_authorized`، `payment_captured`، `payment_abandoned`، `payment_verified`.
- **التحقق:** لا توقيع ترويسة لدى Moyasar؛ السر المشترك الذي يُضبط عند إنشاء الـWebhook يصل في `secret_token` داخل الجسم، فيُقرأ الجسم خامًا ويُقارن السر بزمن ثابت مع `MOYASAR_WEBHOOK_SECRET_REF` (والسابق أثناء التدوير) قبل أي معالجة. غيابه أو اختلافه أو جسم غير JSON ← `401 PAYMENT_WEBHOOK_SIGNATURE_INVALID` ولا يُحفظ شيء؛ سر صحيح بلا `id`/`type` ← `422 VALIDATION_FAILED`؛ سر غير مضبوط ← `503` (تعيد البوابة المحاولة).
- **التخزين:** `gateway_webhook_events` مرة لكل `(gateway, event_id)` بلا `secret_token`، وبطاقة مختزلة إلى العلامة وآخر 4 أرقام (لا رقم مقنّع ولا اسم حامل ولا رمز بطاقة محفوظة)، و`body_sha256` للبايتات الأصلية؛ مع `job.payment_webhook_process` في المعاملة نفسها، ثم `200` بلا جسم (والمكرر كذلك).
- **المعالجة (العامل):** لا يُوثق بـ`data` الحدث: يقرأ العامل الدفعة من البوابة (`GET /v1/payments/{id}`) خارج أي معاملة، ثم يطبق سجلها على `online_payments` بالانتقالات الأمامية فقط (`initiated → authorized → paid | failed`، ثم `partially_refunded` / `refunded`)، فالمكرر والمتأخر والمعكوس الترتيب لا يرجع الحالة. كل انتقال في `platform_audit_log` (وفي `audit_log` للمشغل لزيارة) و`customer_audit_log` في المعاملة نفسها. دفعة لا تعرفها بوينت ← `outcome = unknown_payment` وتنبيه `payment_unknown`؛ تعارض (مبلغ آخر، أو `failed` تسميها البوابة `paid`) ← لا يُطبق وتنبيه `payment_mismatch`. عودة العميل من صفحة 3-D Secure لا تغيّر شيئًا وحدها.

### 4.2 الاسترداد والمطابقة (V2-021، DEC-513، DEC-514)

- `POST /v1/platform/payments/{paymentId}/refunds` (`platform.refund_issue`: المالية والمالك، ✓ `Idempotency-Key`) بـ`{ amount_halalas?, reason }`: جزئي أو كامل (غياب المبلغ = كل المتبقي)، لا يتجاوز المدفوع ناقص المسترد وما ينتظر (`REFUND_AMOUNT_EXCEEDS_PAID`)، ومن `paid`/`partially_refunded` فقط (`PAYMENT_NOT_REFUNDABLE`). يرد `201 { refund (requested), payment }`، والبوابة يستدعيها `job.payment_refund_send` بعد COMMIT (استرداد بعد آخر للدفعة)، فتصير `succeeded` أو `failed` مع تنبيه `payment_refund_failed`.
- `job.payments_reconcile` يوميًا (`PAYMENTS_RECONCILE_CRON_UTC`): مدفوعات البوابة ليوم الرياض السابق مقابل `online_payments`، وكل فرق بند في `payment_reconciliation_runs.mismatches` وتنبيه في `platform_alerts`.

### 4.3 مزود الفوترة الإلكترونية وإشعار حالته (V2-040، DEC-540 … DEC-543)

- **المنفذ** `EInvoicingProvider`: `report` (فاتورة مبسطة أو إشعارها الدائن، الإبلاغ خلال 24 ساعة)، `clear` (فاتورة ضريبية B2B أو إشعارها، الاعتماد)، `verifyCallback`. `EINVOICE_MODE=simulator` (بلا شبكة، كل بيئة غير الإنتاج) أو `live` (الإنتاج وحده؛ لا محوّل بعد حتى يختار المالك المزود، فيُرفض الإرسال بلا اتصال وتبقى الفاتورة `pending` مع تنبيه).
- **الإرسال** `job.einvoice_submit` بعد COMMIT، بترتيب السلسلة؛ القبول يكتب الحالة (`reported`/`cleared`) ومرجع المزود وبصمته وQR المختوم ثم `job.invoice_pdf_render`؛ الرفض نهائي بتنبيه `einvoice_rejected`، والتعذر يُعاد ثم `einvoice_submit_failed`.
- **الإشعار** `POST /webhooks/einvoicing` (canon §9.8، فئة `webhook`): `X-Einvoice-Signature: sha256=<HMAC-SHA256 للجسم الخام بسر EINVOICE_WEBHOOK_SECRET_REF>` بمقارنة زمن ثابت قبل أي قراءة، وإلا `401 EINVOICE_WEBHOOK_SIGNATURE_INVALID`. الجسم `{ invoice_uuid, status: reported|cleared|rejected, reference?, codes? }`؛ يُطبق على مستند `pending` فقط، والباقي يُدوَّن `ignored`؛ 200 بلا جسم. صيغة توقيع المزود الحقيقي يتبناها محوّله.

### 4.4 فواتير العميل C-17 (V2-040، DEC-548)

`GET /v1/customer/invoices` (أحدث 100 مستند للحساب: فواتير مبسطة وإشعارات دائنة) و`GET /v1/customer/invoices/{invoiceId}` (البائع ورقماه، البنود والضريبة منفصلة، QR بصيغة TLV base64، و`pdf_url` موقّع لدقائق أو `null` أثناء التوليد)؛ مستند حساب آخر ← `RESOURCE_NOT_FOUND`.

## 5. رموز خطأ جديدة (مقترحة، بنمط 08)

رموز العميل المعتمدة في V2-011 بنصوصها ورمز HTTP في `CUSTOMER_ERROR_CATALOG` (`packages/shared/src/customer/errors.ts`، DEC-482)، ومعها رموز 08 التي يعيدها مسار العميل كما هي (`CUSTOMER_REUSED_ERROR_CODES`).

`CUSTOMER_OTP_INVALID`، `CUSTOMER_OTP_EXPIRED`، `CUSTOMER_OTP_LOCKED`، `CUSTOMER_CONSENT_VERSION_STALE`، `CUSTOMER_VEHICLE_LIMIT`، `CUSTOMER_VEHICLE_DUPLICATE`، `PASS_INVALID`، `PASS_EXPIRED`، `SUBSCRIPTION_NOT_ACTIVE`، `SUBSCRIPTION_VEHICLE_NOT_COVERED`، `SUBSCRIPTION_ALREADY_EXISTS`، `PAYMENT_REQUIRED`، `PAYMENT_FAILED`، `PAYMENT_ALREADY_RECORDED`، `VENUE_NOT_LISTED`، `OPERATOR_SUSPENDED`، `ACCOUNT_DELETED`، `CUSTOMER_VEHICLE_IN_ACTIVE_VISIT`، `CUSTOMER_ACCOUNT_VISIT_ACTIVE`، `CUSTOMER_REAUTH_REQUIRED` (V2-012/V2-017، §1.3)، `HANDOVER_CODE_UNAVAILABLE`، `CUSTOMER_VISIT_NOT_DELIVERED`، `CUSTOMER_VISIT_ALREADY_RATED` (V2-015، §1.5)؛ ويعيد مسار العميل من 08 أيضًا `TICKET_CLOSED` و`RETRIEVAL_ALREADY_ACTIVE` و`HANDOVER_NOT_READY` (§1.5). `VISIT_NOT_PAYABLE`، `PAYMENT_IN_PROGRESS`، `CUSTOMER_CONSENT_REQUIRED` (V2-022/V2-023، §1.6)؛ ويعيد مسار العميل أيضًا `PAYMENT_FAILED` و`PAYMENT_ALREADY_RECORDED` و`DEPENDENCY_TIMEOUT` من 08 كما هي.

## 6. واتساب في الإصدار الثاني (V2-D02)

القناة الواحدة كما هي برقم بوينت. القوالب W-01…W-08 تُعاد صياغتها بعلامة «بوينت» واسم الموقع، ويُضاف:
- رابط اختياري لتحميل التطبيق في رسالة الترحيب.
- قالب مصادقة لرمز التحقق: القناة الوحيدة لرمز الدخول، بلا SMS (DEC-460).
- العميل الذي له حساب ويستخدم الواتساب: الرسائل تُربط بحسابه، وتظهر الزيارة في تطبيقه (`listAccountVisits` تقرأ صف المشغل المربوط بالحساب، DEC-504).
- **تذكرة التطبيق (`channel = app`، DEC-503):** لا W-01 ولا أي قالب لاحق عليها؛ يتابعها العميل في `C-12` (V2-015) وإشعارات التطبيق (V2-016). ورمز التسليم لها يصدر عند الجاهزية ويظهر في `C-12` (§1.5، DEC-517)، واستثناء المشرف يبقى البديل.

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
