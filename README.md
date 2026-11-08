# حزمة مشروع مصاف · بوينت — جاهزة للتسليم إلى Claude Code

الإصدار 1.1 — 28 أكتوبر 2026. مبنية على «مصاف — معمارية نظام الفاليت للقاعات» الإصدار 1.2.

التغيير في 1.1:
- أُضيف نظام التصميم المنشور «بوينت · POINT» من Claude Design في `docs/design/system/` مع دليل استخدامه `docs/design/README.md`.
- قراران جديدان: DEC-49 (حسم ملاحظات نظام التصميم في الملف 03 ودليل الهوية) وDEC-50 (تصحيح تباين الرموز في `brand/tokens`).
- برومبت واحد لـClaude Code يجهز المستودع ويرفعه إلى GitHub ثم يبني السبرنتات، وقسم Git وGitHub في `CLAUDE.md`، وملفا `.gitignore` و`.gitattributes`.

التغيير في 1.0.1: التذكرة الورقية `brand/print/` ونماذج `brand/brand-preview.html` صارت مطابقة للملفين 02 و14.

## الفكرة في سطرين

نظام فاليت للقاعات: الموظفون (السائق، المشرف، الإدارة) يعملون على موقع ويب واحد للجوال باسم **«بوينت · POINT»**، والعميل يتعامل فقط مع رقم واتساب مركزي باسم **«مصاف»** بزر واحد «طلب السيارة».

## محتوى الحزمة

```
MASAF-POINT_Project_Docs/
├─ README.md                      هذا الملف
├─ CLAUDE.md                      تعليمات التشغيل لـClaude Code (يقرؤها تلقائيًا)
├─ PROMPT_FOR_CLAUDE_CODE.md      البرومبت الواحد لـClaude Code (التجهيز + GitHub + البناء)
├─ .gitignore / .gitattributes    إعدادات Git
├─ docs/                          الملفات الـ16 + الإضافات
│  └─ design/                     نظام التصميم المنشور ودليل استخدامه
└─ brand/                         ملفات الهوية (بوينت + مصاف)
```

### الملفات الـ16 (الحزمة القياسية مكيّفة للمشروع)

| # | الملف | المحتوى |
|---|---|---|
| 01 | `docs/01_PRD.md` | متطلبات المنتج: الأدوار، المتطلبات الوظيفية وغير الوظيفية، معايير القبول AC-01…AC-22 |
| 02 | `docs/02_Wireframes_Spec.md` | كل الشاشات (السائق D-01…D-15، المشرف S-01…S-13) ومحادثة واتساب W-01…W-12 بالنصوص العربية |
| 03 | `docs/03_Design_System.md` | نظام التصميم: الرموز، المكونات، الصوت، RTL، الوصولية |
| 04 | `docs/04_Architecture_Flow.md` | المعمارية والتدفقات بمخططات تسلسلية |
| 05 | `docs/05_Tech_Stack_Environment.md` | التقنيات، هيكل المستودع، متغيرات البيئة، البيئات، النشر |
| 06 | `docs/06_ERD_Database_Schema.md` + `06_schema.sql` | قاعدة البيانات (47 جدولًا، مُختبرة على PostgreSQL 16) |
| 07 | `docs/07_API_Contract.md` + `07_openapi.yaml` | عقد الـAPI كاملًا (OpenAPI 3.1 مُتحقق منه) |
| 08 | `docs/08_Error_Codes_Guide.md` | رموز الأخطاء ورسائلها العربية ومعالجتها |
| 09 | `docs/09_RBAC_Permissions_Matrix.md` | الصلاحيات والأمان ونموذج التهديدات |
| 10 | `docs/10_Dispatch_Engine_Spec.md` | محرك التوزيع (بديل AI Pipeline) — SQL مُختبر بقبول متزامن |
| 11 | `docs/11_State_Machines_Domain_Events.md` | آلات الحالة والأحداث (بديل AI Output Schema) |
| 12 | `docs/12_WhatsApp_Integration_Spec.md` | تكامل واتساب (بديل Prompt Library) مع حقائق Meta المراجعة |
| 13 | `docs/13_Payments_Settlement_Spec.md` | التحصيل والتسويات (بديل Billing & Plans) |
| 14 | `docs/14_Notification_Matrix_Templates.md` | مصفوفة الإشعارات ونصوص القوالب النهائية |
| 15 | `docs/15_Event_Tracking_Plan.md` | خطة تتبّع الأحداث والمؤشرات |
| 16 | `docs/16_Dev_Tickets_Sprint_Plan.md` | 103 تذكرة تطوير في 9 سبرنتات و5 بوابات |

### الإضافات

| الملف | المحتوى |
|---|---|
| `docs/00_Glossary_Canon.md` | القاموس الموحّد: كل الأسماء الملزمة (الجداول، الحالات، الأحداث، الأخطاء، المسارات، الصلاحيات، الإعدادات، ترتيب الأقفال) |
| `docs/DECISIONS.md` | 50 قرارًا (DEC-01…DEC-50) و10 أسئلة مفتوحة لك (Q-01…Q-10) |
| `docs/design/` | نظام التصميم المنشور من Claude Design (`system/`) ودليل استخدامه في الكود (`README.md`) |
| `docs/17_Test_Acceptance_Plan.md` | خطة الاختبارات مربوطة بمعايير القبول |
| `docs/06_schema_invariants_test.sql` | اختبار تنفيذي يثبت أن قيود قاعدة البيانات تمنع الحالات الخاطئة |
| `docs/00_Source_Architecture_v1.2_AR.md` | وثيقتك الأصلية كما هي |

### الهوية `brand/`

| المجلد | المحتوى |
|---|---|
| `logo/point/` | شعار بوينت متجهي (SVG + PNG) بعدة نسخ: عمودي، أفقي، العلامة وحدها، فاتح/داكن/لون واحد، والأصل المرفق |
| `logo/masaf/` | شعار مصاف (نقطة الفاء = دبوس الموقع من علامة بوينت) |
| `whatsapp/` | صورة حساب واتساب «مصاف» 640×640 ونصوص الملف التعريفي |
| `app-icons/` + `manifest/` | أيقونات الموقع والـPWA والـfavicon وملف manifest جاهز |
| `tokens/` | الألوان والخطوط والمسافات كـCSS وJSON وTailwind |
| `fonts/` | IBM Plex Sans Arabic وIBM Plex Mono (رخصة OFL) |
| `sounds/` | ستة أصوات تنبيه أصلية (عرض، بث، تذكير، مهمة تالية، تصعيد، اختبار) |
| `print/` | تذكرة فاليت ورقية بعلامة مصاف (SVG + PDF) |
| `BRAND_GUIDELINES.md` + `brand-preview.html` | دليل الهوية وصفحة معاينة بصرية |

## طريقة التسليم لـClaude Code

1. أنشئ مجلدًا فارغًا على قرص E (مثلًا `E:\point`) وضع فيه الملف `MASAF-POINT_Project_Docs_v1.1.zip` كما هو دون فك.
2. ثبّت Git وGitHub CLI وNode.js 24 LTS وpnpm وDocker Desktop، وسجّل الدخول في GitHub CLI بالأمر `gh auth login`.
3. افتح Claude Code داخل المجلد والصق البرومبت الموجود في `PROMPT_FOR_CLAUDE_CODE.md`.
4. Claude Code يفك الحزمة ويتحقق منها، ويرفعها إلى مستودع خاص على GitHub، ثم يبني سبرنتًا بعد سبرنت حسب الملف 16 بطلب دمج لكل تذكرة، ويتوقف عند كل بوابة (G1–G5) لموافقتك.

تصاميم الشاشات اختيارية: إن صممتها لاحقًا في Claude Design فسلّمها لـClaude Code، ويحفظها في `docs/design/` بجانب نظام التصميم.

## ما يلزمك أنت قبل الإطلاق (من DECISIONS.md)

- **واتساب (معوقات إطلاق):** رقم إنتاج باسم «مصاف»، توثيق النشاط لدى Meta (الحساب الجديد يراسل 250 عميلًا فقط خلال 24 ساعة حتى التوثيق)، وسيلة دفع في Meta، وموقع أو حساب عام باسم «مصاف» لاعتماد اسم العرض.
- النطاق ومنطقة الاستضافة (Q-01، Q-02).
- نموذج التسعير لكل قاعة ومتطلبات الفوترة إن حُصّلت رسوم (Q-04، Q-05).
- مدد الاحتفاظ بالبيانات (Q-06)، والهوية الميدانية على الزي واللوحات (Q-10).

## التشغيل المحلي (للمطور)

المتطلبات: Node.js 24 LTS، pnpm (عبر `corepack enable`)، Docker. الأوامر من جذر المستودع:

```bash
corepack enable
pnpm install
cp .env.example .env          # ثم املأ الأسرار المحلية: openssl rand -base64 32 لكل من SESSION_SECRET وCODE_PEPPER وAUTH_SECRET_PEPPER وDATA_ENCRYPTION_KEY
docker compose -f infra/compose/docker-compose.yml up -d    # PostgreSQL 16 + MinIO (دلاء خاصة) + محاكي واتساب
pnpm build
pnpm db:migrate               # الترحيل الأول = docs/06_schema.sql حرفيًا
pnpm db:seed                  # بيانات 17 §4 (قاعة ريماس وقاعة ليلتي، DRV1…DRV8 …)
pnpm dev                      # api (3000) + worker + web (5173) + wa-simulator (4010)
```

الفحوص:

```bash
pnpm lint && pnpm typecheck
pnpm test                     # وحدة
pnpm test:int                 # تكامل على PostgreSQL 16 (Testcontainers، أو TEST_DATABASE_URL لخادم محلي)
pnpm db:drift                 # الترحيلات مقابل docs/06_schema.sql (ADMIN_DATABASE_URL)
pnpm db:invariants            # docs/06_schema_invariants_test.sql → ALL INVARIANT TESTS PASSED
pnpm test:e2e                 # Playwright على 360/390/430 بكسل
```

حالة البناء والتقدم: `docs/progress/STATUS.md` و`docs/progress/tickets.json`.
