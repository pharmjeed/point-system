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
- **Dev build** (لاختبار اسم التطبيق بالعربية والأيقونة وشاشة البداية واتجاه RTL الأصلي): `npx expo prebuild` ثم `npx expo run:ios` / `npx expo run:android` محليًا. المجلدان `ios/` و`android/` مولّدان ولا يُحفظان في المستودع. لا يوجد مشروع EAS ولا بيانات متجر في المستودع.
- **حزمة الإنتاج للتحقق:** `pnpm --filter @point/customer run export` (يصدّر حزمتي iOS وأندرويد إلى `dist/`).

## الإعداد (متغيرات بيئة يقرؤها `app.config.ts`)

| المتغير | الافتراضي | المعنى |
|---|---|---|
| `CUSTOMER_API_MODE` | `fake` إن لم يُعط عنوان | `fake` الخادم الوهمي، `http` الخادم الحقيقي |
| `CUSTOMER_API_BASE_URL` | — | أصل الـAPI (`https://…`)؛ وجوده يعني `http` |
| `BRAND_CUSTOMER_APP_NAME_AR` / `_EN` | من `CUSTOMER_APP_BRAND_DEFAULTS` | اسم العلامة للعميل (V2-D01، DEC-480) — لا يُكتب الاسم في الكود |
| `CUSTOMER_IOS_BUNDLE_ID` / `CUSTOMER_ANDROID_PACKAGE` | `sa.point.app` | معرّفا التطبيق |
| `CUSTOMER_URL_SCHEME` | معرّف الحزمة | مخطط الروابط العميقة |
| `CUSTOMER_FORCE_LOCALE` | — | `ar` أو `en` لفرض اللغة في التطوير |
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
app.config.ts        Expo: العلامة من الإعداد، الألوان من brand/tokens، الأيقونة وشاشة البداية من brand/
metro.config.js      @point/shared من مصادره (شرط @point/source، و‎./x.js ← ./x.ts)
assets/brand/        نسخ كما هي من brand/app-icons و brand/logo/point/png
src/app/             الشاشات (Expo Router): welcome C-01، phone C-02، otp C-03، profile C-04،
                     vehicle C-05، home C-06، pass C-11، locations C-07، location/[venueId] C-08،
                     visit/[ticketId] C-12 (+ C-13)، visits C-16، vehicles C-15، settings C-19،
                     delete-account C-20، subscribe/[venueId] C-09، subscriptions C-14 (V2-032)
src/api/             العميل المطبوع (client.ts)، النقل (transport.ts)، الخادم الوهمي (fake/، والزيارات fake/visits.ts)
src/realtime/        الاتصال الفوري: Socket.IO namespace /customer بترويسة Bearer، أو أحداث الخادم الوهمي (V2-015)
src/push/            الإشعارات (expo-notifications): الإذن، رمز Expo، النقر يفتح C-12 (V2-016)
src/session/         الرموز في expo-secure-store، مزوّد الجلسة
src/features/        منطق الشاشات النقي (التوجيه، الجوال، الرمز، الموافقات، السيارة، الرئيسية)
src/i18n/            ar.ts (المرجع) و en.ts، التنسيق بأرقام لاتينية وتوقيت الرياض
src/theme/tokens.ts  القيم من brand/tokens/tokens.json فقط
src/ui/              المكونات (Button، Field، CodeInput، PlateInput، Checkbox، Banner، Logo …)
test/                Vitest (المشروع customer-unit)
```

## الإشعارات (V2-016، DEC-519)

يحتاج رمز Expo معرّف مشروع EAS: `CUSTOMER_EAS_PROJECT_ID` ← `extra.eas.projectId` (لا يُحفظ في المستودع، DEC-483). بدونه تقول `C-19` «الإشعارات غير متاحة في هذه النسخة» ولا تظهر بطاقة الإذن في `C-12`. الخادم يرسل عبر Expo Push API في الإنتاج وحده (`CUSTOMER_PUSH_MODE=live`)، وفي التطوير يسجّل المحاكي ما كان سيُرسل بلا اتصال. الإذن يُطلب في `C-12` مرة حين توجد زيارة جارية، أو من `C-19`، لا عند الإقلاع.

## الفحوص

```bash
pnpm --filter @point/customer test        # = vitest --project customer-unit (يعمل أيضًا ضمن pnpm test)
pnpm --filter @point/customer typecheck   # ضمن pnpm typecheck
pnpm lint                                 # ESLint وPrettier وفحص العلامة يغطي التطبيق
pnpm --filter @point/customer run export  # حزمتا iOS وأندرويد (وظيفة CI customer-app)
pnpm --filter @point/customer run doctor  # expo-doctor
```

الاختبارات على الوحدات النقية (العميل مقابل الخادم الوهمي، نماذج الشاشات، القاموس، الرموز، الإعداد)، والشاشات رقيقة فوقها؛ اختبارات التصيير على الأجهزة لـV2-018.
