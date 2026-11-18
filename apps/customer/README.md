# تطبيق العميل — `apps/customer` (V2-011)

تطبيق الجوال للعميل (V2-D10): React Native بـ**Expo SDK 58** وExpo Router وTypeScript strict، عربي أولًا (RTL) مع الإنجليزية، أرقام لاتينية وتوقيت الرياض. الرحلة R1 كاملة (`C-01…C-06`، `docs/v2/01_Customer_App.md`)، ومعها المواقع والخريطة `C-07/C-08` وسياراتي `C-15` (V2-012) والإعدادات `C-19` وحذف الحساب `C-20` (V2-017)، تعمل على **خادم وهمي داخل التطبيق** في التطوير، وعلى الخادم الحقيقي (V2-010) بضبط `CUSTOMER_API_BASE_URL` («الخادم الحقيقي» أدناه). القرارات: DEC-480…DEC-484 وDEC-505…DEC-509.

## التشغيل

من جذر المستودع (Node ≥ 22.18، وCI على Node 24؛ `app.config.ts` يستورد ملف TypeScript مشتركًا فيحتاج نزع الأنواع في Node):

```bash
pnpm install
pnpm --filter @point/customer start        # Metro + QR لـ Expo Go أو dev build
pnpm --filter @point/customer start:fake   # الخادم الوهمي صراحةً
```

- **Expo Go:** امسح رمز QR من الطرفية بتطبيق Expo Go (آيفون أو أندرويد) بنسخة SDK 58. كل الحزم المستعملة مضمّنة في Expo Go.
- **Dev build** (لاختبار اسم التطبيق بالعربية والأيقونة وشاشة البداية واتجاه RTL الأصلي): `npx expo prebuild` ثم `npx expo run:ios` / `npx expo run:android` محليًا. المجلدان `ios/` و`android/` مولّدان ولا يُحفظان في المستودع. بناء EAS والنشر في «المتاجر» أدناه.
- **حزمة الإنتاج للتحقق:** `pnpm --filter @point/customer run export` (يصدّر حزمتي iOS وأندرويد إلى `dist/`).

## الإعداد (متغيرات بيئة يقرؤها `app.config.ts`)

| المتغير | الافتراضي | المعنى |
|---|---|---|
| `CUSTOMER_API_MODE` | `fake` إن لم يُعط عنوان | `fake` الخادم الوهمي، `http` الخادم الحقيقي |
| `CUSTOMER_API_BASE_URL` | — | أصل الـAPI (`https://…`)؛ وجوده يعني `http` |
| `BRAND_CUSTOMER_APP_NAME_AR` / `_EN` | من `CUSTOMER_APP_BRAND_DEFAULTS` | اسم العلامة للعميل (V2-D01، DEC-480) — لا يُكتب الاسم في الكود |
| `CUSTOMER_IOS_BUNDLE_ID` / `CUSTOMER_ANDROID_PACKAGE` | `sa.point.app` | معرّفا التطبيق؛ لا يتغيران بعد أول رفع للمتجر (DEC-565) |
| `CUSTOMER_URL_SCHEME` | معرّف الحزمة | مخطط الروابط العميقة |
| `CUSTOMER_FORCE_LOCALE` | — | `ar` أو `en` لفرض اللغة في التطوير |
| `EAS_PROJECT_ID` (أو `CUSTOMER_EAS_PROJECT_ID`) / `EXPO_OWNER` | — | مشروع EAS ومالكه (الإشعارات والبناء، DEC-566)؛ لا يُحفظان في المستودع |
| `GOOGLE_SERVICES_JSON` | — | مسار `google-services.json` (FCM لإشعارات أندرويد)، متغير ملف في EAS |
| `CUSTOMER_LINK_DOMAIN` | `pointsa.net` | نطاق روابط التطبيق `https://{domain}/app…` (DEC-566) |
| `CUSTOMER_WEB_EXPORT` | — | `1` يضيف هدف الويب لتصدير الويب الواحد (`export:web`): مجموعة e2e ولقطات المتجر وحدهما، ولا يُنشر (DEC-550، DEC-568) |
| `CUSTOMER_ANDROID_GOOGLE_MAPS_API_KEY` | — | مفتاح Google Maps لأندرويد (خريطة `C-07`)؛ يُعطى للبناء من البيئة ولا يُحفظ في المستودع. بلا مفتاح تختفي الخريطة على أندرويد وتبقى القائمة بروابط «فتح في الخرائط»؛ iOS يرسم Apple Maps بلا مفتاح (DEC-506) |
| `CUSTOMER_SUPPORT_WHATSAPP` / `CUSTOMER_SUPPORT_EMAIL` | — | «تواصل معنا» في `C-19`: رقم واتساب الدعم (أرقام E.164 بلا `+`) وبريده؛ بلا إعداد تظهر «قنوات الدعم تُضاف قريبًا» (DEC-509) |
| `CUSTOMER_MOYASAR_PUBLISHABLE_KEY` | — | مفتاح Moyasar **العام** (`pk_…`) لترميز البطاقة على الجهاز (`C-10`، `C-18`)؛ مفتاح سري `sk_` يُرفض، و`pk_test_` يُرفض في بناء الإصدار ما لم يُعط `CUSTOMER_MOYASAR_ALLOW_TEST_KEY=true`. بلا مفتاح لا تُعرض إضافة البطاقة (DEC-524) |
| `CUSTOMER_MOYASAR_BASE_URL` | `https://api.moyasar.com` | أصل الترميز (`tools/payment-simulator` في التطوير) |
| `CUSTOMER_APPLE_PAY_MERCHANT_ID` | — | معرّف تاجر Apple Pay للمنصة؛ يُعرض Apple Pay فقط معه ومع موفّر PassKit أصلي (`ApplePayProvider`) في بناء التطوير |
| `CUSTOMER_CARD_ON_FILE_VERSION` | `2026-11-01` | إصدار نص «حفظ البطاقة» (يطابق `CUSTOMER_CARD_ON_FILE_VERSION` في الخادم؛ الإصدار الأحدث يرده الخادم في الخطأ فيُعاد العرض) |

نسخة الإصدار (`__DEV__ = false`) ترفض الخادم الوهمي ما لم يُطلب صراحة بـ`CUSTOMER_API_MODE=fake`، وترفض عنوان API بغير `https` (`src/configModel.ts`).

## الخادم الوهمي

`src/api/fake/backend.ts` يطبق عقود `@point/shared/customer` بقواعد الخادم: رمز 6 أرقام **على واتساب فقط** (DEC-460) يصلح 5 دقائق، إعادة الإرسال بعد 60 ث، 5 محاولات ثم قفل 15 دقيقة، رمز وصول 15 دقيقة ورمز تحديث يُدوَّر، الموافقات بالإصدار، تطبيع اللوحة، حد 5 سيارات، `Idempotency-Key`، وأغلفة الأخطاء. البيانات في الذاكرة وتضيع عند إعادة تشغيل التطبيق.

- لا تُرسل رسالة حقيقية: الرمز يذهب إلى صندوق محاكاة ويظهر في `C-03` تحت لافتة «وضع التطوير».
- الرقم `0500000099` يحصل على زيارة جارية نموذجية لرؤية بطاقتها في `C-06`؛ أول سيارة له «في زيارة جارية» في `C-15` فلا تُحذف، وحذف حسابه في `C-20` يُرفض (`CUSTOMER_ACCOUNT_VISIT_ACTIVE`).
- حذف الحساب في `C-20` يطلب رمز تأكيد جديدًا يظهر تحت لافتة «وضع التطوير» كالدخول، ثم يعود التطبيق إلى `C-01`؛ والرقم نفسه يسجّل بعدها حسابًا جديدًا.
- ستة مواقع خيالية في الرياض (`src/api/fake/seed.ts`).

## الخادم الحقيقي (V2-010)

الخادم يخدم مسارات `/v1/customer/*` بالعقود نفسها (DEC-495…DEC-499)، فيتحول التطبيق إليه بالإعداد وحده دون تغيير في الكود. رمز الدخول يصل على واتساب من رقم المنصة الواحد (V2-D02)، وفي التطوير يستقبله محاكي واتساب (`tools/wa-simulator`) لا رقم حقيقي.

```bash
cp .env.example .env                                   # ثم املأ الأسرار المحلية (05 §18.1)
docker compose -f infra/compose/docker-compose.yml up -d   # postgres 16 والمحاكي
pnpm db:migrate && pnpm db:seed                        # البذرة تنشئ قناة واتساب بوضع المحاكي
pnpm dev                                               # api + worker + web + المحاكي
```

1. **قالب المصادقة:** سجّل الدخول مالكًا على تطبيق الموظفين واضغط «مزامنة القوالب» في S-13 (أو `POST /v1/admin/whatsapp/templates/sync`): تنشئ `point_customer_otp_v1` بالعربية والإنجليزية مع W-01…W-08، والمحاكي يعتمدها فورًا. بلا قالب معتمد لا يُرسل الرمز (بوابة الاعتماد، 12 §8.5).
2. **التطبيق:** `CUSTOMER_API_BASE_URL=http://<عنوان الجهاز في الشبكة>:3000 pnpm --filter @point/customer start` (نسخة التطوير تقبل `http`، ونسخة الإصدار `https` فقط). الهاتف أو المحاكي يحتاج الوصول إلى ذلك العنوان؛ `localhost` على الهاتف هو الهاتف نفسه.
3. **الرمز:** يظهر في واجهة المحاكي (`http://localhost:4010/`) أو `GET /_sim/messages?to=9665XXXXXXXX` (`bodyParams[0]`)، لا في التطبيق: لافتة «وضع التطوير» في `C-03` للخادم الوهمي فقط.
4. **فحص دخاني آلي** للتطبيق على الخادم الجاري (يُتخطى ما لم يُضبط المتغيران):

```bash
CUSTOMER_LIVE_API_URL=http://127.0.0.1:3000 WA_SIMULATOR_URL=http://127.0.0.1:4010 \
  pnpm vitest run --project customer-unit apps/customer/test/live-api.test.ts
```

يسوق R1 كاملة (`C-02…C-06`) بعميل التطبيق ونقله نفسيهما (`src/api/client.ts` و`transport.ts`)، ويقرأ الرمز من صندوق المحاكي. شُغّل مرة على خادم محلي (api + worker + المحاكي على PostgreSQL 16) ونجح؛ ويغطي `apps/api/test/customer-api.int.test.ts` الرحلة نفسها وقواعد الرمز والجلسة في CI.

## الدفع للزيارة والبطاقات المحفوظة (V2-022، V2-023)

- **منطقة الدفع في `C-12`:** مكوّن منفصل `src/features/pay/` مركّب في `src/ui/VisitPaymentSlot.tsx` حين يقول الخادم `payment.payable_in_app` (الرسوم مستحقة، أهلية `none`، لم تُسلَّم):

  ```tsx
  import { PayDue } from '../features/pay';
  <PayDue ticketId={visit.ticket_id} amountHalalas={fee} onPaid={reload} applePay={applePayProvider} />
  ```

  بطاقة «ادفع X ريال» ← ورقة الدفع (على نمط `C-10`): البطاقات المحفوظة، بطاقة جديدة تُرمَّز على الجهاز بالمفتاح العام (`tokenize.ts`، حمولة `createToken` في SDK Moyasar الرسمي، `save_only`) فلا تصل البطاقة خوادمنا، «حفظ البطاقة» بموافقة `card_on_file`، وApple Pay حين يُعطى موفّر أصلي. الخادم يحدد المبلغ. 3-D Secure يُفتح في متصفح داخلي (`expo-web-browser`) حتى `callback_url`، والنتيجة من استطلاع `GET /v1/customer/payments/{id}` (`payFlow.ts`).
- **`C-18` وسائل الدفع:** `src/app/payment-methods.tsx` من «وسائل الدفع» في `C-19`.
- **في الخادم الوهمي:** الزيارة التجريبية لرقم `+966500000099` برسوم 20 ريالًا؛ بطاقات المحاكي نفسها (`4111111111111111` ناجحة، `4000000000000002` 3-D Secure، `4201320000311101` مرفوضة، `4201320131000508` 3-D Secure ثم رفض، `4400000000000008` مدى).

## الاشتراكات (V2-032، DEC-532، DEC-534)

- **`C-08`:** أسعار الباقات المباعة في الموقع (الشهري والسنوي، «من X» حين تتعدد الباقات) وزر «اشترك» بدل «قريبًا».
- **`C-09` اختيار الباقة:** `src/app/subscribe/[venueId].tsx` — الدورة (شهري/سنوي مع «وفّر X%»)، الباقة، السيارة/السيارات المشمولة من «سياراتي» (حتى عدد الباقة)، الشروط، ثم «متابعة إلى الدفع».
- **`C-10` للاشتراك:** ورقة الدفع نفسها بخاصية `subscription` (`PaySheet`): بطاقة محفوظة أو بطاقة جديدة **تُحفظ دائمًا** للتجديد التلقائي بموافقة `card_on_file`، ولا Apple Pay (لا يُخصم مرة ثانية). النتيجة من استطلاع `GET /v1/customer/subscriptions/{id}` (`checkoutSubscription` في `payFlow.ts`).
- **`C-14` اشتراكاتي:** `src/app/subscriptions.tsx` — الحالة وسطر «يتجدد يوم…/ينتهي…/بانتظار الدفع/تعذّر التجديد/مجمّد»، والأوامر التي يسمح بها الخادم (`can_*`): إلغاء التجديد واستئنافه، «ادفع الآن»، «تغيير السيارة» مرة في كل فترة. تُقرأ عند الظهور ومع كل `subscription.updated`.
- **في الخادم الوهمي:** «برج الأعمال — العليا» بباقة سيارة واحدة (345 ريالًا شهريًا، 3450 سنويًا) و«مجمع الواحة» بباقتين؛ البطاقات نفسها أعلاه.

## البنية

```
app.config.ts        Expo: العلامة من الإعداد، الألوان من brand/tokens، الأيقونة وشاشة البداية من brand/، الخصوصية والروابط (V2-052)
eas.json             ملفات بناء EAS (V2-052)
scripts/             لقطات المتجر، الأيقونة 1024، ملفا .well-known (V2-052)
metro.config.js      @point/shared من مصادره (شرط @point/source، و‎./x.js ← ./x.ts)
assets/brand/        نسخ كما هي من brand/app-icons و brand/logo/point/png
src/app/             الشاشات (Expo Router): welcome C-01، phone C-02، otp C-03، profile C-04،
                     vehicle C-05، pass C-11، locations C-07، location/[venueId] C-08،
                     visit/[ticketId] C-12 (+ C-13)، vehicles C-15، delete-account C-20،
                     subscribe/[venueId] C-09، home C-06 (الخيار أ «زر واحد»، DEC-620)، visits C-16،
                     subscriptions C-14، settings C-19 — بلا شريط سفلي منذ DEC-626، والمسارات بلا تغيير
src/api/             العميل المطبوع (client.ts)، النقل (transport.ts)، الخادم الوهمي (fake/، والزيارات fake/visits.ts)
src/realtime/        الاتصال الفوري: Socket.IO namespace /customer بترويسة Bearer، أو أحداث الخادم الوهمي (V2-015)
src/push/            الإشعارات (expo-notifications): الإذن، رمز Expo، النقر يفتح C-12 (V2-016)
src/session/         الرموز في expo-secure-store، مزوّد الجلسة
src/features/        منطق الشاشات النقي (التوجيه، الجوال، الرمز، الموافقات، السيارة، الرئيسية)
src/i18n/            ar.ts (المرجع) و en.ts، التنسيق بأرقام لاتينية وتوقيت الرياض
src/theme/tokens.ts  القيم من brand/tokens/tokens.json فقط
src/ui/              المكونات (Button، Field، CodeInput، PlateInput، Checkbox، Banner، Logo …)
src/shims/           حشوات الويب لمجموعة e2e وحدها (DEC-551)؛ والملفات `*.web.ts(x)` بجانب أصولها
test/                Vitest (المشروع customer-unit)
e2e/                 Playwright على تصدير الويب (V2-018)، و`e2e/maestro/` تدفقات الأجهزة (H2)
```

## الإشعارات (V2-016، DEC-519)

يحتاج رمز Expo معرّف مشروع EAS: `EAS_PROJECT_ID` (أو `CUSTOMER_EAS_PROJECT_ID`) ← `extra.eas.projectId` (لا يُحفظ في المستودع، DEC-483). بدونه تقول `C-19` «الإشعارات غير متاحة في هذه النسخة» ولا تظهر بطاقة الإذن في `C-12`. الخادم يرسل عبر Expo Push API في الإنتاج وحده (`CUSTOMER_PUSH_MODE=live`)، وفي التطوير يسجّل المحاكي ما كان سيُرسل بلا اتصال. الإذن يُطلب في `C-12` مرة حين توجد زيارة جارية، أو من `C-19`، لا عند الإقلاع.

## المتاجر (V2-052)

- `eas.json`: الملفات `development` (محاكي iOS / APK على الخادم الوهمي)، `preview` (داخلي على خادم التجريب)، `production` (المتجر؛ رقم البناء يزيد عند EAS، والإصدار `CUSTOMER_APP_VERSION` في `app.config.ts` يُرفع يدويًا). القيم في متغيرات بيئة EAS بالأسماء الموثقة.
- `pnpm --filter @point/customer run store:screenshots`: لقطات المتجر بالعربية والإنجليزية بكل المقاسات إلى `store-screenshots/` (مستثنى)، من تصدير ويب على الخادم الوهمي (DEC-568).
- `pnpm --filter @point/customer run store:icon [-- --check]`: الأيقونة 1024 من متجه العلامة (DEC-567).
- `node scripts/well-known.mjs`: ملفا `apple-app-site-association` و`assetlinks.json` من `APPLE_TEAM_ID` و`ANDROID_CERT_SHA256` (DEC-566).
- كل الخطوات وما يلزم المالك: `docs/v2/store/RELEASE_CHECKLIST.md`؛ نصوص المتجر `LISTING.md`، والخصوصية `PRIVACY_LABELS.md`، واللقطات `SCREENSHOTS.md`.

## الفحوص

```bash
pnpm --filter @point/customer test        # = vitest --project customer-unit (يعمل أيضًا ضمن pnpm test)
pnpm --filter @point/customer typecheck   # ضمن pnpm typecheck
pnpm lint                                 # ESLint وPrettier وفحص العلامة يغطي التطبيق
pnpm --filter @point/customer run export  # حزمتا iOS وأندرويد (وظيفة CI customer-app)
pnpm --filter @point/customer test:e2e    # e2e: تصدير الويب + Playwright بثلاثة مقاسات (وظيفة CI customer-e2e)
pnpm --filter @point/customer run doctor  # expo-doctor
```

الاختبارات على الوحدات النقية (العميل مقابل الخادم الوهمي، نماذج الشاشات، القاموس، الرموز، الإعداد)، والشاشات رقيقة فوقها؛ والرحلات كاملة في e2e أدناه.

## e2e (V2-018، DEC-550 … DEC-554)

### على الويب، في CI وبلا أجهزة

```bash
pnpm --filter @point/customer test:e2e                  # يبني تصدير الويب (export:web) ثم Playwright
E2E_REUSE_EXPORT=1 pnpm --filter @point/customer test:e2e --project=phone-390   # بلا إعادة بناء، مقاس واحد
```

- **ما يُختبر:** الشيفرة نفسها مصدّرة للويب (`react-native-web`) على الخادم الوهمي داخل الصفحة، بمقاسات 360 و390 و430 (`ar-SA`، `Asia/Riyadh`، لمس). كل رحلة تتحقق من `<html dir="rtl" lang="ar">` والنصوص من `src/i18n/ar.ts` (لا نصوص منسوخة في الاختبارات) وألا عنصر يخرج عن عرض الشاشة.
- **الرحلات** (`e2e/*.spec.ts`): R1 الدخول برمز واتساب `C-01…C-05` وقواعد `C-02/C-03`؛ `C-07` البحث والتصفية و`C-08`؛ `C-15`؛ `C-11` الرمز المتغير واختيار السيارة؛ `C-12` الطلب والحالة الحية ورمز التسليم ثم `C-13` و`C-16`؛ الدفع للزيارة ثم `C-18` و`C-17`؛ الاشتراك `C-09/C-10/C-14` وإدارته؛ `C-18` و`C-17`؛ `C-19` اللغة والخروج؛ `C-20` الحذف.
- السائق الوهمي يتحرك بساعة المتصفح (`page.clock`)، ورمز الدخول من لافتة «وضع التطوير».
- **منصة الويب للاختبار ولقطات المتجر وحدهما:** `CUSTOMER_WEB_EXPORT=1` يضيف `web` إلى المنصات (التصدير نفسه تستعمله `store:screenshots`)؛ التطبيق المشحون iOS وأندرويد. ما لا يعمل على الويب له بديل صغير على الويب فقط (`src/shims/`، `*.web.ts(x)`، DEC-551) ولا يتغير السلوك الأصلي.

### على الأجهزة (البوابة H2): Maestro

`e2e/maestro/` يكرر الرحلات نفسها على آيفون وأندرويد ([Maestro](https://maestro.dev)، لا يعمل في CI):

```bash
npx expo run:ios   # أو run:android — نسخة تطوير على الخادم الوهمي، ولغة الجهاز العربية
maestro test e2e/maestro                     # كل التدفقات (config.yaml)
maestro test e2e/maestro/05-visit-request-code.yaml
```

يُفحص هناك ما هو أصلي فقط: الجلسة في Keychain/Keystore، اسم التطبيق العربي والأيقونة وشاشة البداية، اتجاه RTL الأصلي وتبدله بعد إعادة الفتح، الخريطة و«فتح في الخرائط»، السطوع وبطاقة الدخول بلا إنترنت، حوارات التأكيد الأصلية، إذن الإشعارات (بمشروع EAS). 3-D Secure وApple Pay على الخادم الحقيقي ومحاكي الدفع (البوابة H3). التدفقات تستخدم معرّفات `testID` (`welcome-start`، `phone-input`، `code-input`، `card-number` …) والنصوص العربية. «اطلب السيارة» **ضغطة مطولة 3 ثوانٍ** على الدائرة (`request-car-hold`، DEC-621): في Playwright ضغط الفأرة على الدائرة وانتظار 3.2 ث ثم الإفلات (`holdToRequest` في `e2e/support/app.ts`)، وفي Maestro `swipe` يبدأ وينتهي في النقطة نفسها (وسط الدائرة) مدته 3.6 ث، لأن `longPressOn` يضغط مدة ثابتة نحو 3 ث هي العتبة نفسها (DEC-628).
