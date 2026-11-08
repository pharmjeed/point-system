# دليل النشر والتشغيل — بوينت · POINT

الإصدار 1.0 — 28 أكتوبر 2026 — الحالة: مرجع تشغيلي للخادم الذي يملكه المالك (PNT-095، PNT-096).

يشرح هذا الدليل تشغيل النظام على خادم Linux واحد: تطبيق الموظفين «بوينت» (PWA) والـAPI والعامل، خلف وكيل عكسي واحد يصدر شهادات TLS تلقائيًا، مع PostgreSQL 16 وتخزين كائنات متوافق مع S3. المراجع الملزمة: `05_Tech_Stack_Environment.md` (البيئات والمتغيرات والنشر والمراقبة والنسخ الاحتياطي)، `09_RBAC_Permissions_Matrix.md` §9 (الجلسات والكوكي وCSP)، `07_API_Contract.md` §1.9 (حدود المعدل)، `12_WhatsApp_Integration_Spec.md` (القناة)، `17_Test_Acceptance_Plan.md` §10 و§13 (الأمان والاستعادة)، و`DECISIONS.md`.

القرارات المفتوحة لا تُكتب في الكود: النطاق (Q-01) قيمة `DOMAIN` و`APP_BASE_URL`، والاستضافة ومنطقتها (Q-02) اختيار للمزود وعناوين الاتصال، وأصول واتساب «مصاف» (Q-03) قيم `WA_*` وصف القناة. كل ما يلي يعمل بأي قيم يحسمها المالك.

---

## 0. الصورة العامة

```text
              الإنترنت (443/80)
                     │
          ┌──────────▼───────────┐   صورة point-web: Caddy + ملفات apps/web/dist
          │ web (Caddy)          │   TLS تلقائي لـ DOMAIN، ترويسات الأمان، CSP، التخزين المؤقت
          │  /            → PWA  │
          │  /v1 /ws /health ─────┼──► api:3000   (صورة point-backend، الأمر الافتراضي)
          │  /webhooks/whatsapp ──┼──► api:3000
          │  /point-media/* ──────┼──► minio:9000 (اختياري: تخزين على الخادم نفسه)
          │  /metrics → 404      │
          └──────────────────────┘
   api ─┬─► PostgreSQL 16 (مُدار افتراضيًا، أو docker-compose.local-db.yml)
        ├─► تخزين S3 خاص (مُدار، أو MinIO)
worker ─┼─► Graph API لواتساب (أو المحاكي في staging)، خدمات Web Push
        └─► المقاييس الداخلية :9464 (api) و :9465 (worker) — لا تُنشر للإنترنت
migrate (مهمة لمرة واحدة قبل كل تحديث) ─► PostgreSQL بدور مالك المخطط
```

| المكوّن | الصورة / الملف | ملاحظات |
|---|---|---|
| `api` | `point-backend` (`infra/docker/Dockerfile`)، الأمر `node api/dist/main.js` | HTTP وSocket.IO على `/ws` وWebhook؛ مستخدم غير مميز `node`، نظام ملفات للقراءة فقط |
| `worker` | الصورة نفسها، `node worker/dist/main.js` | Outbox والمؤقتات والإرسال والاحتفاظ والمراقبة |
| `migrate` | الصورة نفسها، `node db/dist/cli.js migrate` | ترحيلات إلحاقية فقط؛ تُشغَّل قبل كل تحديث |
| أدوات | الصورة نفسها، `node api/dist/cli.js create-owner …` | إنشاء المالك الأول (لا مسار API لإنشاء مالك، 09 §2) |
| `web` | `point-web` (`infra/docker/web.Dockerfile`) | Caddy يخدم الـPWA ويوجه الأصل الواحد (DEC-29) بإعداد `infra/caddy/Caddyfile` |
| التشغيل | `infra/compose/docker-compose.prod.yml` | مع ملفات اختيارية: `docker-compose.local-db.yml`، `docker-compose.minio.yml`، `docker-compose.simulator.yml` |
| النسخ الاحتياطي | `infra/backup/` | `backup.sh` و`restore.sh` و`restore-drill.sh` و`consistency.sql` |
| أدوار قاعدة البيانات | `infra/db/bootstrap-roles.sql` | مرة واحدة لكل بيئة قبل أول ترحيل |

---

## 1. متطلبات الخادم

- Linux 64-bit (x86_64؛ صور Node.js الرسمية متعددة المعماريات، وarm64 ممكن لكنه غير مُجرَّب هنا).
- للتجربة الأولى (حتى 5 قاعات و50 سائقًا وفق Q-08): 2 vCPU و4 GB ذاكرة و40 GB قرص على الأقل؛ يُعاد التقدير بعد اختبار الحمل PNT-097.
- Docker Engine حديث مع إضافة Compose v2 (`docker compose version`)، وBuildKit (الافتراضي).
- منافذ مفتوحة للعالم: 80 و443 (و443/UDP لـHTTP/3 اختياريًا) فقط؛ SSH مقيد بعناوين الإدارة. لا تُفتح منافذ 3000 و9464 و9465 و5432 و9000.
- اتصال صادر HTTPS إلى: Graph API لواتساب، خدمات Push للمتصفحات، PostgreSQL المُدار، تخزين S3، وسلطة الشهادات (Let's Encrypt).
- مزامنة الوقت (NTP/chrony) إلزامية: رموز TOTP والمؤقتات والجلسات تعتمد على وقت صحيح. العمليات داخل الحاويات تعمل بـ`TZ=UTC`، والعرض بتوقيت `Asia/Riyadh`.
- أدوات على الخادم أو على جهاز الإدارة: `git`، `openssl`، `psql` 16+، `age` (للنسخ الاحتياطي)، و`pg_dump`/`pg_restore` 16+ إن شُغّل النسخ من الخادم.
- مستخدم نشر غير root عضو في مجموعة `docker`، ونسخة من المستودع في `/opt/point` على إصدار موسوم (tag).

---

## 2. النطاق وDNS وTLS (Q-01)

1. اختر اسم مضيف لتطبيق الموظفين، مثل `app.<domain>` (Q-01). الـAPI على الأصل نفسه دائمًا (DEC-29): لا نطاق منفصل للـAPI ولا CORS.
2. أنشئ سجل `A` (و`AAAA` إن وُجد IPv6) يشير إلى عنوان الخادم، وانتظر انتشاره (`dig +short app.<domain>`). سجل `CAA` اختياري يسمح بـ`letsencrypt.org`.
3. في `.env`: `DOMAIN=app.<domain>`، `APP_BASE_URL=https://app.<domain>`، `API_BASE_URL=https://app.<domain>`، و`ACME_EMAIL` بريد المشغّل.
4. عند أول تشغيل يطلب Caddy الشهادة ويجددها تلقائيًا (يلزم أن يصل الإنترنت إلى المنفذين 80 و443). تُحفظ الشهادات في الحجم `caddy_data`؛ لا تحذفه.
5. ترويسة HSTS بقيمة `max-age=31536000; includeSubDomains` (05 §14.1) تخص اسم المضيف ونطاقاته الفرعية فقط (`*.app.<domain>`)، فلا تمس بقية نطاقات المالك.
6. **خلف CDN أو موازن آخر** (اختياري): يرى Caddy عنوان الـCDN، فاضبط `TRUSTED_PROXIES` (خيار `trusted_proxies` العام في `infra/caddy/Caddyfile`، مثلًا عناوين الـCDN أو `private_ranges`)، واضبط `TRUST_PROXY=2` للـapi حتى يحسب حد المعدل والتدقيق عنوان العميل الحقيقي. دون ذلك يبقى `TRUST_PROXY=1` (Caddy هو القفزة الوحيدة)، ولا يستطيع العميل تزوير `X-Forwarded-For` لأن Caddy يستبدله.

---

## 3. قاعدة البيانات PostgreSQL 16

### 3.1 الخيار الافتراضي: خدمة مُدارة

- PostgreSQL 16 أو أحدث (المخطط مُتحقق منه على 16)، في المنطقة التي يحسمها المالك (Q-02).
- فعّل النسخ الآلية المشفرة والاستعادة لنقطة زمنية (PITR) إن دعمها المزود (RPO خمس دقائق، 05 §13)، واجعل الاتصال TLS إلزاميًا، وقيّد الوصول الشبكي بعنوان الخادم.
- احتفظ بشهادة سلطة المزود (CA) في `/etc/point/db-ca.pem` إن لم تكن ضمن الشهادات العامة.

### 3.2 الأدوار وقاعدة البيانات (مرة واحدة لكل بيئة، قبل أول ترحيل)

| الدور | النوع | الاستخدام |
|---|---|---|
| `point_owner` | LOGIN + CREATEROLE | يملك قاعدة `point` وكل الكائنات ويشغّل الترحيلات (`MIGRATION_DATABASE_URL`)، ويُستخدم للنسخ الاحتياطي |
| `point_api` | LOGIN | عضو في `point_app` (`API_DATABASE_URL`) |
| `point_worker` | LOGIN | عضو في `point_app`، وفي `point_retention` **دون وراثة**: لا يملك حذف التدقيق إلا داخل `SET LOCAL ROLE point_retention` في مهمة `job.retention_purge` (`WORKER_DATABASE_URL`) |
| `point_app` | NOLOGIN | صلاحيات الترحيل 0002: `SELECT/INSERT/UPDATE` وبعض `DELETE`، ولا `UPDATE/DELETE` على `audit_log` و`ticket_events` و`custody_events` و`analytics_events` (PNT-009) |
| `point_retention` | NOLOGIN | حذف مدد الاحتفاظ (الترحيل 0004) |

أدوار التشغيل لا تملك أي كائن، فيبقى قيد الإلحاق ساريًا عليها (مالك الجدول يتجاوز `REVOKE`). ولّد كلمات مرور بلا رموز تحتاج ترميزًا في الروابط:

```bash
for n in OWNER API WORKER; do echo "POINT_${n}_DB_PASSWORD=$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 32)"; done
```

ثم شغّل السكربت بدور مدير المزود (مستخدم بصلاحيتي CREATEROLE وCREATEDB):

```bash
psql "postgres://<admin>@<db-host>:5432/postgres?sslmode=verify-full&sslrootcert=/etc/point/db-ca.pem" \
  -v owner_pw="$POINT_OWNER_DB_PASSWORD" -v api_pw="$POINT_API_DB_PASSWORD" -v worker_pw="$POINT_WORKER_DB_PASSWORD" \
  -f infra/db/bootstrap-roles.sql
```

إعادة تشغيله آمنة، وهي طريقة تدوير كلمات المرور. ثم في `.env`:

```dotenv
MIGRATION_DATABASE_URL=postgres://point_owner:<pw>@<db-host>:5432/point?sslmode=verify-full&sslrootcert=/certs/db-ca.pem
API_DATABASE_URL=postgres://point_api:<pw>@<db-host>:5432/point?sslmode=verify-full&sslrootcert=/certs/db-ca.pem
WORKER_DATABASE_URL=postgres://point_worker:<pw>@<db-host>:5432/point?sslmode=verify-full&sslrootcert=/certs/db-ca.pem
DATABASE_SSL=true
POINT_DB_CA_FILE=/etc/point/db-ca.pem     # يُركَّب للحاويات في /certs/db-ca.pem
```

إن كانت شهادة المزود موقعة من سلطة عامة فاحذف `&sslrootcert=…` من الروابط ولا تضبط `POINT_DB_CA_FILE`. لا تستخدم `sslmode=no-verify` أبدًا.

تحقق بعد أول ترحيل (§7) أن الصلاحيات كما يجب:

```sql
-- بدور point_api: كلها مرفوضة
UPDATE audit_log SET reason = 'x';   DELETE FROM audit_log;   SET ROLE point_retention;   CREATE TABLE x (i int);
-- بدور point_worker: الأول مرفوض، والثاني مسموح
DELETE FROM audit_log WHERE false;
BEGIN; SET LOCAL ROLE point_retention; DELETE FROM audit_log WHERE false; COMMIT;
```

كل ترحيل جديد ينشئ جدولًا يمنح `point_app` صلاحياته صراحة في الترحيل نفسه (لا امتيازات افتراضية، حتى لا يُكتب جدول إلحاقي جديد بالخطأ).

### 3.3 بديل: PostgreSQL على الخادم نفسه

أضف `-f infra/compose/docker-compose.local-db.yml` إلى كل أوامر compose، واضبط `POSTGRES_ADMIN_PASSWORD` و`POINT_OWNER_DB_PASSWORD` و`POINT_API_DB_PASSWORD` و`POINT_WORKER_DB_PASSWORD`، واجعل الروابط على المضيف `postgres:5432` (دون TLS داخل الشبكة الخاصة، و`DATABASE_SSL=false`). أول تشغيل على حجم فارغ ينفذ `bootstrap-roles.sql` تلقائيًا. المنفذ غير منشور. في هذا الخيار لا PITR جاهز: RPO هو آخر نسخة يومية (24 ساعة) ما لم تُفعَّل أرشفة WAL، وانسخ النسخ خارج الخادم (§12).

---

## 4. تخزين الكائنات (S3)

دلوان خاصان بالكامل: الوسائط `S3_BUCKET_MEDIA` (صور الفحص) والتصديرات `S3_BUCKET_EXPORTS`. القواعد الملزمة لكل بيئة:

- لا وصول عام إطلاقًا (09 §6)؛ الرفع والعرض بروابط موقعة تنتهي خلال 300 ثانية.
- **بلا إصدارات (versioning)** على الدلوين (DEC-128): الحذف حذف فعلي حتى لا تبقى أصول غير منقّاة أو صور حذفها الاحتفاظ.
- قاعدة دورة حياة تحذف البادئة `incoming/` في دلو الوسائط بعد يوم واحد (DEC-97).
- التشفير على مستوى المزود مفعّل.
- مفتاح وصول خاص بالتطبيق يملك فقط `GetObject` و`PutObject` و`DeleteObject` على كائنات الدلوين.

### 4.1 خدمة مُدارة متوافقة مع S3

مثال لـAWS CLI (وبالمثل لأي مزود متوافق مع `--endpoint-url`):

```bash
aws s3api put-public-access-block --bucket point-media --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-lifecycle-configuration --bucket point-media --lifecycle-configuration \
  '{"Rules":[{"ID":"incoming-1-day","Status":"Enabled","Filter":{"Prefix":"incoming/"},"Expiration":{"Days":1},"AbortIncompleteMultipartUpload":{"DaysAfterInitiation":1}}]}'
aws s3api get-bucket-versioning --bucket point-media      # يجب ألا يكون Enabled
# الرفع المباشر من المتصفح إلى أصل آخر يحتاج CORS على دلو الوسائط:
aws s3api put-bucket-cors --bucket point-media --cors-configuration \
  '{"CORSRules":[{"AllowedOrigins":["https://app.<domain>"],"AllowedMethods":["PUT","GET"],"AllowedHeaders":["content-type"],"MaxAgeSeconds":3000}]}'
```

سياسة مستخدم التطبيق:

```json
{ "Version": "2012-10-17",
  "Statement": [{ "Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
                  "Resource": ["arn:aws:s3:::point-media/*", "arn:aws:s3:::point-exports/*"] }] }
```

وفي `.env`: `S3_ENDPOINT` (فارغ لـAWS أو عنوان المزود)، `S3_REGION`، `S3_FORCE_PATH_STYLE` (false لـAWS)، المفتاحان، و`STORAGE_ORIGIN` = أصل الروابط الموقعة كما تظهر (مثل `https://point-media.s3.<region>.amazonaws.com`) لأن سياسة CSP تسمح به في `img-src` و`connect-src`. افحص رابطًا فعليًا من `POST /v1/tickets/{ticketId}/media` لمعرفة الأصل الصحيح.

### 4.2 بديل: MinIO على الخادم نفسه (الأصل نفسه)

أضف `-f infra/compose/docker-compose.minio.yml`. يخدم Caddy الدلوين على أصل التطبيق نفسه (`https://app.<domain>/point-media/…` بأسلوب المسار)، فلا CORS ولا مضيف إضافي في CSP، ويصل الـapi والعامل إلى التخزين عبر Caddy بالاسم `DOMAIN` داخل الشبكة. القيم:

```dotenv
S3_ENDPOINT=https://app.<domain>
S3_FORCE_PATH_STYLE=true
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=point-app                 # مستخدم التطبيق الذي تنشئه minio-init
S3_SECRET_ACCESS_KEY=<openssl rand -hex 24>
MINIO_ROOT_USER=<اسم>                      # حساب الإدارة، لا يستخدمه التطبيق
MINIO_ROOT_PASSWORD=<openssl rand -hex 24>
STORAGE_ORIGIN=
```

خدمة `minio-init` (عند كل تشغيل، متساوية القوة) تنشئ الدلوين خاصين، وترفض دلوًا فيه إصدارات، وتضبط قاعدة `incoming/`، وتنشئ مستخدم التطبيق بسياسة الدلوين فقط. لوحة MinIO وواجهة إدارته غير منشورتين. ملاحظتان: (1) MinIO لم يعد ينشر صورًا (اختفت `minio/minio` و`minio/mc` من Docker Hub)، فتُبنى الصورة `point-minio` (الخادم و`mc` معًا) من مصادر Go المنشورة بإصدارات مثبتة في `infra/docker/minio.Dockerfile` بصورتي Go وAlpine الرسميتين فقط (DEC-458)؛ و`MINIO_IMAGE` يسمح بصورة متوافقة أخرى فيها `mc`، أو فضّل خدمة مُدارة؛ (2) قرص واحد بلا تكرار: انسخ الحجم `minio_data` يوميًا خارج الخادم (`mc mirror` إلى دلو آخر) لأن الصور دليل حالة المركبات.

---

## 5. الأسرار

لا يوضع أي سر في المستودع ولا في حزمة الواجهة (`pnpm lint` يشغّل `scripts/check-secrets.mjs`، و`VITE_*` قيم عامة فقط). على الخادم الواحد مخزن الأسرار هو ملف `.env` (أو `POINT_ENV_FILE`) بصلاحية `600` لمستخدم النشر، وتُقرأ أسرار واتساب منه بالمراجع `env://…`؛ مرجع `sm://` يحتاج موصلًا لمدير أسرار لم يُبنَ بعد.

| السر | التوليد | التدوير وأثره (05 §10) |
|---|---|---|
| `SESSION_SECRET` | `openssl rand -base64 32` | يخرج الجميع؛ خارج أوقات الحفلات |
| `CODE_PEPPER` | `openssl rand -base64 32` | يبطل رموز التسليم الحية؛ بين الحفلات فقط |
| `AUTH_SECRET_PEPPER` | `openssl rand -base64 32` | يبطل كل الأرقام السرية وكلمات المرور (DEC-58)؛ لا يُدوَّر إلا مع إعادة تعيين شاملة |
| `DATA_ENCRYPTION_KEY` + `DATA_ENCRYPTION_KEY_ID` | `openssl rand -base64 32` (32 بايت بالضبط) ومعرّف مثل `k1` | مفتاح جديد بمعرّف جديد؛ القديم يبقى للقراءة حتى إعادة التشفير |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | `npx web-push generate-vapid-keys` | يبطل كل اشتراكات Push؛ المفتاح العام يُمرر للواجهة `VITE_VAPID_PUBLIC_KEY` |
| `WA_ACCESS_TOKEN`، `WA_APP_SECRET`، `WA_VERIFY_TOKEN` | من Meta (§8)؛ رمز التحقق `openssl rand -hex 24` | الوصول: تحديث القيمة دون إعادة نشر الكود؛ سر التطبيق: `WA_APP_SECRET_PREVIOUS_REF` 24 ساعة (12 §3.3) |
| كلمات مرور قاعدة البيانات | §3.2 | `bootstrap-roles.sql` مجددًا ثم إعادة تشغيل الخدمات |
| مفاتيح S3 / MinIO | المزود أو §4.2 | تدوير دوري |
| مفتاح النسخ الاحتياطي | `age-keygen -o point-backup.key` على جهاز غير متصل | المفتاح العام وحده على الخادم (`BACKUP_AGE_RECIPIENTS`)؛ الخاص يُحفظ خارج الخادم في مكانين |

كل الأسرار الأساسية الأربعة (`SESSION_SECRET` و`CODE_PEPPER` و`AUTH_SECRET_PEPPER` و`DATA_ENCRYPTION_KEY`) إلزامية في كل بيئة، والعملية ترفض الإقلاع دونها برسالة تسمّي الناقص. كل بيئة لها أسرارها المستقلة (05 §9).

---

## 6. ملف البيئة — كل المتغيرات

ابدأ من `.env.example`. ما يقرؤه الـapi والعامل (`packages/server/src/core/config/env.ts`) — والقيم التشغيلية (المؤقتات والحدود والاحتفاظ) ليست هنا بل في إعدادات المؤسسة والموقع (Canon §12):

| المتغير | الافتراضي | المعنى |
|---|---|---|
| `NODE_ENV` | `development` | `production` على الخادم (الصورة تضبطه) |
| `APP_ENV` | `local` | `staging` أو `production`؛ يحدد قواعد الإقلاع أدناه |
| `TZ` | `UTC` | لا يُغيَّر (الإقلاع يرفض غيره) |
| `DISPLAY_TIMEZONE` | `Asia/Riyadh` | توقيت العرض |
| `LOG_LEVEL` | `info` | `debug` محليًا فقط |
| `APP_VERSION` | `dev` | الوسم أو `git` sha؛ يظهر في السجلات والتحليلات |
| `APP_BASE_URL` | — (إلزامي) | `https://<DOMAIN>`؛ يُطابَق معه `Origin` (CSRF) |
| `API_BASE_URL` | — | الأصل نفسه (DEC-29)؛ الإقلاع يرفض أصلًا مختلفًا في staging/production |
| `API_PORT` | `3000` | داخل الحاوية؛ Caddy يوجه إليه |
| `BRAND_STAFF_NAME_AR` / `_EN` / `BRAND_CUSTOMER_NAME_AR` / `_EN` | — (إلزامية) | أسماء العلامتين (Canon §1) |
| `DATABASE_URL` | — (إلزامي) | يضبطه compose من `MIGRATION_/API_/WORKER_DATABASE_URL` لكل خدمة |
| `DATABASE_POOL_MAX` | `20` | اتصالات لكل عملية |
| `DATABASE_STATEMENT_TIMEOUT_MS` / `DATABASE_LOCK_TIMEOUT_MS` | `5000` / `3000` | مهل المعاملات (05 §7.4) |
| `DATABASE_CONNECT_TIMEOUT_MS` | `5000` | أقصى انتظار لمقعد في المجمّع أو اتصال جديد؛ وقراءة الرد محدودة بمهلة الجملة + 2 ثانية؛ بعدهما `SERVICE_UNAVAILABLE` (05 §7.4، 17 §12) |
| `DATABASE_SSL` | `false` | `true` مع قاعدة مُدارة (يتحقق من الشهادة) |
| `SESSION_SECRET`، `CODE_PEPPER`، `AUTH_SECRET_PEPPER` | — (إلزامية) | 32 بايت على الأقل base64 (§5) |
| `DATA_ENCRYPTION_KEY` / `DATA_ENCRYPTION_KEY_ID` | — / `k1` | AES-256-GCM لأسرار TOTP ونسخة رمز التسليم |
| `SESSION_COOKIE_NAME` / `SESSION_COOKIE_SECURE` | `__Host-point_sid` / `true` | إلزاميان بهذه القيم في staging/production (09 §9.3)، و`point_sid` + `false` محليًا على http فقط |
| `WA_MODE` | `simulator` | `live` إلزامي في production؛ `simulator` في staging قبل Q-03 |
| `WA_GRAPH_BASE_URL` | `http://localhost:4010` | `https://graph.facebook.com` حيًا، أو `http://wa-simulator:4010` |
| `WA_API_VERSION` | — | يُثبَّت عند الإطلاق بعد مراجعة جدول Meta (12 §3.5) |
| `WA_BUSINESS_ACCOUNT_ID` / `WA_PHONE_NUMBER_ID` / `WA_DISPLAY_PHONE_E164` | — | معرّفات الرقم الواحد «مصاف» |
| `WA_ACCESS_TOKEN_REF` / `WA_APP_SECRET_REF` / `WA_VERIFY_TOKEN_REF` | `env://WA_ACCESS_TOKEN` … | مراجع الأسرار (لا قيم) |
| `WA_APP_SECRET_PREVIOUS_REF` | — | أثناء تدوير سر التطبيق فقط (24 ساعة) |
| `WA_ACCESS_TOKEN` / `WA_APP_SECRET` / `WA_VERIFY_TOKEN` | — | قيم الأسرار التي تشير إليها المراجع |
| `WA_HTTP_TIMEOUT_MS` | `10000` | مهلة Graph API |
| `WA_TEST_RECIPIENT_ALLOWLIST` | — | إلزامي في staging الحي: أرقام الفريق فقط |
| `MOYASAR_MODE` | `simulator` | الإصدار الثاني (V2-020، DEC-510): `live` إلزامي في production ومرفوض في غيرها ولا يرسل إلا مفتاح `sk_live_`؛ `test` (واجهة Moyasar الاختبارية الحقيقية) في local وstaging فقط ولا يرسل إلا مفتاح `sk_test_` (للبوابة H3)؛ `simulator` (`tools/payment-simulator`) لا يرسل مفتاحًا حيًا أبدًا — فلا خصم حقيقي خارج الإنتاج |
| `MOYASAR_BASE_URL` | `http://localhost:4020` | `https://api.moyasar.com` في وضعي `live` و`test` (https إلزامي)؛ في وضع `simulator` يُرفض أي مضيف `moyasar.com` |
| `MOYASAR_SECRET_KEY_REF` / `MOYASAR_WEBHOOK_SECRET_REF` | `env://MOYASAR_SECRET_KEY` / `env://MOYASAR_WEBHOOK_SECRET` | مراجع الأسرار (لا قيم)، `sm://` في الإنتاج كأسرار واتساب |
| `MOYASAR_WEBHOOK_SECRET_PREVIOUS_REF` | — | أثناء تدوير سر الـWebhook فقط (يُقبل السران) ثم يُحذف |
| `MOYASAR_SECRET_KEY` / `MOYASAR_WEBHOOK_SECRET` | — | المفتاح السري (`sk_live_…` في الإنتاج وحده؛ المحوّل يرفض إرسال مفتاح حي خارج الإنتاج) وسر الـWebhook المشترك الذي يُضبط في لوحة Moyasar |
| `MOYASAR_HTTP_TIMEOUT_MS` | `10000` | مهلة كل استدعاء للبوابة |
| `CUSTOMER_PUSH_MODE` | `simulator` | الإصدار الثاني (V2-016، DEC-519): `live` (Expo Push API) إلزامي في production ومرفوض في غيرها؛ `simulator` لا يتصل بالشبكة — فلا جهاز حقيقي يتلقى إشعارًا خارج الإنتاج |
| `CUSTOMER_PUSH_ACCESS_TOKEN_REF` / `EXPO_ACCESS_TOKEN` | `env://EXPO_ACCESS_TOKEN` / — | رمز وصول مشروع Expo إن فُعّل «push security» فيه (اختياري، بالمرجع، `sm://` في الإنتاج) |
| `CUSTOMER_PUSH_HTTP_TIMEOUT_MS` / `CUSTOMER_PUSH_RECEIPT_DELAY_S` | `10000` / `900` | مهلة استدعاء Expo، ومتى تُقرأ إيصالات التسليم |
| `PAYMENTS_RECONCILE_CRON_UTC` | `30 0 * * *` | المطابقة اليومية مع البوابة (03:30 بتوقيت الرياض) لليوم السابق (DEC-514) |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | — / — / `mailto:ops@example.com` | Web Push؛ اجعل `VAPID_SUBJECT` بريد المشغّل |
| `S3_ENDPOINT`، `S3_REGION`، `S3_BUCKET_MEDIA`، `S3_BUCKET_EXPORTS`، `S3_ACCESS_KEY_ID`، `S3_SECRET_ACCESS_KEY`، `S3_FORCE_PATH_STYLE` | — / `us-east-1` / `point-media` / `point-exports` / — / — / `true` | §4؛ في staging/production يُستخدم S3 دائمًا (DEC-108) |
| `MEDIA_UPLOAD_URL_TTL_S` / `MEDIA_READ_URL_TTL_S` / `MEDIA_MAX_BYTES` / `EXPORT_URL_TTL_S` | `300` / `300` / `10485760` / `300` | مدد الروابط الموقعة وحد الصورة |
| `RATE_LIMIT_ENABLED` | مفعّل (إلا `NODE_ENV=test`) | §11.3 |
| `RATE_LIMIT_AUTH_PER_MIN` | `10` | لكل عنوان IP: الدخول والتحقق الثنائي |
| `RATE_LIMIT_COMMANDS_PER_MIN` / `RATE_LIMIT_ACCEPT_PER_10S` | `60` / `20` | لكل مستخدم؛ والثاني لقبول العروض فوق الأول |
| `RATE_LIMIT_WRITES_PER_MIN` / `RATE_LIMIT_READS_PER_MIN` | `30` / `300` | لكل مستخدم |
| `RATE_LIMIT_DEVICE_PER_MIN` / `RATE_LIMIT_EXPORTS_PER_HOUR` | `60` / `5` | لكل جهاز (جلسة) / لكل مستخدم |
| `RATE_LIMIT_WEBHOOK_PER_MIN` | `6000` | صمام لكل عنوان مصدر على Webhook |
| `TRUST_PROXY` | `1` | عدد القفزات أمام الـapi (§2 بند 6) |
| `WORKER_ID` | اسم الحاوية | — |
| `WORKER_CONCURRENCY` / `WORKER_BATCH_SIZE` / `WORKER_POLL_INTERVAL_MS` / `WORKER_LEASE_SECONDS` | `8` / `20` / `500` / `30` | العامل |
| `RETENTION_PURGE_CRON_UTC` | `0 2 * * *` | الاحتفاظ اليومي (05:00 بتوقيت الرياض) |
| `MONITOR_INTERVAL_S` | `10` | مراقب النظام (`outbox_lag`، `task_stuck`)؛ `0` يوقفه |
| `WS_PATH` / `WS_TRANSPORTS` | `/ws` / `websocket` | لا تضف `polling` إلا مع جلسات لاصقة |
| `REALTIME_NOTIFY_CHANNEL` / `OUTBOX_NOTIFY_CHANNEL` | `point_realtime` / `point_outbox` | قنوات `LISTEN/NOTIFY` |
| `OTEL_SERVICE_NAME` / `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_TRACES_SAMPLER_ARG` | يضبطه compose / — / `0.2` | التتبع غير موصول بعد (ملاحظات PNT-094) |
| `METRICS_ENABLED` / `METRICS_PORT` | `true` / `9464` | المقاييس على `METRICS_PORT` (api) و`METRICS_PORT + 1` (worker)، شبكة داخلية فقط (DEC-61)؛ فحص صحة حاوية العامل يقرأ منفذه، فأبقِ `METRICS_ENABLED=true` |

قواعد يرفض بها الإقلاع (`loadEnvOrExit`): الأسرار الناقصة أو القصيرة؛ `TZ` غير UTC؛ `WA_MODE` غير `live` في production أو `live` خارج staging/production؛ في staging وproduction: الكوكي يجب أن يكون `__Host-` مع `Secure`، و`APP_BASE_URL` بـhttps، و`API_BASE_URL` على الأصل نفسه؛ `WA_GRAPH_BASE_URL` بـhttps حين `live`؛ staging الحي دون `WA_TEST_RECIPIENT_ALLOWLIST`؛ `CHAOS_KILL_AT` في production؛ وكوكي `__Host-` دون `Secure` في أي بيئة؛ والإصدار الثاني: `MOYASAR_MODE` غير `live` في production أو `live` خارجها، و`test` خارج local وstaging، و`MOYASAR_BASE_URL` بغير https حين `live` أو `test`، ومضيف `moyasar.com` في وضع `simulator` (DEC-510)؛ و`CUSTOMER_PUSH_MODE` غير `live` في production أو `live` خارجها (DEC-519).

متغيرات compose (للاستبدال في ملفات compose، من الملف نفسه عبر `--env-file`):

| المتغير | المعنى |
|---|---|
| `DOMAIN`، `ACME_EMAIL` | اسم المضيف وبريد سلطة الشهادات (إلزاميان) |
| `MIGRATION_DATABASE_URL`، `API_DATABASE_URL`، `WORKER_DATABASE_URL` | §3.2 (إلزامية) |
| `POINT_DB_CA_FILE` | مسار CA القاعدة على الخادم (اختياري) |
| `POINT_ENV_FILE` | ملف البيئة للحاويات (الافتراضي `.env` في جذر المستودع) |
| `POINT_BACKEND_IMAGE`، `POINT_WEB_IMAGE` | وسم الصورتين (`point-backend:<tag>`)؛ التراجع بتغييرهما |
| `STORAGE_UPSTREAM`، `STORAGE_ORIGIN` | §4 |
| `VITE_API_BASE_URL`، `VITE_WS_PATH`، `VITE_VAPID_PUBLIC_KEY`، `VITE_BRAND_STAFF_NAME_AR` / `_EN`، `VITE_BRAND_CUSTOMER_NAME_AR` | قيم عامة تُبنى في الواجهة (05 §8) |
| `MINIO_*`، `POSTGRES_ADMIN_PASSWORD`، `POINT_*_DB_PASSWORD`، `MINIO_IMAGE`، `MINIO_MC_IMAGE`، `POSTGRES_IMAGE` | للملفات الاختيارية فقط |

---

## 7. البناء والتشغيل الأول

```bash
cd /opt/point && git fetch --tags && git checkout <tag>
cp .env.example .env && chmod 600 .env          # ثم املأ القيم (§3–§6) لبيئة الخادم
alias pc='docker compose --env-file .env -f infra/compose/docker-compose.prod.yml'   # + -f للملفات الاختيارية
pc build                                          # الصورتان point-backend و point-web
pc run --rm migrate                               # «applied N migration(s)» ثم «database is up to date» في المرات التالية
pc up -d                                          # api و worker ثم web بعد سلامة api
pc ps                                             # كل الخدمات healthy
curl -fsS https://app.<domain>/health/ready       # {"status":"ok","checks":{"db":true,"outbox_lag_s":null}} (degraded: the outbox lags)
```

- **لا بذر في الإنتاج:** بيانات التطوير (`pnpm db:seed`) ترفض العمل في staging وproduction (`SeedRefusedError`، رمز الخروج 3، DEC-56)، ولا تُشغَّل على أي قاعدة حقيقية.
- `db:invariants` و`db:drift` أدوات CI تنشئ قواعد مؤقتة؛ لا تُشغَّل على خادم الإنتاج.
- خلف وكيل يفحص TLS عند البناء: `docker build --secret id=build_ca,src=<ca.pem> …` (لا تدخل الشهادة في أي طبقة).

### 7.1 المالك الأول

لا مسار API لإنشاء مالك (09 §2، §10)؛ أداة التهيئة داخل صورة الخلفية:

```bash
pc run --rm api node api/dist/cli.js create-owner \
  --phone 05XXXXXXXX --name "اسم المالك" --org-name-ar "اسم المؤسسة" --org-name-en "Org name"
```

- تنشئ المؤسسة (إن لم توجد)، والمالك برمز `O-0001` ونطاق `org` نشط، وصف تدقيق `owner.bootstrap`، وتطبع **كلمة مرور مؤقتة مرة واحدة** (لا تُحفظ في أي مكان آخر). التجزئة argon2id بمعاملات الخادم نفسها ومع `AUTH_SECRET_PEPPER`.
- أول دخول من `https://app.<domain>/staff/login` جلسة مقيدة: تغيير كلمة المرور أولًا (12 حرفًا فأكثر)، ثم إعداد TOTP بمسح رمز QR، ثم الجلسة الكاملة. MFA إلزامي للمالك والإدارة دائمًا.
- ترفض الأداة إنشاء مالك ثانٍ (رمز الخروج 3): استعادة المالك إجراء طوارئ مدقق خارج النظام (09 §9.1). إن وُجدت أكثر من مؤسسة فمرر `--org-id`.
- بعدها يضبط المالك إعدادات المؤسسة، وينشئ الإدارة والمشرفين والسائقين والمواقع من التطبيق.

### 7.2 مالك المنصة الأول (الإصدار الثاني، V2-002)

```bash
pc run --rm api node api/dist/cli.js create-platform-owner --phone 05XXXXXXXX --name "اسم مالك المنصة"
```

- تنشئ حساب `platform_owner` في `platform_users` (لا في `users`: ليس عضوًا في أي مؤسسة مشغّل) وصف `platform.owner_bootstrap` في `platform_audit_log`، وتطبع **كلمة مرور مؤقتة مرة واحدة**.
- أول دخول من `https://app.<domain>/platform/login` جلسة مقيدة: تغيير كلمة المرور ثم إعداد TOTP، ثم كل دخول بعدها بكلمة المرور ورمز التحقق. كوكي اللوحة `__Host-point_psid` منفصل عن كوكي الموظفين.
- ترفض الأداة مالك منصة ثانيًا (رمز الخروج 3)؛ بقية حسابات المنصة تُضاف من اللوحة (DEC-465).

---

## 8. واتساب: المحاكي ثم التشغيل الحي (Q-03)

**قبل اكتمال أصول Meta (staging):** لا يراسل النظام أحدًا.

```dotenv
APP_ENV=staging
WA_MODE=simulator
WA_GRAPH_BASE_URL=http://wa-simulator:4010
WA_PHONE_NUMBER_ID=100000000000001
WA_APP_SECRET=<openssl rand -hex 24>   WA_VERIFY_TOKEN=<openssl rand -hex 24>   WA_ACCESS_TOKEN=<openssl rand -hex 24>
```

وأضف `-f infra/compose/docker-compose.simulator.yml`. ينشئ المالك صف القناة بوضع `simulator` من S-13 «قناة واتساب» (نموذج الإنشاء تحت «لم تُضبط القناة بعد.») أو `PUT /v1/admin/whatsapp/channel` بالمراجع `env://WA_*`. الإنتاج يرفض الإقلاع على المحاكي، والمحاكي يرفض العمل في الإنتاج.

**الإطلاق الحي:** متطلبات 12 §3.7 (L-01…L-07) وPNT-100: توثيق النشاط لدى Meta، وسيلة الدفع، اعتماد اسم العرض «مصاف»، تسجيل الرقم الواحد، اعتماد القوالب W-01…W-08، رمز التحقق بخطوتين للرقم. ثم:

1. `APP_ENV=production`، `WA_MODE=live`، `WA_GRAPH_BASE_URL=https://graph.facebook.com`، `WA_API_VERSION` المثبت، المعرّفات، و`WA_ACCESS_TOKEN` (رمز مستخدم نظام) و`WA_APP_SECRET` و`WA_VERIFY_TOKEN`. أزل ملف المحاكي.
2. اشتراك Webhook في تطبيق Meta على `https://app.<domain>/webhooks/whatsapp` بالحقل `messages` (والحقول الاختيارية في 12 §3.6) ورمز التحقق نفسه؛ التحقق يمر عبر `GET` ويُقارن بزمن ثابت.
3. صف القناة بوضع `live` (S-13 «قناة واتساب» أو `PUT /v1/admin/whatsapp/channel`)، ثم مزامنة القوالب (`POST /v1/admin/whatsapp/templates/sync`)، ثم إرسال تجريبي لأرقام داخلية.
4. تدوير سر التطبيق: ضع الجديد في `WA_APP_SECRET` والقديم في متغير آخر يشير إليه `WA_APP_SECRET_PREVIOUS_REF` لمدة 24 ساعة ثم احذفه.

### 8.1 بوابة الدفع (الإصدار الثاني، V2-020 / V2-021)

**التطوير والاختبار وstaging:** `MOYASAR_MODE=simulator` و`MOYASAR_BASE_URL` على `tools/payment-simulator` (`pnpm dev` يشغّله على 4020 بمفتاحه `sk_test_point_simulator_secret` وسره `point-simulator-webhook-secret`)؛ المحاكي يرفض العمل في الإنتاج ويرفض أي مفتاح حي، والمحوّل يرفض إرسال `sk_live_…` خارج الإنتاج، والإقلاع يرفض `live` خارج الإنتاج — فلا خصم حقيقي ممكن خارجه (DEC-510).

**تجربة البوابة الحقيقية قبل الإطلاق (H3، staging):** `MOYASAR_MODE=test` و`MOYASAR_BASE_URL=https://api.moyasar.com` بمفتاح الاختبار `sk_test_…` من لوحة Moyasar (المحوّل يرفض أي مفتاح غيره في هذا الوضع)، وWebhook اختباري في اللوحة على `https://<staging>/webhooks/payments/moyasar` بسره المشترك. بطاقات Moyasar الاختبارية لا تنقل مالًا.

**الإنتاج:** `MOYASAR_MODE=live`، `MOYASAR_BASE_URL=https://api.moyasar.com`، المفتاح السري `sk_live_…` (من مدير الأسرار) في `MOYASAR_SECRET_KEY`، وفي لوحة Moyasar: Webhook على `https://app.<domain>/webhooks/payments/moyasar` (POST) لأحداث الدفع، بسر مشترك عشوائي (`openssl rand -hex 32`) هو `MOYASAR_WEBHOOK_SECRET`. التدوير: السر الجديد في اللوحة وفي `MOYASAR_WEBHOOK_SECRET`، والقديم في متغير يشير إليه `MOYASAR_WEBHOOK_SECRET_PREVIOUS_REF` حتى تنقضي إعادة المحاولات، ثم يُحذف. المطابقة اليومية تفتح تنبيهات `platform_alerts` لكل فرق (P-08).

---

## 9. الترقية

ترتيب 05 §11.2، ويفضّل خارج ذروة الحفلات:

```bash
git fetch --tags && git checkout <new-tag>
pc build                          # أو سحب الصورتين الموسومتين من السجل
pc run --rm migrate               # مرة واحدة قبل تحديث أي عملية
pc up -d --no-deps worker         # العامل أولًا
pc up -d --no-deps api            # ثم الـapi (انقطاع ثوانٍ؛ /ws يعيد الاتصال ثم GET /v1/me/home)
pc up -d --no-deps web            # ثم الواجهة؛ يظهر «تحديث متاح» ولا يُفرض أثناء مهمة
```

- الترحيلات إلحاقية: الأداة ترفض ترحيلًا طُبّق ثم عُدّل (فحص البصمة)، وكل تغيير بنمط «توسيع ثم تقليص» فتعمل النسخة السابقة على المخطط الأحدث، ولا يُحذف قيد أو فهرس جزئي من ثوابت `06_schema.sql`.
- الجلسات في القاعدة، فلا تسقط مع إعادة التشغيل.
- أعد بناء الصورتين شهريًا على الأقل لتصل تحديثات أمان Node.js وAlpine وCaddy، وراجع `pnpm audit:prod`.

## 10. التراجع

- **الصورة:** أعد `POINT_BACKEND_IMAGE` و`POINT_WEB_IMAGE` إلى الوسم السابق ثم `pc up -d`. لا يلزم التراجع عن الترحيلات لأنها متوافقة مع النسخة السابقة.
- **لا تراجع للترحيلات أبدًا:** أي تصحيح ترحيل جديد إلى الأمام.
- **البيانات:** الاستعادة من نسخة احتياطية آخر الحلول لأنها تفقد ما بعد نقطة الاستعادة (§12)، ويُشغَّل أثناءها الإجراء الورقي.

---

## 11. السجلات والمراقبة والأمان التشغيلي

### 11.1 السجلات

- `pc logs -f api worker web`. سطور pino بصيغة JSON مع `request_id` (يطابق ترويسة `X-Request-Id` وغلاف الخطأ)، ومنقّحة: لا كوكيز ولا جوالات كاملة ولا رموز ولا أسرار (05 §7.6).
- سجل الوصول في Caddy على stdout بلا كوكيز ولا `Authorization`، ويحذف من الاستعلام `hub.verify_token` وتوقيعات الروابط الموقعة (`X-Amz-Signature`، `X-Amz-Credential`).
- الدوران: سائق `json-file` بحد 10 MB × 5 لكل خدمة. للتجميع المركزي (30–90 يومًا، 05 §12.1) وجّه سجلات Docker إلى منصة السجلات المختارة.

### 11.2 الصحة والمقاييس والتنبيهات

- `/health/live` و`/health/ready` (بلا بيانات) عبر Caddy وفي فحوص سلامة الحاويات. لإبقائها داخلية أضف ملفًا في `infra/caddy/conf.d/` (المثال في `00-site.caddy`).
- `/metrics` لا يمر عبر Caddy أبدًا (يرد 404). المقاييس على `api:9464` و`worker:9465` داخل شبكة compose؛ اجمعها بـPrometheus على الشبكة نفسها أو انشرها على `127.0.0.1` فقط بملف override. الكتالوج في 05 §12.2، وأهم ما يُراقَب: `point_outbox_oldest_pending_seconds`، `point_wa_webhook_last_received_timestamp_seconds`، `point_wa_channel_health`، `point_dispatch_time_to_claim_seconds`، `point_db_pool_in_use`، و`point_backup_last_success_timestamp_seconds` (§12).
- التنبيهات داخل التطبيق (`outbox_lag`، `wa_webhook_silent`، `wa_channel_down`…) يرفعها مراقب النظام في العامل والـapi، وتُرى في لوحة المشرف والإدارة. فشل النسخ الاحتياطي تنبيه حرج خارج التطبيق (§12.2).
- تنبيهات المشغّل خارج التطبيق (توجيه «مراقبة» في 15 §12، وعتبات 12 §13، وتأخر المؤقتات 10 §12.2، وفشل النسخ 05 §12.3) قواعد Prometheus في `infra/monitoring/prometheus-rules.yml`: حمّلها بـ`rule_files:` بجانب إعداد الجمع، وتحقق منها بـ`promtool check rules infra/monitoring/prometheus-rules.yml` قبل كل تحميل، ووجّه `severity=critical` إلى المالك والإدارة. يكتب سكربت النسخ `point_backup_last_success_timestamp_seconds` في ملف node_exporter النصي (DEC-303). ولا قاعدة لـ«اختبار الاستعادة» (آخر اختبار موثق أقدم من 90 يومًا): تاريخه في سجل دليل الاستعادة ويُراجع يدويًا.

### 11.3 الترويسات وحدود المعدل والكوكي

- الواجهة (Caddy): `Content-Security-Policy` بـ`script-src 'self'` و`style-src 'self'` و`img-src 'self' blob: data:` + أصل التخزين، و`connect-src 'self'` + `wss://DOMAIN` + أصل التخزين، و`frame-ancestors 'none'`، و`object-src 'none'`؛ و`Strict-Transport-Security`، و`Referrer-Policy: no-referrer`، و`Permissions-Policy: geolocation=(), microphone=(), camera=(self), payment=()`، و`X-Frame-Options: DENY`، و`X-Content-Type-Options: nosniff`. التخزين المؤقت: `/assets/*` سنة `immutable`، والصفحة و`sw.js` و`manifest.webmanifest` `no-cache`، والأيقونات والأصوات يومًا؛ ملفات الخرائط (`.map`) غير منشورة، والأصل المفقود 404 لا الصفحة.
- الـAPI (helmet): CSP لا تسمح بشيء (`default-src 'none'`)، HSTS، `nosniff`، `no-referrer`، `Cross-Origin-Resource-Policy: same-site`، `X-Frame-Options: DENY`، و`Cache-Control: no-store` لكل `/v1`.
- الكوكي: `__Host-point_sid; HttpOnly; Secure; SameSite=Lax; Path=/` دون `Domain` (09 §9.3)، والإقلاع يرفض غير ذلك في staging/production.
- حدود المعدل (07 §1.9): الفئة من `x-rate-limit-class` لكل مسار؛ قبل الدخول لكل عنوان IP، وبعده لكل مستخدم أو جهاز؛ التجاوز `429 RATE_LIMITED` مع `Retry-After` و`details.retry_after_s`، وترويسات `RateLimit-Limit/Remaining/Reset`. **العدّاد في ذاكرة كل عملية api:** مع نسختين يصبح الحد الفعلي ضعفه؛ الحماية المشتركة بين النسخ في القاعدة (قفل الحساب بعد 5 محاولات، مفاتيح التكرار، حدود الأعمال). إن كان كثير من السائقين خلف عنوان واحد (شبكة القاعة أو NAT المشغّل) وبدؤوا الدخول معًا فارفع `RATE_LIMIT_AUTH_PER_MIN`.
- الاعتماديات: `pnpm audit:prod` (بلا ثغرات عالية أو حرجة؛ في CI)، وفحص الأسرار ضمن `pnpm lint`.

---

## 12. النسخ الاحتياطي والاستعادة (PNT-095)

### 12.1 الأهداف (05 §13)

| البند | القيمة |
|---|---|
| RPO | 5 دقائق مع PITR لدى المزود؛ وإلا 24 ساعة (النسخة اليومية) |
| RTO | ساعة واحدة للخدمة الكاملة؛ وأثناءها الإجراء الورقي (04 §8.13) |
| الاحتفاظ | 30 يومًا، وأول نسخة من كل شهر لمدة 12 شهرًا (تُراجع مع Q-06) |
| التمرين | قبل الإطلاق (AC-12) ثم كل ربع سنة وبعد أي تغيير في الاستضافة؛ السجل في `docs/test-evidence/restore/<date>.md` |
| التخزين | الدلوان بلا إصدارات (DEC-128)؛ المتانة من المزود (أو `mc mirror` لـMinIO) |

### 12.2 النسخة اليومية المشفرة

`infra/backup/backup.sh`: `pg_dump --format=custom` يمر مباشرة عبر `age` (أو `openssl` احتياطًا) فلا يُكتب تفريغ غير مشفر على القرص، ويكتب بجواره بصمة `.sha256` (تكشف التلف العارض فقط، فأي أحد يعيد حسابها) وبيانًا `.json`، وفي وضع `openssl` توقيع `.hmac` (HMAC-SHA256 للملف المشفر بمفتاح مشتق من عبارة المرور) لأن AES-CBC غير موثَّق: الاستعادة ترفض ملف `.dump.enc` بلا توقيع صحيح قبل فك تشفيره (DEC-515؛ `age` موثَّق بذاته ويبقى المفضل) فيه الترحيلات وعدد صفوف الجداول الرئيسية مأخوذة **من اللقطة نفسها** التي نُسخت، فتتحقق أي استعادة لاحقًا صفًا بصف.

1. على جهاز غير متصل: `age-keygen -o point-backup.key`؛ احفظ الملف الخاص في مكانين آمنين خارج الخادم، وانسخ المفتاح العام (`age1…`) فقط إلى الخادم.
2. ملف `/etc/point/backup.env` (صلاحية 600، يملكه المستخدم الذي يشغّل النسخ، هنا `deploy`). يُقرأ بـ`sh` (`. /etc/point/backup.env`)، فضع القيمة التي فيها `&` أو مسافات بين علامتي تنصيص مفردتين:

   ```sh
   BACKUP_DATABASE_URL='postgres://point_owner:<pw>@<db-host>:5432/point?sslmode=verify-full&sslrootcert=/etc/point/db-ca.pem'
   BACKUP_AGE_RECIPIENTS=age1...
   BACKUP_DIR=/var/backups/point
   BACKUP_RETENTION_DAYS=30
   BACKUP_MONTHLY_KEEP=12
   # نسخة خارج الخادم (aws CLI)؛ ومعها BACKUP_S3_ENDPOINT لمزود متوافق مع S3
   BACKUP_S3_URI=s3://<backup-bucket>/point
   BACKUP_METRICS_FILE=/var/lib/node_exporter/textfile/point_backup.prom
   ```

   مع شهادة مزود عامة استخدم `sslrootcert=system`. دلو النسخ الاحتياطية **منفصل** عن دلوي التطبيق، ويُستحسن فيه قفل الكائنات أو الإصدارات وقاعدة احتفاظ (لا ينطبق عليه DEC-128)، وصلاحية مفتاح الرفع كتابة فقط.
3. التشغيل يوميًا بعد انتهاء الحفلات، مثلًا 00:30 UTC (03:30 بتوقيت الرياض)، من الخادم (يلزمه `postgresql-client` 16+ و`age` و`bash`)، في `/etc/cron.d/point-backup` (أو مؤقت systemd مع `OnFailure=`):

   ```cron
   30 0 * * * deploy set -a; . /etc/point/backup.env; set +a; /opt/point/infra/backup/backup.sh >>/var/log/point-backup.log 2>&1 || echo "point backup FAILED" | mail -s "POINT backup failed" ops@<domain>
   ```

   أو داخل حاوية مؤقتة على شبكة compose (لقاعدة `local-db`، والمضيف في الرابط عندها `postgres`). الملف نفسه يُقرأ داخل الحاوية بـ`sh` (لا `--env-file`، فـDocker يُبقي علامات التنصيص والتعليقات جزءًا من القيمة)، ومجلد المقياس مركّب ليصل إليه node_exporter:

   ```bash
   docker run --rm --network point_point -v /etc/point/backup.env:/etc/point/backup.env:ro \
     -v /opt/point/infra/backup:/backup:ro -v /var/backups/point:/var/backups/point \
     -v /var/lib/node_exporter/textfile:/var/lib/node_exporter/textfile postgres:16-alpine \
     sh -c 'apk add --no-cache bash age >/dev/null && set -a && . /etc/point/backup.env && set +a && bash /backup/backup.sh'
   ```

   يجب أن يكون الإصدار الرئيسي لـ`pg_dump` مساويًا للخادم أو أحدث (السكربت يتحقق). رمز خروج غير صفري = فشل يُنبَّه عليه، والمقياس `point_backup_last_success_timestamp_seconds` يُراقَب بحد 26 ساعة.
4. الاحتفاظ المحلي يحذف ما تجاوز 30 يومًا إلا أول نسخة من كل شهر لآخر 12 شهرًا؛ وللنسخة خارج الخادم قاعدة دورة حياة في دلوها بالمدد نفسها.

**PITR لدى المزود:** فعّله وحدد مدة الاستبقاء (7 أيام على الأقل). الاستعادة لنقطة زمنية تنشئ مثيلًا جديدًا من لوحة المزود، ثم تُتحقق منه وتُحوَّل الروابط إليه (§12.3 من الخطوة 6). النسخة المنطقية المشفرة تبقى مطلوبة بجانبه لأنها مستقلة عن المزود وتُحفظ خارجه.

### 12.3 دليل الاستعادة

1. أعلن الحادث وفعّل الإجراء الورقي؛ سجّل وقت الانقطاع.
2. أوقف الكتابة: `pc stop api worker`.
3. أنشئ قاعدة جديدة فارغة يملكها `point_owner` (على خادم جديد شغّل `bootstrap-roles.sql` أولًا):

   ```sql
   CREATE DATABASE point_restore_20261028 OWNER point_owner;
   ```

4. انقل ملف المفتاح الخاص مؤقتًا إلى الخادم (`chmod 600`)، ثم:

   ```bash
   BACKUP_AGE_IDENTITY_FILE=/root/point-backup.key infra/backup/restore.sh \
     /var/backups/point/point-20261028T003000Z.dump.age \
     "postgres://point_owner:<pw>@<db-host>:5432/point_restore_20261028?sslmode=verify-full&sslrootcert=/etc/point/db-ca.pem"
   ```

   السكربت: يتحقق من البصمة، يفك التشفير في مجرى، يستعيد في معاملة واحدة (كل شيء أو لا شيء) دون ملكية وبصلاحيات `point_app`/`point_retention`، ثم يقارن الترحيلات وعدد الصفوف بالبيان ويشغّل `consistency.sql`؛ ويطبع الزمن. أي اختلاف = رمز خروج 1. يرفض قاعدة غير فارغة.
5. احذف نسخة المفتاح من الخادم (`shred -u`).
6. حوّل التطبيق: إما تغيير `/point_restore_20261028` في الروابط الثلاثة، أو إعادة التسمية:

   ```sql
   ALTER DATABASE point RENAME TO point_broken_20261028;
   ALTER DATABASE point_restore_20261028 RENAME TO point;
   GRANT CONNECT ON DATABASE point TO point_api, point_worker;
   ```

7. `pc run --rm migrate` (يجب أن يقول «database is up to date» أو يطبق ما بعد النسخة)، ثم `pc up -d api web` والعامل موقوف (DEC-406): الـWebhooks تُحفظ ولا تُعالج، ولا يُرسل شيء، ولا مؤقتات، والموقع يبقى على الورق؛ وتنبيه `outbox_lag` الحرج الذي يرفعه مراقب الـAPI حينها متوقع.
8. طابق القيود الورقية مع `POST /v1/tickets/{ticketId}/manual-reconcile` (S-03 «مطابقة يدوية بعد انقطاع»)، وسجّل نقطة الاستعادة والزمن الفعلي والفروقات ومن نفّذ في `docs/test-evidence/restore/<date>.md` (17 §13).
9. `pc up -d worker` بعد انتهاء المطابقة، ثم أنهِ الإجراء الورقي. إن طالت المطابقة أكثر من 15 دقيقة، أو كان الانقطاع في إنترنت القاعة وحدها، شغّل العامل قبلها وطابق أولًا الطلبات المعلقة لمركبات سُلّمت ورقيًا قبل أن يقبلها سائق (الضغطات المحفوظة تُعالج من الـWebhooks المعادة بقواعد التخطي، 12 §14).

### 12.4 التمرين

- آلي على جهاز تطوير أو خادم PostgreSQL 16 مؤقت (لا خادم إنتاج): `pnpm ops:restore-drill` (أو `ADMIN_DATABASE_URL=… bash infra/backup/restore-drill.sh`). ينشئ قاعدة مصدر (ترحيلات + بذر التطوير + حفل مصغر)، ينسخها مشفرة، يكتب بعدها، يستعيد في قاعدة جديدة ويتحقق من العدد عند نقطة النسخة، يقارن المخطط بالترحيلات، يشغّل `06_schema_invariants_test.sql` على نسخة بنية، ويتأكد أن نسخة معدلة تُرفض، ويقيس الزمن مقابل RTO. `DRILL_EVIDENCE=<file.md>` يكتب السجل، و`DRILL_ENCRYPTION=openssl` يجرب البديل.
- ربع سنويًا: الخطوات §12.3 على نسخة إنتاج حقيقية في **بيئة معزولة** (لا تُنسخ بيانات الإنتاج إلى staging، 05 §9)، ثم مطابقة عينة من التذاكر، ثم حذف البيئة.

---

## 13. قائمة ما يلزم المالك قبل الإطلاق

| # | البند | المرجع |
|---|---|---|
| 1 | النطاق وسجلات DNS (Q-01) و`DOMAIN`/`APP_BASE_URL` | §2 |
| 2 | الاستضافة ومنطقتها (Q-02): خادم، PostgreSQL 16 مُدار مع PITR وTLS، تخزين S3 ودلو نسخ احتياطي منفصل | §1، §3، §4 |
| 3 | توليد كل الأسرار وحفظ نسخة منها خارج الخادم؛ مفتاح `age` الخاص في مكانين | §5 |
| 4 | أصول Meta «مصاف» (Q-03، PNT-100) قبل `APP_ENV=production` | §8 |
| 5 | إنشاء المالك الأول وإكمال MFA | §7.1 |
| 6 | النسخ الاحتياطي اليومي مع التنبيه، وتمرين استعادة مسجل (AC-12، TC-037) | §12 |
| 7 | المراقبة: جمع السجلات والمقاييس وتنبيه فشل النسخ وعمر Outbox | §11 |
| 8 | اعتماد مدد الاحتفاظ (Q-06) من `PUT /v1/admin/retention-policy` | Canon §12 |
| 9 | جدار الحماية (80/443 فقط)، SSH بالمفاتيح، تحديثات النظام وDocker | §1 |
| 10 | بروفة حفل كامل على staging (PNT-102) ثم بوابة G5 | 16 |
| 11 | خادم مشترك: التثبيت بأمر واحد خلف البوابة (DEC-457) | §14 |

---

## 14. التثبيت بأمر واحد وخادم مشترك مع مشاريع أخرى (DEC-457)

`infra/deploy/install.sh` ينفذ §3.3 و§4.2 و§5–§7.1 و§8 (staging بالمحاكي) دفعة واحدة على خادم فيه Docker، وإعادة تشغيله هي التحديث (تحفظ `.env` وأسراره):

```bash
sudo mkdir -p /opt/point && sudo chown "$USER" /opt/point
git clone https://github.com/pharmjeed/point-system.git /opt/point && cd /opt/point
bash infra/deploy/install.sh          # يسأل: اسم المضيف، البريد، جوال المالك واسمه
```

- **الأسرار** كلها يولدها السكربت بـ`openssl` على الخادم نفسه في `.env` (صلاحية `600`)، ومعها مفاتيح VAPID (P-256). لا يطبع إلا كلمة مرور المالك المؤقتة (مرة واحدة) وكلمة مرور صفحة المحاكي.
- **الوضع يُختار تلقائيًا:**
  - **`gateway`:** على الخادم حاوية Caddy مشتركة (`POINT_GATEWAY_CONTAINER`، الافتراضي `vm-caddy-1`) تملك 80/443 وتستورد `/data/conf.d/*.caddyfile`. يعمل Caddy بوينت بـHTTP فقط على عنوان جسر Docker للبوابة (`POINT_HTTP_BIND`، المنفذ الافتراضي 8095)، ويكتب السكربت `point.caddyfile` في مجلد البوابة، ثم `caddy validate` (رفضٌ = استعادة الملف السابق ولا إعادة تحميل)، ثم `caddy reload` الذري: المواقع الأخرى لا تنقطع، والبوابة تصدر شهادة `DOMAIN`.
  - **`direct`:** المنفذان 80/443 حران، فيملكهما Caddy بوينت ويصدر الشهادة بنفسه (§2).
  - غير ذلك (منفذا 80/443 لبرنامج غير معروف): يتوقف السكربت ولا يأخذ منفذ مشروع آخر.
- **صفحة المحاكي** (staging، وضع البوابة): `sim.<النطاق>` خلف `basic_auth` بالمستخدم `sim`؛ هي «جوال العميل» للتجربة، ولا تراسل أحدًا. `SIM_DOMAIN=none` يلغيها.
- **ملفات compose** المختارة تُحفظ في `POINT_COMPOSE_FILES` داخل `.env`، والتشغيل اليومي بـ`bash infra/deploy/pc.sh <أمر compose>` (مثل `ps` و`logs -f api worker` و`restart api`).
- **قناة واتساب:** بعد أول دخول للمالك (تغيير كلمة المرور ثم MFA) ينشئ صف القناة من «قناة واتساب» بوضع «محاكي» والمعرّفات التي يطبعها السكربت والمراجع `env://WA_*`. الانتقال للرقم الحي §8.
- **سجلات DNS:** `A` لـ`app` (و`sim` إن استُخدمت) إلى عنوان الخادم العام؛ السكربت ينبه إن لم تُضبط بعد، والشهادة تُصدر تلقائيًا حين تنتشر.

**خادم المالك الحالي (DEC-457):** Oracle Ampere A1 (arm64) في جدة، تعمل عليه مشاريع أخرى خلف البوابة `vm-caddy-1`. بوينت هناك بالوضع `gateway` على `app.pointsa.net` و`sim.pointsa.net`، بمشروع compose مستقل اسمه `point` (حاوياته وأحجامه وشبكته منفصلة، فلا يلمس المشاريع الأخرى). يختبر سير `.github/workflows/deploy-smoke.yml` الوضعين على Docker حقيقي (ومعهما إعادة التشغيل كتحديث)، وبناء صورة الخلفية لـ`linux/arm64` وتحميل وحداتها الأصلية (argon2 وsharp).

