# 05 — التقنيات والبيئات (Tech Stack & Environment)

الإصدار 1.0 — 27 أكتوبر 2026 — الحالة: مرجع ملزم للتنفيذ.

مبني على `00_Source_Architecture_v1.2_AR.md` (§13 التقنية والنشر، §14 الحماية والأعطال، §7 الصوت والإشعارات)، والقرارات DEC-04 حتى DEC-09 وDEC-18 وDEC-19 وDEC-24 والسؤالين Q-01 وQ-02 في `DECISIONS.md`. الأسماء وفق `00_Glossary_Canon.md`. المعمارية والتدفقات في `04_Architecture_Flow.md`.

---

## 1. ملخص القرارات التقنية

| الطبقة | الاختيار | السبب | المرجع |
|---|---|---|---|
| لغة موحدة | TypeScript (وضع `strict`) في الخادم والعميل والحزم المشتركة | مخططات وأنواع مشتركة بين الطرفين، فريق واحد | DEC-05 |
| الواجهة | React + TypeScript + Vite، موقع متجاوب واحد للسائق والمشرف والإدارة، PWA اختياري | المعمارية §1 و§13؛ لا تطبيق أصلي ولا متاجر | DEC-05 |
| الخادم | NestJS بعمليتين: `api` (HTTP + Socket.IO + Webhook) و`worker` (Outbox ومؤقتات ومرسلات) | مونوليث معياري؛ نفس الكود وعمليتان | DEC-05 |
| قاعدة البيانات | PostgreSQL 16+ | مصدر الحقيقة، القيود، Outbox، `SKIP LOCKED`، `LISTEN/NOTIFY` | DEC-05، DEC-07 |
| الوصول للبيانات | Drizzle ORM فوق `pg` مع ترحيلات SQL تطابق `06_schema.sql` | دعم الأقفال الصريحة والفهارس الجزئية وSQL خام عند الحاجة | DEC-06 |
| الطابور والمؤقتات | جدول `outbox_events` داخل PostgreSQL | لا طابور خارجي في الإصدار الأول | DEC-07 |
| الاتصال الفوري | Socket.IO + `pg_notify` للتوزيع بين النسخ | Redis اختياري لاحقًا فقط | DEC-05، `04` §7 |
| الصور والتصدير | تخزين كائنات خاص متوافق مع S3 (MinIO محليًا) | روابط موقعة مؤقتة؛ لا وصول عام | المعمارية §14 |
| واتساب | WhatsApp Cloud API الرسمي (أو مزود معتمد) برقم «مصاف» الواحد، ومحاكٍ محلي | المعمارية §1 و§5 | DEC-10، الملف 12 |
| الإشعارات | Web Push القياسي بمفاتيح VAPID (مساعد فقط) | لا FCM/APNs SDK أصلي | المعمارية §7 |
| الدخول | جلسات على الخادم بكوكي `httpOnly`، رقم سري للسائق، كلمة مرور + TOTP للإدارة والمشرف | قابلية الإبطال الفوري عند النقل والتعطيل | DEC-09 |
| التحليلات | من قاعدة البيانات نفسها (`analytics_events`) | لا أدوات تحليل خارجية | DEC-24 |
| الخط | IBM Plex Sans Arabic (عربي + لاتيني) وIBM Plex Mono للرموز والعدادات | الهوية | DEC-18 |

---

## 2. سياسة الإصدارات

- **حدود دنيا مؤكدة:** Node.js 24 LTS (لـ`api` و`worker` وأدوات البناء)، PostgreSQL 16 أو أحدث (الملف `06_schema.sql` مُتحقق منه على 16).
- **كل ما عدا ذلك:** أحدث إصدار مستقر وقت التنفيذ، بعد مراجعة وثائقه الرسمية وملاحظات الترقية. لا تُنقل أرقام إصدارات من الذاكرة إلى الكود.
- كل الإصدارات مثبتة في `pnpm-lock.yaml`، ويُفعَّل Renovate أو Dependabot أسبوعيًا مع تشغيل كامل الاختبارات قبل الدمج.
- إصدار Graph API لواتساب يُثبَّت في `WA_API_VERSION` و`whatsapp_channel.api_version`، ويُراجع قبل انتهاء دعمه وفق جدول Meta (الملف 12).
- ممنوع استخدام واجهات معلنة كمهملة (deprecated) في الإصدار المختار.

---

## 3. هيكل المستودع (pnpm workspaces)

```text
point/
├─ apps/
│  ├─ api/                 # مدخل NestJS: /v1 و /ws و /webhooks/whatsapp و /health و /metrics
│  ├─ worker/              # مدخل NestJS مستقل: OutboxDispatcher ومعالجات job.* والمُسقطات
│  └─ web/                 # React + Vite PWA: واجهات السائق والمشرف والإدارة (بوينت)
├─ packages/
│  ├─ server/              # الوحدات النطاقية التسع + core + use-cases (يستوردها api و worker)
│  ├─ shared/              # zod schemas للسلك، القيم المحدودة (Canon §5)، رموز الأخطاء (§8)،
│  │                       # أنواع الأحداث (§7)، الصلاحيات (§10)، مخطط الإعدادات (§12)، القوالب (§11)
│  ├─ db/                  # Drizzle schema يطابق 06_schema.sql، ترحيلات SQL، seed، فحص الانحراف
│  └─ config/              # إعدادات tsconfig و eslint و prettier المشتركة
├─ tools/
│  └─ wa-simulator/        # محاكي Graph API + مُرسِل Webhook موقّع للتطوير والاختبار
├─ infra/
│  ├─ docker/              # Dockerfile للخلفية (صورة واحدة بأمرين: api أو worker)
│  ├─ compose/             # docker-compose.yml للتطوير المحلي
│  ├─ k6/                  # سيناريوهات اختبار الحمل
│  └─ github/              # قوالب سير عمل GitHub Actions (تُنسخ إلى .github/workflows)
├─ docs/                   # حزمة التوثيق هذه (المرجع)
├─ brand/                  # ملفات الهوية: الشعارات، tokens، أيقونات التطبيق، الأصوات، manifest
├─ .env.example
├─ pnpm-workspace.yaml
└─ package.json            # سكربتات الجذر (dev, test, lint, typecheck, db:*)
```

أسماء الحزم: `@point/api`, `@point/worker`, `@point/web`, `@point/server`, `@point/shared`, `@point/db`, `@point/config`, `@point/wa-simulator`.

ملاحظة: الوحدات النطاقية في `packages/server` (وليس داخل `apps/api`) لأن `api` و`worker` يحتاجان الكود نفسه. `apps/api` يسجّل Controllers وGateway فقط، و`apps/worker` يسجّل معالجات المهام فقط.

### 3.1 بنية الوحدة الواحدة داخل `packages/server`

```text
packages/server/src/
├─ core/
│  ├─ db/                  # pool، withTransaction، مساعدات الأقفال L0..L10 (Canon §14ب)
│  ├─ idempotency/
│  ├─ outbox/              # OutboxWriter، أنواع الصفوف
│  ├─ audit/               # AuditWriter، TicketEventWriter
│  ├─ errors/              # AppError، فلتر الاستثناءات، pg-constraint-map.ts
│  ├─ actor-context/       # تحميل سياق الفاعل، PermissionGuard
│  ├─ settings/            # دمج إعدادات الموقع والمؤسسة مع القيم الافتراضية (Canon §12)
│  ├─ secrets/             # SecretResolver: env:// و sm://
│  ├─ realtime/            # RealtimePublisher (pg_notify)
│  └─ clock/               # Clock قابلة للحقن
├─ modules/
│  ├─ identity-access/
│  │  ├─ domain/           # قواعد نقية بلا IO (سياسات، تحقق الحالة)
│  │  ├─ application/      # خدمات الأوامر والاستعلامات داخل الوحدة
│  │  ├─ infra/            # مستودعات Drizzle واستعلامات SQL
│  │  ├─ http/             # Controllers و DTOs (يسجلها api فقط)
│  │  ├─ jobs/             # معالجات job.* (يسجلها worker فقط)
│  │  └─ index.ts          # الواجهة العامة الوحيدة المسموح استيرادها من خارج الوحدة
│  ├─ venues-events/  ├─ tickets-custody/  ├─ dispatch/  ├─ whatsapp/
│  ├─ notifications/  ├─ incidents/  ├─ payments-reports/  └─ audit-monitoring/
└─ use-cases/              # StartIntake، RequestRetrieval، AcceptOffer، Handover ... (تملك المعاملة)
```

---

## 4. الخلفية — المكتبات

كل مكتبة: أحدث مستقر وقت التنفيذ مع مراجعة الوثائق الرسمية.

| المكتبة | الغرض | ملاحظات التنفيذ |
|---|---|---|
| `@nestjs/core`, `@nestjs/common`, `@nestjs/platform-express` | إطار الخادم والوحدات وحقن التبعيات | محوّل Express؛ تفعيل `rawBody` لمسار Webhook |
| `@nestjs/websockets`, `@nestjs/platform-socket.io`, `socket.io` | الاتصال الفوري `/ws` | مصادقة المصافحة بكوكي الجلسة؛ الغرف من الخادم فقط |
| `drizzle-orm`, `drizzle-kit`, `pg` | الوصول للبيانات والترحيلات | `SELECT ... FOR UPDATE` و`SKIP LOCKED` وSQL خام مسموح؛ عميل `pg` مخصص لـ`LISTEN` |
| `zod` | التحقق من المدخلات والمخرجات وإعدادات الموقع | المخططات في `@point/shared` ومشتركة مع الواجهة |
| `argon2` | تجزئة الرقم السري وكلمة المرور (argon2id) | معاملات وفق توصيات OWASP الحالية لتخزين كلمات المرور |
| `otplib` (+ `qrcode` لرمز الإعداد) | TOTP للمالك والإدارة والمشرف | سر TOTP مشفر في `users.mfa_secret_enc` |
| `web-push` | إرسال Web Push بمفاتيح VAPID | حذف الاشتراك عند 404/410 |
| `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` | رفع وقراءة الصور والتصدير بروابط موقعة | دلاء خاصة؛ صلاحية الرابط 5 دقائق |
| `libphonenumber-js` | تطبيع الجوال إلى E.164 والتحقق منه | الافتراضي `SA` |
| `uuid` (v7) | معرفات مرتبة زمنيًا تولدها الخلفية | القاعدة تحتفظ بـ`gen_random_uuid()` احتياطًا |
| `pino`, `nestjs-pino` | سجلات JSON منظمة | قائمة تنقيح إلزامية (§7.6) |
| `@opentelemetry/sdk-node` + instrumentations (http, express, pg) + مُصدِّر OTLP | التتبع عبر api و worker و Graph API | `OTEL_*` |
| `prom-client` | مقاييس `/metrics` | شبكة داخلية فقط |
| `helmet`, `cookie-parser` | ترويسات الأمان وقراءة الكوكي | CSP للـAPI بسيطة (§14) |
| `@nestjs/throttler` | حد المعدل لكل نسخة | الحماية الأساسية من التخمين في القاعدة نفسها (`failed_login_count`, `locked_until`) |
| `fetch` المدمج في Node.js | استدعاء Graph API | مهلة صريحة بـ`AbortSignal.timeout` وإعادة محاولة في العامل فقط |

لا تُضاف مكتبة طوابير خارجية ولا Redis في الإصدار الأول (DEC-07).

---

## 5. الواجهة — المكتبات

| المكتبة | الغرض | ملاحظات التنفيذ |
|---|---|---|
| `react`, `react-dom`, `typescript`, `vite` | التطبيق | `<html lang="ar" dir="rtl">` |
| `react-router` | التوجيه وأغلفة الأدوار | مسار الدخول واحد؛ الغلاف حسب الدور بعد الدخول |
| `@tanstack/react-query` | حالة الخادم والمزامنة | إعادة الجلب عند الاتصال والعودة من الخلفية؛ إبطال الاستعلامات عند أحداث WebSocket |
| `zustand` | حالة الواجهة المحلية | الصوت المفعّل، حالة الاتصال، طبقة العرض، المسودة |
| `socket.io-client` | الاتصال الفوري | إعادة الاتصال التلقائي ثم `GET /v1/me/home` قبل تفعيل الأوامر |
| `vite-plugin-pwa` (استراتيجية `injectManifest` مع Workbox) أو Service Worker مكتوب يدويًا | Manifest، التخزين المسبق لهيكل التطبيق، معالجات Push | لا تخزين لاستجابات API؛ لا أوامر دون اتصال |
| `tailwindcss` + preset الهوية من `brand/tokens/` | الأنماط وفق الهوية | خصائص منطقية (`ms-*`, `pe-*`, `start-*`) لدعم RTL؛ وضع داكن للسائق (DEC-19) |
| `@radix-ui/react-*` | عناصر وصول جاهزة (Dialog، Popover، Tabs، Toast...) | `DirectionProvider` بقيمة `rtl` |
| `react-hook-form` + `@hookform/resolvers` + `zod` | نماذج الاستلام والإعدادات | النموذج يحتفظ بمدخلاته بعد فشل الشبكة |
| `date-fns`, `date-fns-tz` | عرض الأوقات بتوقيت `Asia/Riyadh` | `Intl` بلغة `ar-SA-u-nu-latn` لأرقام لاتينية |
| `lucide-react` | الأيقونات | — |
| `qrcode` | توليد QR للوحة الربط D-07 | يُولد محليًا من رابط `wa.me` الذي يعيده الخادم |
| `@fontsource/ibm-plex-sans-arabic` + `@fontsource/ibm-plex-mono` (woff2 مستضافة ذاتيًا عبر الحزمة) | الطباعة (DEC-18) | `font-display: swap`؛ لا خطوط من نطاقات خارجية |

التصوير: `<input type="file" accept="image/*" capture="environment">` ثم ضغط الصورة في المتصفح (Canvas) إلى عرض أقصى 1600 بكسل بصيغة JPEG أو WebP دائمًا قبل الرفع المباشر إلى S3 برابط موقع؛ يقبل الخادم الأنواع في `media_assets.content_type`، لكن HEIC لا يُفك على الخادم (libvips المبني مسبقًا في `sharp` بلا HEVC) فينتهي رفعه بـ`MEDIA_TYPE_UNSUPPORTED` عند `complete` (القرار DEC-98). عند `POST /v1/media/{mediaId}/complete` يتحقق الخادم من الحجم و`sha256` المعلنين مقابل الكائن المرفوع، ثم يزيل بيانات EXIF والموقع ويحفظ النسخة المنقّاة بصيغتها المعلنة (JPEG أو PNG أو WebP بجودة 85) وبحجمها وهاشها الجديدين (DEC-36).

---

## 6. الاختبار والجودة

| الأداة | الاستخدام |
|---|---|
| Vitest (مع إضافة SWC لمزخرفات NestJS) | اختبارات الوحدة والمنطق النقي |
| Testcontainers (`postgres:16`) + Supertest | اختبارات التكامل على قاعدة حقيقية: القيود، الأقفال، السباقات، Outbox |
| `socket.io-client` في الاختبارات | التحقق من الغرف و`task.claimed` و`session.revoked` |
| Playwright | e2e على عروض 360 و390 و430 بكسل بالعربية RTL، ومحاكاة الانقطاع |
| k6 | اختبار الحمل (5 قاعات، 50 سائقًا، 100 طلب/دقيقة) |
| `tools/wa-simulator` | رسائل واتساب واردة وصادرة دون مراسلة أي عميل |
| ESLint (typescript-eslint) + Prettier | الأسلوب والأخطاء الشائعة |
| `dependency-cruiser` أو `eslint-plugin-boundaries` | فرض اتجاهات الاعتماد بين الوحدات (`04` §4.3) |
| `tsc --noEmit` | فحص الأنواع الصارم في CI |

خطة الاختبارات الكاملة وربطها بمعايير القبول في `17_Test_Acceptance_Plan.md`.

---

## 7. اصطلاحات الكود

### 7.1 التسمية والصيغ

- الملفات `kebab-case`، الأصناف `PascalCase`، الدوال والمتغيرات `camelCase`.
- **أشكال البيانات بمفاتيح `snake_case`** مطابقة للقاعدة وCanon: صفوف القاعدة، DTO على السلك، الأحداث، حمولات WebSocket. لا طبقة تحويل بين `camelCase` و`snake_case`.
- القيم المحدودة تُستورد من `@point/shared` كأنواع اتحاد نصية بالقيم الحرفية من Canon §5؛ ممنوع تكرارها نصًا داخل الوحدات.
- الأوقات على السلك ISO‑8601 UTC (`2026-10-27T19:20:00.000Z`)؛ التاريخ المحلي للحفل `event_date` بصيغة `YYYY-MM-DD`.
- المبالغ أعداد صحيحة بالهللة `*_halalas` مع `currency = "SAR"`.
- المعرفات UUIDv7 تولدها الخلفية.
- في TypeScript نوع الحفل اسمه `VenueEvent` لتجنب تعارض `Event` (Canon §3).

### 7.2 التحقق من المدخلات

- كل مسار له مخطط zod للطلب والرد في `@point/shared`، يُستخدم في الخادم (Pipe) والواجهة (النماذج والاستعلامات).
- الحقول غير المعروفة تُرفض (`strict`).
- يُولد توصيف OpenAPI من المخططات ويُقارن بـ`07_openapi.yaml` في CI؛ أي اختلاف يُفشل البناء.

### 7.3 الأخطاء

- `throw new AppError('TASK_ALREADY_CLAIMED', { details })`؛ الفلتر العام يبني الغلاف الموحد (Canon §8) مع `message_ar` من فهرس `@point/shared`.
- انتهاكات القيود تُحوّل باسم القيد عبر `core/errors/pg-constraint-map.ts` (الجدول الكامل في الملف 08).
- لا تُعاد رسائل قاعدة البيانات ولا تتبعات الأخطاء للعميل أبدًا؛ `INTERNAL_ERROR` مع `request_id` فقط.

### 7.4 المعاملات والأقفال

- كل أمر داخل `withTransaction(async (tx) => { ... })` في حالة الاستخدام.
- الأقفال عبر مساعدات مرتبة فقط وبترتيب Canon §14ب (L0…L10): `lockIdempotency` (L0، أول جملة في الأمر) ← `lockPools(tx, ids)` (L1) ← `lockEvents(tx, ids)` (L2؛ `FOR SHARE` للتحصيل وتسليم النقد) ← `lockTransfers` ← `lockAssignments` ← `lockUsers` (L3) ← `lockTasks(tx, ids)` (L4) ← `lockTickets(tx, ids)` (L5) ← `lockCycles` (L6) ← `lockOffers` (L7) ← `lockDutySessions(tx, userIds)` (L8)، ثم الصفوف التابعة (L9) والإلحاقيات (L10) آخر المعاملة؛ النمط `FOR NO KEY UPDATE`. المساعدات تفرض الترتيب وترمي خطأ برمجيًا إن خولف، مع الاستثناء الوحيد في Canon §14ب: معاملة تحمل L1 يجوز لها بعد أقفال أمرها قفل صفوف إضافية من L4–L8 **لنفس المجموعة** لتمريرة التوزيع و`settleDriverAfterTask`.
- ممنوع أي استدعاء شبكي داخل المعاملة (Graph API، Push، رفع S3). يُراجع في مراجعة الكود ويُغطى بقاعدة lint مخصصة على مجلدات `use-cases`.
- `SET LOCAL lock_timeout` و`statement_timeout` من المتغيرات `DATABASE_LOCK_TIMEOUT_MS` (3000) و`DATABASE_STATEMENT_TIMEOUT_MS` (5000).
- سياسة الإعادة (Canon §14ب): المعاملة كلها تُعاد حتى 3 مرات عند `40001`/`40P01` بتأخير عشوائي 20–80 ms (`point_db_tx_retries_total`)؛ تجاوز `lock_timeout` (`55P03`) لا يُعاد على الخادم، ويرد `IDEMPOTENCY_IN_PROGRESS` إن حدث عند L0 وإلا `SERVICE_UNAVAILABLE` (`retryable: true`).

### 7.5 الوقت

- كل منطق النطاق يستخدم `Clock` المحقونة؛ ممنوع `new Date()` أو `Date.now()` داخل `domain/` و`use-cases/`.
- العمليات تعمل بـ`TZ=UTC`؛ العرض فقط بـ`DISPLAY_TIMEZONE=Asia/Riyadh`.

### 7.6 السجلات

- pino بصيغة JSON، وكل سطر يحمل: `request_id`, `user_id`, `role`, `venue_id`, `route`, `status`, `duration_ms` (والعامل: `outbox_id`, `job_type`, `attempt`).
- قائمة التنقيح الإلزامية: الكوكيز وترويسة `authorization`، أي مفتاح يحتوي `phone` أو `wa_id` أو `code` أو `token` أو `pin` أو `password` أو `secret`، `raw_body`، `code_ciphertext`، `mfa_secret_enc`، `push_endpoint` و`push_p256dh` و`push_auth`.
- لا يُسجل نص رسالة واتساب الصادرة إلا بنسخته المقنّعة، ولا قيمة زر واتساب (`payload`) أبدًا.
- المستويات: `error` لما يحتاج تدخلًا، `warn` للرفض المتوقع المتكرر، `info` للأوامر، `debug` محليًا فقط.

### 7.7 الأسرار والواجهة

- لا سر في حزمة الواجهة. المتغيرات العامة فقط بالبادئة `VITE_` (§8).
- الأسرار تُقرأ عبر `SecretResolver`: `env://NAME` محليًا، و`sm://path` من مدير الأسرار في البيئات الأخرى. حقول `whatsapp_channel.*_secret_ref` تخزن المرجع لا القيمة.

### 7.8 اللغة والاتجاه

- نصوص الواجهة في `apps/web/src/i18n/ar.ts` بمفاتيح ثابتة؛ لا نصوص صلبة في المكونات.
- أسماء العلامتين من الإعدادات (`BRAND_*`)؛ «مصاف» لا تظهر في الواجهة إلا في لوحة QR وما ينص عليه Canon §1.
- أرقام لاتينية 0–9 في كل العرض (DEC-17).

---

## 8. متغيرات البيئة (`.env.example`)

```dotenv
# =========================================================
# POINT (staff) / MASAF (customer) — .env.example
# Never commit real values. Staging/production read secrets
# through the secret manager (sm://...) — see §10.
# =========================================================

# ---------- Runtime ----------
NODE_ENV=development                 # development | test | production
APP_ENV=local                        # local | staging | production
TZ=UTC                               # processes always run in UTC
DISPLAY_TIMEZONE=Asia/Riyadh
LOG_LEVEL=info                       # debug | info | warn | error
APP_VERSION=dev                      # set by CI (git sha / tag)

# ---------- URLs (Q-01) ----------
APP_BASE_URL=http://localhost:5173   # staff web app (بوينت); Origin header is checked against it (CSRF)
API_BASE_URL=http://localhost:5173   # same origin everywhere (DEC-29): locally via the Vite proxy to API_PORT
API_PORT=3000

# ---------- Brand (canon §1) ----------
BRAND_STAFF_NAME_AR=بوينت
BRAND_STAFF_NAME_EN=POINT
BRAND_CUSTOMER_NAME_AR=مصاف
BRAND_CUSTOMER_NAME_EN=MASAF

# ---------- Database ----------
DATABASE_URL=postgres://point:point@localhost:5432/point
DATABASE_POOL_MAX=20
DATABASE_STATEMENT_TIMEOUT_MS=5000
DATABASE_LOCK_TIMEOUT_MS=3000
DATABASE_SSL=false                   # true in staging/production

# ---------- Sessions & crypto ----------
SESSION_SECRET=                      # 32+ random bytes (base64); rotating logs everyone out
SESSION_COOKIE_NAME=__Host-point_sid # use point_sid when SESSION_COOKIE_SECURE=false (local http)
SESSION_COOKIE_SECURE=false          # true everywhere except local http
CODE_PEPPER=                         # HMAC key for claim codes (DEC-15); rotate only between events
AUTH_SECRET_PEPPER=                  # base64 32 bytes, argon2id pepper for PINs/passwords (09 §9.1, DEC-58); rotating it invalidates every secret
DATA_ENCRYPTION_KEY=                 # base64 32 bytes, AES-256-GCM (TOTP secrets, claim code ciphertext)
DATA_ENCRYPTION_KEY_ID=k1            # key id stored with ciphertext to allow rotation
# Action-token TTL is NOT an env var: org setting wa.action_token_ttl_h (72 h from creation, Canon §12)

# ---------- WhatsApp — single number «مصاف» ----------
WA_MODE=simulator                    # live | simulator (must equal whatsapp_channel.mode)
WA_GRAPH_BASE_URL=http://localhost:4010  # simulator (tools/wa-simulator) while WA_MODE=simulator; https://graph.facebook.com when live
WA_API_VERSION=                      # pin the current Graph API version at implementation (see 12)
WA_BUSINESS_ACCOUNT_ID=
WA_PHONE_NUMBER_ID=                  # the ONE sender for all venues
WA_DISPLAY_PHONE_E164=               # used to build wa.me links for QR linking
WA_ACCESS_TOKEN_REF=env://WA_ACCESS_TOKEN
WA_APP_SECRET_REF=env://WA_APP_SECRET
WA_APP_SECRET_PREVIOUS_REF=           # set only during app-secret rotation (24h dual acceptance), then removed
WA_VERIFY_TOKEN_REF=env://WA_VERIFY_TOKEN
WA_ACCESS_TOKEN=                     # local/staging only; production via sm://
WA_APP_SECRET=                       # verifies X-Hub-Signature-256
WA_VERIFY_TOKEN=                     # webhook GET verification
# Send pacing is NOT configured here: org settings wa.global_mps, wa.pair_bucket_capacity, wa.pair_refill_s (Canon §12, file 12 §5)
WA_HTTP_TIMEOUT_MS=10000
WA_TEST_RECIPIENT_ALLOWLIST=         # staging: comma separated E.164 numbers; others are refused

# ---------- Web Push (VAPID) ----------
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:ops@example.com # replace with the operator contact

# ---------- Object storage (S3 compatible, private) ----------
S3_ENDPOINT=http://localhost:9000    # empty for AWS S3
S3_REGION=us-east-1                  # any value for MinIO
S3_BUCKET_MEDIA=point-media
S3_BUCKET_EXPORTS=point-exports
S3_ACCESS_KEY_ID=minio
S3_SECRET_ACCESS_KEY=minio-secret
S3_FORCE_PATH_STYLE=true
MEDIA_UPLOAD_URL_TTL_S=300
MEDIA_READ_URL_TTL_S=300
MEDIA_MAX_BYTES=10485760
EXPORT_URL_TTL_S=300

# ---------- Rate limits (07 §1.9 classes; per api process; 0 = no limit for the class) ----------
RATE_LIMIT_ENABLED=true              # default: on, except NODE_ENV=test
RATE_LIMIT_AUTH_PER_MIN=10           # per client IP (login, MFA verify); raise it if many drivers share one NAT/Wi-Fi
RATE_LIMIT_COMMANDS_PER_MIN=60       # per user
RATE_LIMIT_ACCEPT_PER_10S=20         # per user, accepting offers (on top of the command class)
RATE_LIMIT_WRITES_PER_MIN=30         # per user (logout, MFA setup/confirm, secret change)
RATE_LIMIT_READS_PER_MIN=300         # per user
RATE_LIMIT_DEVICE_PER_MIN=60         # per device session (heartbeat, devices, audio test, telemetry)
RATE_LIMIT_EXPORTS_PER_HOUR=5        # per user
RATE_LIMIT_WEBHOOK_PER_MIN=6000      # per source IP (a valve; Meta retries a 429)
TRUST_PROXY=1                        # reverse-proxy hops in front of the api (client IP from X-Forwarded-For)

# ---------- Worker ----------
WORKER_ID=                           # defaults to hostname
WORKER_CONCURRENCY=8
WORKER_BATCH_SIZE=20
WORKER_POLL_INTERVAL_MS=500
WORKER_LEASE_SECONDS=30
DISPATCH_SWEEP_INTERVAL_S=5
HEARTBEAT_SWEEP_INTERVAL_S=15
RETENTION_PURGE_CRON_UTC=0 2 * * *   # 05:00 Asia/Riyadh

# ---------- Realtime ----------
WS_PATH=/ws
WS_TRANSPORTS=websocket              # add ,polling only with sticky sessions at the load balancer
REALTIME_NOTIFY_CHANNEL=point_realtime
OUTBOX_NOTIFY_CHANNEL=point_outbox

# ---------- Observability ----------
OTEL_SERVICE_NAME=point-api          # point-worker for the worker
OTEL_EXPORTER_OTLP_ENDPOINT=
OTEL_TRACES_SAMPLER_ARG=0.2
METRICS_ENABLED=true
METRICS_PORT=9464                    # internal network only

# ---------- Web (public, bundled into the client — NO secrets) ----------
VITE_API_BASE_URL=                   # empty = same origin
VITE_WS_PATH=/ws
VITE_VAPID_PUBLIC_KEY=
VITE_BRAND_STAFF_NAME_AR=بوينت
VITE_BRAND_STAFF_NAME_EN=POINT
VITE_BRAND_CUSTOMER_NAME_AR=مصاف     # only on the allowed staff surfaces: D-07, S-03, S-13 (canon §1, DEC-83)
VITE_APP_VERSION=dev
```

القيم التشغيلية (المؤقتات، الحدود، الاحتفاظ) **ليست** متغيرات بيئة؛ هي في `venues.settings` و`organizations.settings` بالقيم الافتراضية في Canon §12.

- **متغيرات الويب (القرار DEC-83):** يقرأ Vite ملف `.env` الواحد في جذر المستودع (`envDir`). إن لم يُضبط `VITE_BRAND_STAFF_NAME_AR` إطلاقًا (نسخة جديدة، CI) يؤخذ `short_name` من `manifest.webmanifest` لا نص صلب، و`brand` في `GET /v1/me` (إعدادات المؤسسة) يتقدم وقت التشغيل.
- **مشغّل التخزين (القرار DEC-108):** S3 عند ضبط `S3_ENDPOINT` أو المفتاحين الثابتين معًا (`S3_ACCESS_KEY_ID` و`S3_SECRET_ACCESS_KEY`)، ودائمًا في `staging` و`production` (دور المثيل أو المهمة عبر سلسلة اعتماد AWS الافتراضية حين لا تُضبط مفاتيح ثابتة)؛ والحاوية في الذاكرة فقط في `local` و`test` دون أي إعداد S3، مع تحذير في `local` لأن الصور تضيع عند إعادة التشغيل.

---

## 9. البيئات

| البيئة | الغرض | واتساب | البيانات | الوصول | النشر |
|---|---|---|---|---|---|
| `local` | تطوير على جهاز المطور | `WA_MODE=simulator` دائمًا | seed اصطناعية | المطور | `pnpm dev` |
| `test` (CI) | الاختبارات الآلية | المحاكي | حاويات مؤقتة | CI | كل طلب دمج |
| `staging` | قبول، اختبار أجهزة فعلية، تجربة القوالب | رقم اختبار معزول من Meta **لا يراسل أي عميل حقيقي** + `WA_TEST_RECIPIENT_ALLOWLIST` | اصطناعية؛ يُمنع نسخ بيانات الإنتاج | الفريق | دمج على `main` |
| `production` | التشغيل الفعلي | الرقم الواحد «مصاف» `WA_MODE=live` | حقيقية | مقيد مع MFA | إصدار موسوم بموافقة |

قواعد:

1. كل بيئة لها قاعدة بيانات ودلاء تخزين ومفاتيح VAPID وأسرار مستقلة.
2. بيئة `staging` ترفض الإرسال لأي رقم خارج القائمة المسموحة حتى لو وُجد خطأ في البيانات.
3. رقم الإنتاج لا يُستخدم في أي بيئة أخرى، ولا يوجد إلا صف `whatsapp_channel` فعال واحد في كل بيئة (`uq_whatsapp_channel_active`).
4. دلو الوسائط في كل بيئة له قاعدة دورة حياة تحذف البادئة `incoming/` بعد يوم واحد (القرار DEC-97): رابط PUT الموقّع يكتب في `incoming/{org}/{ticket}/{media}-{nonce}`، والنسخة المنقّاة تُحفظ بمفتاح 09 §6.1 ويُحذف الأصل قبل `uploaded`، فتكنس القاعدة الأيتام (رفع لم يكتمل، إعادة PUT برابط ما زال صالحًا بعد الإتمام، توقف بين الكتابة والحذف). محليًا تضيفها خدمة `minio-init` (§9.1).

### 9.1 التطوير المحلي (`infra/compose/docker-compose.yml`)

```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: point
      POSTGRES_PASSWORD: point
      POSTGRES_DB: point
    ports: ["5432:5432"]
    volumes: ["pgdata:/var/lib/postgresql/data"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U point -d point"]
      interval: 5s
      retries: 10
  minio:
    image: minio/minio
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: minio
      MINIO_ROOT_PASSWORD: minio-secret
    ports: ["9000:9000", "9001:9001"]
    volumes: ["miniodata:/data"]
  minio-init:
    image: minio/mc
    depends_on: [minio]
    entrypoint: >
      /bin/sh -c "mc alias set local http://minio:9000 minio minio-secret &&
                  mc mb -p local/point-media local/point-exports &&
                  mc anonymous set none local/point-media &&
                  mc anonymous set none local/point-exports &&
                  { mc ilm rule rm --all --force local/point-media >/dev/null 2>&1 || true; } &&
                  mc ilm rule add --expire-days 1 --prefix incoming/ local/point-media"
  wa-simulator:
    build: ../../tools/wa-simulator
    environment:
      WEBHOOK_URL: http://host.docker.internal:3000/webhooks/whatsapp
      APP_SECRET: ${WA_APP_SECRET}
    ports: ["4010:4010"]
volumes:
  pgdata: {}
  miniodata: {}
```

المنافذ المحلية: الواجهة 5173، الـAPI 3000، PostgreSQL 5432، MinIO 9000 (لوحة 9001)، المحاكي 4010، المقاييس 9464.

في التطوير يمرر Vite الطلبات `/v1` و`/ws` و`/webhooks` إلى `localhost:3000` (proxy) ليعمل الكوكي كطرف أول دون CORS.

### 9.2 محاكي واتساب (`tools/wa-simulator`)

- يحاكي `POST /{api-version}/{phone-number-id}/messages` ويعيد `wamid` وهميًا، ويحفظ الرسائل في ذاكرته مع واجهة عرض بسيطة. يُستهدف بتعيين `WA_GRAPH_BASE_URL` إلى عنوانه (`http://localhost:4010` محليًا) مع `whatsapp_channel.mode = 'simulator'` (الملف 12 §11)؛ لا متغير عنوان منفصل للمحاكي.
- يرسل Webhooks موقعة بـ`X-Hub-Signature-256` باستخدام `APP_SECRET` نفسه: ضغطة زر بقيمة `payload` لرسالة سابقة، نص حر، رسالة ربط QR، كلمة إيقاف، حالات `sent/delivered/read/failed` بترتيب طبيعي أو معكوس أو مكرر.
- سيناريوهات جاهزة لاختبارات القبول: تكرار الحدث 10 مرات (AC-01)، زر من رقم آخر (AC-02)، تذكرتان لنفس الرقم (AC-03)، أخطاء المزود القابلة وغير القابلة لإعادة المحاولة، تعطل القناة.
- يعرض رمز التسليم في واجهته المحلية فقط لأغراض الاختبار؛ ممنوع تشغيله في `production`.

---

## 10. إدارة الأسرار

| السر | الاستخدام | التخزين | التدوير وأثره |
|---|---|---|---|
| `WA_ACCESS_TOKEN` | إرسال رسائل Graph API | مدير الأسرار (`sm://`) | رمز مستخدم نظام طويل الأجل؛ تدوير دوري وعند الاشتباه؛ تحديث المرجع دون إعادة نشر |
| `WA_APP_SECRET` | التحقق من توقيع Webhook | مدير الأسرار | عند التدوير: `WA_APP_SECRET_PREVIOUS_REF` يُقبل معه 24 ساعة ثم يُزال (الملف 12 §3.3) |
| `WA_VERIFY_TOKEN` | تحقق إعداد Webhook | مدير الأسرار | عند إعادة إعداد الاشتراك |
| `SESSION_SECRET` | توقيع الكوكي | مدير الأسرار | التدوير يخرج الجميع؛ يُجدول خارج أوقات الحفلات |
| `CODE_PEPPER` | HMAC لرموز التسليم | مدير الأسرار | التدوير يبطل الرموز النشطة؛ بين الحفلات فقط |
| `AUTH_SECRET_PEPPER` | pepper اشتقاق argon2id للأرقام السرية وكلمات المرور (09 §9.1، DEC-58)؛ إلزامي في كل البيئات | مدير الأسرار | التدوير يبطل كل الأرقام السرية وكلمات المرور؛ لا يُدوَّر إلا مع إعادة تعيين شاملة |
| `DATA_ENCRYPTION_KEY` (+ المعرف) | تشفير أسرار TOTP والنسخ المؤقتة للرموز | مدير الأسرار | مفتاح جديد بمعرف جديد؛ القديم للقراءة حتى إعادة التشفير |
| `VAPID_PRIVATE_KEY` | توقيع Web Push | مدير الأسرار | **التدوير يبطل كل اشتراكات Push**؛ يتطلب إعادة اشتراك الأجهزة |
| مفاتيح S3 | التخزين | مدير الأسرار أو هوية الخدمة | تدوير دوري |
| `DATABASE_URL` | الاتصال | مدير الأسرار | مستخدم تطبيق بصلاحيات محدودة (`06_schema.sql` §17) |

لا يُطبع أي سر في السجلات أو رسائل الأخطاء أو مخرجات CI، ويُفعَّل فحص الأسرار في المستودع (secret scanning).

---

## 11. التكامل والنشر المستمر (GitHub Actions)

### 11.1 مراحل خط البناء

| المرحلة | التشغيل | البوابة |
|---|---|---|
| `install` | `pnpm install --frozen-lockfile` | — |
| `lint` | ESLint + Prettier + فحص حدود الوحدات | صفر أخطاء |
| `typecheck` | `tsc --noEmit` لكل الحزم | صفر أخطاء |
| `unit` | Vitest | نجاح كامل |
| `db-drift` | بناء قاعدة من الترحيلات وأخرى من `docs/06_schema.sql` ثم مقارنة `pg_dump --schema-only --no-owner --no-privileges` بعد التطبيع | لا اختلاف |
| `db-invariants` | تشغيل `docs/06_schema_invariants_test.sql` على قاعدة مبنية من الترحيلات | ظهور `ALL INVARIANT TESTS PASSED` |
| `integration` | Vitest + Testcontainers `postgres:16` + المحاكي | نجاح كامل، بما فيها اختبارات السباق |
| `openapi` | توليد OpenAPI من المخططات ومقارنته بـ`docs/07_openapi.yaml` | لا اختلاف غير مقصود |
| `e2e` | Playwright على 360/390/430 بكسل | نجاح كامل |
| `build` | صورة Docker واحدة للخلفية + ملفات الواجهة الثابتة | — |
| `security` | فحص الاعتماديات والأسرار | لا ثغرات حرجة مفتوحة |

### 11.2 ترتيب النشر

1. تشغيل الترحيلات **مرة واحدة** كمهمة مستقلة قبل تحديث أي نسخة.
2. تحديث `worker` ثم `api` تدريجيًا (rolling)، ثم نشر الواجهة الثابتة.
3. الترحيلات بنمط «توسيع ثم تقليص» (expand/contract): إضافة متوافقة أولًا، ثم إزالة القديم في إصدار لاحق؛ لا تعديل يكسر نسخة تعمل.
4. ممنوع حذف أي قيد أو فهرس جزئي من الثوابت في `06_schema.sql` في أي ترحيل.
5. الواجهة: ملفات بأسماء مُجزأة (hashed) وتخزين طويل، و`index.html` و`sw.js` و`manifest` بلا تخزين طويل. عند وجود Service Worker جديد يظهر للمستخدم «تحديث متاح» ويُطبّق بنقرة، ولا يُفرض التحديث أثناء مهمة جارية.
6. النشر في الإنتاج خارج أوقات ذروة الحفلات ما أمكن، مع إمكانية التراجع للصورة السابقة.

---

## 12. المراقبة (Observability)

### 12.1 السجلات والتتبع

- سجلات JSON مركزية بالحقول في §7.6، والاحتفاظ 30–90 يومًا حسب المنصة.
- OpenTelemetry يتتبع: طلب HTTP → المعاملة → `pg`؛ والعامل: استئجار المهمة → استدعاء Graph API أو Push. معرف التتبع يُضاف للسجل.

### 12.2 المقاييس الأساسية (الكتالوج الملزم)

كل المقاييس ببادئة `point_` ووحدات Prometheus القياسية (ثوانٍ لا مللي ثوانٍ). هذا الجدول هو المرجع الوحيد للأسماء؛ الملفات 10 و12 و15 تستخدم الأسماء نفسها. لا تسميات بقيم عالية التعدد (لا معرّف تذكرة أو مستخدم في الوسوم).

| المقياس | النوع | الوصف |
|---|---|---|
| `point_http_request_duration_seconds{route,status}` | Histogram | زمن الأوامر والاستعلامات (هدف p95 لحفظ الطلب أقل من ثانيتين) |
| `point_retrieval_request_ingest_seconds` | Histogram | من استلام Webhook زر «طلب السيارة» إلى التزام دورة الإحضار |
| `point_dispatch_publish_seconds` | Histogram | من التزام الإسناد أو العرض إلى نشر حدث WebSocket (هدف p95 أقل من 3 ثوانٍ) |
| `point_dispatch_time_to_claim_seconds` | Histogram | من دخول الطابور إلى القبول المؤكد — المؤشر الأهم |
| `point_dispatch_pass_duration_seconds{reason}` | Histogram | زمن تمريرة التوزيع (هدف p95 أقل من 50 ms) |
| `point_dispatch_pool_lock_wait_seconds` | Histogram | انتظار قفل مجموعة التوزيع |
| `point_dispatch_offers_total{mode,outcome}` | Counter | العروض الفردية والبث ونتائجها (`accepted`، `expired`، `revoked`…) |
| `point_dispatch_accept_rejections_total{code}` | Counter | رفض القبول حسب رمز الخطأ |
| `point_dispatch_escalations_total` | Counter | التصعيد للمشرف |
| `point_dispatch_open_tasks{pool}` · `point_dispatch_broadcast_open{pool}` | Gauge | الطلبات المفتوحة وجولات البث القائمة لكل مجموعة |
| `point_timer_lag_seconds{job}` | Histogram | تأخر تنفيذ المؤقت عن `available_at` (تنبيه إذا p95 أكبر من ثانيتين) |
| `point_outbox_due{type}` | Gauge | صفوف Outbox المستحقة غير المعالجة |
| `point_outbox_oldest_pending_seconds{type}` | Gauge | عمر أقدم صف مستحق |
| `point_outbox_events_total{type,status}` | Counter | نتائج المعالجة (`done`، `failed`، `dead`، `canceled`) |
| `point_wa_send_duration_seconds` | Histogram | من إنشاء الإشعار حتى قبول المزود |
| `point_wa_delivery_seconds` | Histogram | من قبول المزود حتى `delivered` (للمعلومة) |
| `point_wa_send_total{outcome,error_code}` | Counter | محاولات الإرسال ونتائجها |
| `point_wa_skipped_total{reason}` | Counter | إشعارات لم تُرسل وسببها |
| `point_wa_webhook_duration_seconds` | Histogram | زمن رد معالج `POST /webhooks/whatsapp` |
| `point_wa_webhook_received_total` · `point_wa_webhook_last_received_timestamp_seconds` | Counter · Gauge | الوارد ووقت آخر حدث |
| `point_wa_inbound_backlog` · `point_wa_inbound_processing_lag_seconds` | Gauge | صفوف الوارد المعلّقة وعمر أقدمها |
| `point_wa_button_sender_mismatch_total` · `point_wa_status_orphan_total` | Counter | ضغطات زر من رقم آخر · حالات بلا رسالة مطابقة |
| `point_wa_service_messages_month` · `point_wa_unique_users_24h_outside_window` | Gauge | استهلاك حصص Meta (الملف 12 §13) |
| `point_wa_channel_health` | Gauge | 0 `healthy` · 1 `degraded` · 2 `down` |
| `point_push_send_total{outcome}` | Counter | Web Push ونتائجه |
| `point_ws_connections{venue}` · `point_ws_reconnects_total` | Gauge · Counter | الاتصال الفوري |
| `point_db_pool_in_use` · `point_db_lock_wait_seconds` · `point_db_tx_retries_total{sqlstate}` | Gauge · Histogram · Counter | قاعدة البيانات |
| `point_drivers_on_duty{venue}` · `point_drivers_connection_uncertain{venue}` | Gauge | حالة المناوبات |
| `point_backup_last_success_timestamp_seconds` | Gauge | آخر نسخة احتياطية ناجحة |

### 12.3 تنبيهات النظام (من المعمارية §15، قيم أولية تُضبط بعد التجربة)

الملف 14 هو المرجع لشروط تنبيهات التطبيق (`alerts.type`) وشدتها وأصواتها ونصوصها؛ الجدول أدناه ملخص يربطها بالمراقبة. الأنواع التي تمس أكثر من موقع (`outbox_lag`، `wa_webhook_silent`، `wa_channel_down`، `transfer_blocked`) تُنشئ صفًا لكل موقع متأثر فيه حفل مفتوح أو قيد الإغلاق، لمشرفيه وللإدارة (DEC-46).

| التنبيه | الشرط المقترح | الأثر |
|---|---|---|
| ارتفاع عمر Outbox | أقدم صف مستحق أقدم من `ops.outbox_lag_alert_s` (30 ثانية)، أو أي صف يصير `dead` | تنبيه `outbox_lag` حرج |
| توقف Webhooks | لا حدث وارد منذ 10 دقائق مع وجود إرسال ناجح في الفترة نفسها | تنبيه `wa_webhook_silent` حرج (صوت `escalation`) لمشرفي الموقع والإدارة |
| صحة قناة واتساب وفشل الإرسال | انتقالات `healthy`/`degraded`/`down` بالقاعدة المعرّفة في الملف 12 §5.14 وحده (لا تُكرر هنا)؛ الفشل الدائم لإشعار عميل | `wa_channel_down` عند `down` / `wa_send_failed` للإشعار الفاشل |
| غياب السائقين المؤهلين | طلب إحضار مفتوح في مجموعة لا يوجد فيها سائق مناوب غير مستريح | `no_drivers_on_duty` |
| مهام معلقة | حسب `StuckDetector` (`04` §6.7) | تنبيه `task_stuck` (تحذير، صوت `reminder`) لمشرفي الموقع |
| فقد الاتصال | سائق `offline` وبعهدته مركبة أو مفتاح أو مهمة نشطة | `driver_connection_lost_with_custody` |
| تجاوز زمن الانتظار | طلب غير مقبول 60 ثانية | `request_unaccepted` |
| فشل النسخ الاحتياطي | أي نسخة يومية فاشلة | تنبيه حرج للمالك والإدارة |

مؤشر قبول المهمة أهم من مؤشر إرسال التنبيه (المعمارية §15).

---

## 13. النسخ الاحتياطي والاستعادة

| البند | المقترح |
|---|---|
| النسخ | نسخ يومية مشفرة لـPostgreSQL من المزود المُدار، مع استعادة زمنية (PITR) إن دعمها المزود |
| الاحتفاظ بالنسخ | 30 يومًا على الأقل، ونسخة شهرية لمدة 12 شهرًا (تُراجع مع سياسة الاحتفاظ Q-06) |
| تخزين الكائنات | بلا إصدارات (versioning) على دلوي الوسائط والتصديرات (DEC-128): الحذف حذف فعلي، فلا تبقى أصول غير منقّاة (09 §6.2، DEC-36) ولا صور حُذفت بالاحتفاظ نسخًا غير حالية؛ المتانة من تكرار التخزين لدى المزود وخطة النسخ الاحتياطي (PNT-095). قاعدة دورة حياة الوسائط `incoming/` بعد يوم (DEC-97)، وحذف الصور بالاحتفاظ تجريه `job.retention_purge` (06 ERD §8) فيحترم الحجز القانوني |
| هدف نقطة الاستعادة RPO | 5 دقائق مع PITR، وإلا 24 ساعة (يُوثق حسب المزود) |
| هدف زمن الاستعادة RTO | ساعة واحدة للخدمة الكاملة؛ وأثناءها الإجراء الورقي (`04` §8.13) |
| تمرين الاستعادة | قبل الإطلاق (معيار القبول AC-12) ثم كل ربع سنة: استعادة إلى بيئة معزولة + تشغيل فحص الثوابت + مطابقة عينة من التذاكر |
| الأسرار والإعدادات | نسخة موثقة من إعدادات البنية (كبنية ككود حيث أمكن) ومراجع الأسرار |

---

## 14. الأمان التشغيلي

### 14.1 النقل والترويسات

- HTTPS إلزامي (TLS 1.2 كحد أدنى، ويُفضّل 1.3)، و`Strict-Transport-Security: max-age=31536000; includeSubDomains` بعد التحقق من كل النطاقات الفرعية.
- ترويسات الـAPI: `X-Content-Type-Options: nosniff`، `Referrer-Policy: no-referrer`، `Cross-Origin-Resource-Policy: same-site`، `Cache-Control: no-store` لكل ردود `/v1`.
- ترويسات الواجهة (من الاستضافة الثابتة أو CDN):
  - `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data: <S3-host>; connect-src 'self' <API-origin> <WS-origin> <S3-host>; media-src 'self'; font-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`
  - `Permissions-Policy: geolocation=(), microphone=(), camera=(self), payment=()` — لا GPS في الإصدار الأول.
  - `X-Content-Type-Options: nosniff`، `Referrer-Policy: strict-origin-when-cross-origin`.

### 14.2 الكوكي والأصل

- الكوكي: `__Host-point_sid` بخصائص `Secure; HttpOnly; SameSite=Lax; Path=/` وبلا `Domain`.
- **الإنتاج: أصل واحد (ملزم، DEC-29)** — موازن الحمل أو CDN يوجه `/v1/*` و`/ws` و`/webhooks/*` و`/health/*` إلى `api` والباقي إلى الواجهة الثابتة. لا CORS، والكوكي طرف أول، و`connect-src 'self'`.
- لا يُستخدم نطاقان منفصلان للتطبيق والـAPI في الإنتاج (DEC-29)؛ في التطوير المحلي فقط يعمل Vite على 5173 والـAPI على 3000 عبر وكيل Vite بالأصل نفسه، فلا CORS في أي بيئة.
- لا تخزين للجلسة في التخزين المحلي، ولا لبيانات العميل خارج مسودة الاستلام الجارية؛ التخزين المحلي (IndexedDB أو `localStorage`) لمسودات الاستلام والتفضيلات فقط، لكل مستخدم، ويُمسح عند الخروج، ضمن `try/catch` (سلوك المسودات في الملف 02).

### 14.3 الـWebhook

- مسار `POST /webhooks/whatsapp` يقرأ الجسم **الخام** للتحقق من `X-Hub-Signature-256` قبل أي تحليل JSON، مع مقارنة ثابتة الزمن.
- حد حجم للجسم، وحد معدل، وعدم كشف تفاصيل في رد الخطأ.

### 14.4 الاعتماديات والكود

- فحص الاعتماديات وفحص الأسرار في CI؛ تحديثات أمنية خلال 7 أيام للثغرات الحرجة.
- مراجعة كود إلزامية لأي تغيير في: الصلاحيات، الأقفال، رموز التسليم، Webhook، الترحيلات.
- مستخدم قاعدة البيانات للتطبيق بصلاحيات محدودة: لا `UPDATE/DELETE` على `audit_log` و`ticket_events` و`custody_events` و`analytics_events` (`06_schema.sql` §17).

---

## 15. إعداد PWA والصوت والإشعارات

### 15.1 Manifest والأيقونات

- المصدر: `brand/manifest/` (manifest نموذجي) و`brand/app-icons/` (أيقونات بأحجام 192 و512 ونسخة maskable وأيقونة Apple 180 وأيقونة الشارة للإشعارات).
- الحقول كما في `brand/manifest/manifest.webmanifest`: `name` = «بوينت — نظام الفاليت»، `short_name` = «بوينت» (من `BRAND_STAFF_NAME_AR`)، `lang: "ar"`، `dir: "rtl"`، `start_url: "/?source=pwa"`، `scope: "/"`، `id: "/"`، `display: "standalone"`، `orientation: "portrait"`، `theme_color` و`background_color` من tokens الهوية.
- لا تظهر «مصاف» في الـmanifest ولا الأيقونات (Canon §1).

### 15.2 Service Worker

- النطاق `/`، ويُسجل بعد تحميل الصفحة.
- التخزين المسبق لهيكل التطبيق فقط (HTML/JS/CSS/الخطوط/الأيقونات/الأصوات). **لا تخزين لاستجابات `/v1`** ولا تنفيذ أوامر دون اتصال.
- معالج `push`: يعرض إشعارًا بحمولة مختصرة (نوع الحدث ورقم التذكرة فقط — DEC-23) مع `tag` = معرف المهمة. الأنواع: `offer` · `broadcast` · `reminder` · `next_due` · `escalation` · `closed` فقط؛ عند حجز الطلب أو سحبه أو إلغائه أو إعادة إسناده لغيره يُعرض إشعار هادئ من النوع `closed` بالوسم نفسه يستبدل القديم. كل رسالة Push تعرض إشعارًا (المتصفحات قد تلغي الاشتراك إن لم يُعرض).
- معالج `notificationclick`: يفتح أو يركّز نافذة التطبيق على الرئيسية (المسار `/d`)؛ التطبيق يجلب الحالة من الخادم ولا يثق ببيانات الإشعار.
- التحديث: عند توفر نسخة جديدة يظهر «تحديث متاح» ويُطبق بنقرة المستخدم وليس أثناء مهمة جارية.

### 15.3 الاشتراك في Push

- طلب الإذن فقط من نقرة مباشرة في D-03 أو D-14، وليس عند تحميل الصفحة.
- على iPhone وiPad: Web Push متاح لتطبيقات الشاشة الرئيسية (Home Screen web apps) بدءًا من iOS/iPadOS 16.4 وفق WebKit؛ تعرض D-14 دليل «أضف إلى الشاشة الرئيسية» عندما يعمل الموقع داخل Safari كتبويب.
- بعد الموافقة: `PushManager.subscribe({ userVisibleOnly: true, applicationServerKey: VITE_VAPID_PUBLIC_KEY })` ثم `PUT /v1/me/devices/{deviceId}` بالاشتراك و`notification_permission` و`display_mode`.
- رفض الإذن لا يمنع أي وظيفة أساسية (AC-22)؛ تظهر حالة التنبيه المتاحة بوضوح.

### 15.4 الصوت

- زر «تفعيل واختبار الصوت» ينشئ `AudioContext` ويستأنفه داخل النقرة، ويحمّل ويفك ترميز ملفات `brand/sounds/` مسبقًا، ثم يشغل `test` ويسأل السائق إن سمعها، ويرسل `POST /v1/me/audio-test`.
- لا يُفترض أن التشغيل التلقائي مسموح بعد الدخول (قيود المتصفحات على التشغيل التلقائي). إذا رفض المتصفح الاستئناف يظهر شريط «الصوت متوقف» بزر إعادة التفعيل.
- الاهتزاز عبر `navigator.vibrate` حيث يدعمه المتصفح (غير متاح في Safari على iPhone).
- لا وعد بصوت مخصص مستمر في الخلفية ولا بتجاوز الوضع الصامت أو التركيز (المعمارية §7).

### 15.5 إبقاء الشاشة

- طلب `navigator.wakeLock.request('screen')` عندما تكون صفحة العمل ظاهرة والمناوبة مفتوحة، وإعادة طلبه عند `visibilitychange`. لا يُعتبر مضمونًا، ويُختبر خصوصًا في وضع الشاشة الرئيسية على iPhone.

---

## 16. مصفوفة الأجهزة والمتصفحات

| البيئة | الوظائف الأساسية | الصوت داخل الصفحة | Web Push | ملاحظات |
|---|---|---|---|---|
| Safari على iPhone (تبويب) | مدعومة | بعد نقرة التفعيل وأثناء ظهور الصفحة | غير متاح في التبويب | يُعرض دليل الإضافة للشاشة الرئيسية |
| تطبيق الشاشة الرئيسية على iPhone/iPad (iOS 16.4+) | مدعومة | كما سبق | متاح بعد إذن من نقرة | يُختبر سلوك القفل والخلفية على الأجهزة الفعلية |
| Chrome على Android (تبويب) | مدعومة | بعد نقرة التفعيل | متاح بعد الإذن | الاهتزاز مدعوم |
| PWA مثبت على Android | مدعومة | كما سبق | متاح | — |
| Samsung Internet | أفضل جهد | يُختبر | يُختبر | ليس هدفًا أساسيًا في الإصدار الأول |
| متصفحات الحاسب (Chrome, Edge, Safari, Firefox) — آخر إصدارين | واجهة المشرف والإدارة | لوحة المشرف | اختياري | الجداول للشاشات ≥ 1024 بكسل |

الحد الأدنى للعرض: 360 بكسل دون تمرير أفقي. يُوثّق السلوك الفعلي على الأجهزة في `17_Test_Acceptance_Plan.md` (AC-08، AC-21، AC-22) قبل الإطلاق.

---

## 17. خيارات الاستضافة وقرار إقامة البيانات (Q-02)

المكونات المطلوبة من أي مزود: حاويات لعمليتين (`api` و`worker`) مع فحوص صحة ونشر تدريجي، PostgreSQL 16+ مُدار مع نسخ مشفرة ويفضل PITR، تخزين كائنات متوافق مع S3، مدير أسرار، شهادات HTTPS، موازن حمل يدعم WebSocket، وتجميع السجلات والمقاييس.

| الخيار | المزايا | التحفظات |
|---|---|---|
| مزود سحابي كبير بمنطقة داخل المملكة أو قريبة منها | زمن استجابة منخفض، خدمات مُدارة كاملة، أقرب لمتطلبات الإقامة | تحقق وقت القرار من توفر المنطقة والخدمات المُدارة (PITR، الأسرار) والتكلفة |
| مزود سحابي محلي سعودي | الإقامة المحلية | تحقق من نضج PostgreSQL المُدار والتخزين المتوافق مع S3 وأدوات المراقبة |
| منصة PaaS عامة (مثل Railway أو Render) + استضافة ثابتة (مثل Netlify) | سرعة الإطلاق التجريبي وبساطة التشغيل | المناطق خارج المملكة غالبًا؛ مناسبة للتجربة بعد قرار صريح من المالك |

قواعد القرار:

1. القرار للمالك ويُوثق في `DECISIONS.md` (Q-02) مع المنطقة والمزود والتاريخ.
2. اختيار منطقة سعودية لا يعني أن كل البيانات تبقى داخل المملكة: رسائل واتساب تمر عبر Meta، وإشعارات Push عبر خدمات المتصفحات، وقد تمر السجلات عبر مزود المراقبة. تُوثّق هذه المسارات (`04` §11) قبل أي ادعاء بإقامة كاملة للبيانات.
3. التصميم لا يعتمد على مزود بعينه: حاويات قياسية، PostgreSQL قياسي، S3 متوافق.

---

## 18. التطوير المحلي

### 18.1 الأوامر

```bash
corepack enable                     # pnpm عبر corepack
pnpm install
cp .env.example .env                # ثم املأ الأسرار المحلية
openssl rand -base64 32             # لكل من SESSION_SECRET و CODE_PEPPER و AUTH_SECRET_PEPPER و DATA_ENCRYPTION_KEY
npx web-push generate-vapid-keys    # VAPID_PUBLIC_KEY و VAPID_PRIVATE_KEY
docker compose -f infra/compose/docker-compose.yml up -d
pnpm db:migrate                     # ترحيلات packages/db
pnpm db:seed                        # بيانات تطوير اصطناعية
pnpm db:invariants                  # يشغل docs/06_schema_invariants_test.sql على قاعدة مؤقتة
pnpm dev                            # api + worker + web + wa-simulator
pnpm test                           # وحدة
pnpm test:int                       # تكامل (Testcontainers)
pnpm test:e2e                       # Playwright
pnpm lint && pnpm typecheck
pnpm db:drift                       # مقارنة الترحيلات مع docs/06_schema.sql
pnpm load:k6                        # حمل محلي مصغر
```

### 18.2 بيانات `seed` للتطوير

البذر معرّف في `17_Test_Acceptance_Plan.md` §4 (بيانات الاختبار) ويجب أن يطابقه حرفيًا (PNT-010)؛ لا يُعرّف هنا بذر آخر. ملخصه للتذكير فقط:

- المؤسسة ORG1؛ المالك OWN1 والإدارة ADM1 (MFA مفعّل)؛ المشرفون SUP-R (نطاق RMS) وSUP-RL (نطاق القاعتين) وSUP-RD (نطاق RMS، `can_drive = true`)؛ السائقون DRV1…DRV6 على RMS وDRV7 وDRV8 على LYL.
- الموقعان «قاعة ريماس» `RMS` (المنطقتان A وB بـ30 موقفًا لكل منهما، لوحة مفاتيح بـ60 خانة) و«قاعة ليلتي» `LYL` (المنطقة P1 بـ20 موقفًا، لوحة بـ40 خانة)، ولكل منهما مجموعة توزيع افتراضية.
- حفلان مفتوحان في RMS: EVT-R1 (`included`) وEVT-R2 (`per_vehicle`، `fee_halalas = 2000`، الوسيلتان `cash` و`pos`)، وحفل EVT-L1 (`included`) في LYL؛ وردية مفتوحة لكل مجموعة؛ العملاء CUS1…CUS3.
- قناة واتساب WA-CH بوضع `simulator` و`phone_number_id` واحد.

### 18.3 قائمة التشغيل الأولى

1. Node.js 24 LTS وDocker وpnpm (corepack) مثبتة.
2. `.env` مكتمل بأسرار محلية، و`WA_MODE=simulator`.
3. الحاويات تعمل و`pg_isready` ناجح، والدلاء خاصة.
4. الترحيلات وseed وفحص الثوابت ناجحة.
5. `pnpm dev` ثم فتح `http://localhost:5173` في محاكاة جوال (390 بكسل، RTL).
6. الشريحة العمودية الأولى (بوابة المرحلة «الأساس» في المعمارية §17): سائق 1 يستلم ويصف مركبة → من واجهة المحاكي اضغط «طلب السيارة» → سائق 2 يقبل ويحضر ويضغط «جاهزة» → خذ رمز التسليم من واجهة المحاكي → سائق 2 يسلّم. تحقق أن كل فعل يحمل فاعله الصحيح (`created_by`, `parked_by`, `retrieved_by`, `delivered_by`).
7. `pnpm test:int` ناجح بما فيه اختبارات السباق.

---

## 19. ما لا يُبنى في الإصدار الأول (للتذكير)

تطبيق أصلي أو نشر في المتاجر، SDK أصلي لـFCM/APNs، Redis أو طابور خارجي، خدمات مصغرة، GPS، ذكاء اصطناعي، معالجة بطاقات، صفحة ويب للعميل، أرقام واتساب لكل قاعة أو سائق، أدوات تحليل خارجية، طابور أوامر دون اتصال في الواجهة.
