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

الاتصال الفوري للعميل: Socket.IO على `/ws` بجلسة العميل، غرفة لكل حساب، والأحداث: `visit.updated`، `subscription.updated`. والإشعارات عبر APNs وFCM.

## 2. مسارات المشغل الجديدة (تحت `/v1` كما هي)

| المسار | الوظيفة |
|---|---|
| `POST /v1/tickets/intake-pass` | استلام بمسح بطاقة الدخول (O-01): يتحقق من الرمز المتغير، ينشئ التذكرة `channel='app'` ويحدد الأهلية |
| `GET /v1/venues/{id}/public-profile` · `PUT …` · `POST …/submit` | ملف الموقع العام (O-04) |
| `GET /v1/settlement/statements[/{id}]` | كشوف التسوية للمشغل (قراءة، O-05) |
| `GET /v1/operator/subscription` | اشتراك النظام وفواتيره (O-06) |

## 3. مسارات المنصة `/v1/platform/*` (أدوار المنصة، MFA)

المشغلون والعقود، المواقع واعتمادها، الباقات والأسعار، العملاء والاشتراكات (قراءة ودعم)، المدفوعات والاستردادات، كشوف التسوية (إنشاء، إصدار، تسجيل الدفع)، الفواتير، الإعدادات، وسجل المنصة — بمقابل كل شاشة `P-##`.

## 4. Webhooks واردة

| المسار | المصدر | المعالجة |
|---|---|---|
| `POST /webhooks/payments/{gateway}` | بوابة الدفع | توقيع، تخزين خام، معالجة مرة واحدة عبر Outbox (V2 §4.3) |
| `POST /webhooks/einvoicing` | مزود الفوترة | حالة الإبلاغ/الاعتماد للفاتورة |
| `/webhooks/whatsapp` | Meta | كما هو |

## 5. رموز خطأ جديدة (مقترحة، بنمط 08)

`CUSTOMER_OTP_INVALID`، `CUSTOMER_OTP_LOCKED`، `PASS_INVALID`، `PASS_EXPIRED`، `SUBSCRIPTION_NOT_ACTIVE`، `SUBSCRIPTION_VEHICLE_NOT_COVERED`، `SUBSCRIPTION_ALREADY_EXISTS`، `PAYMENT_REQUIRED`، `PAYMENT_FAILED`، `PAYMENT_ALREADY_RECORDED`، `VENUE_NOT_LISTED`، `OPERATOR_SUSPENDED`، `ACCOUNT_DELETED`.

## 6. واتساب في الإصدار الثاني (V2-D02)

القناة الواحدة كما هي برقم بوينت. القوالب W-01…W-08 تُعاد صياغتها بعلامة «بوينت» واسم الموقع، ويُضاف:
- رابط اختياري لتحميل التطبيق في رسالة الترحيب.
- قالب مصادقة لرمز التحقق (بديل SMS).
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
