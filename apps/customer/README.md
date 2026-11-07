# تطبيق العميل — `apps/customer` (V2-011)

تطبيق الجوال للعميل (V2-D10): React Native بـ**Expo SDK 58** وExpo Router وTypeScript strict، عربي أولًا (RTL) مع الإنجليزية، أرقام لاتينية وتوقيت الرياض. الرحلة R1 كاملة (`C-01…C-06`، `docs/v2/01_Customer_App.md`) تعمل اليوم على **خادم وهمي داخل التطبيق** حتى يبني V2-010 مسارات `/v1/customer/*`. القرارات: DEC-480…DEC-484.

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

نسخة الإصدار (`__DEV__ = false`) ترفض الخادم الوهمي ما لم يُطلب صراحة بـ`CUSTOMER_API_MODE=fake`، وترفض عنوان API بغير `https` (`src/configModel.ts`).

## الخادم الوهمي

`src/api/fake/backend.ts` يطبق عقود `@point/shared/customer` بقواعد الخادم: رمز 6 أرقام **على واتساب فقط** (DEC-460) يصلح 5 دقائق، إعادة الإرسال بعد 60 ث، 5 محاولات ثم قفل 15 دقيقة، رمز وصول 15 دقيقة ورمز تحديث يُدوَّر، الموافقات بالإصدار، تطبيع اللوحة، حد 5 سيارات، `Idempotency-Key`، وأغلفة الأخطاء. البيانات في الذاكرة وتضيع عند إعادة تشغيل التطبيق.

- لا تُرسل رسالة حقيقية: الرمز يذهب إلى صندوق محاكاة ويظهر في `C-03` تحت لافتة «وضع التطوير».
- الرقم `0500000099` يحصل على زيارة جارية نموذجية لرؤية بطاقتها في `C-06`.
- ستة مواقع خيالية في الرياض (`src/api/fake/seed.ts`).

## البنية

```
app.config.ts        Expo: العلامة من الإعداد، الألوان من brand/tokens، الأيقونة وشاشة البداية من brand/
metro.config.js      @point/shared من مصادره (شرط @point/source، و‎./x.js ← ./x.ts)
assets/brand/        نسخ كما هي من brand/app-icons و brand/logo/point/png
src/app/             الشاشات (Expo Router): welcome C-01، phone C-02، otp C-03، profile C-04،
                     vehicle C-05، home C-06، pass (C-11 مؤقتة حتى V2-013)
src/api/             العميل المطبوع (client.ts)، النقل (transport.ts)، الخادم الوهمي (fake/)
src/session/         الرموز في expo-secure-store، مزوّد الجلسة
src/features/        منطق الشاشات النقي (التوجيه، الجوال، الرمز، الموافقات، السيارة، الرئيسية)
src/i18n/            ar.ts (المرجع) و en.ts، التنسيق بأرقام لاتينية وتوقيت الرياض
src/theme/tokens.ts  القيم من brand/tokens/tokens.json فقط
src/ui/              المكونات (Button، Field، CodeInput، PlateInput، Checkbox، Banner، Logo …)
test/                Vitest (المشروع customer-unit)
```

## الفحوص

```bash
pnpm --filter @point/customer test        # = vitest --project customer-unit (يعمل أيضًا ضمن pnpm test)
pnpm --filter @point/customer typecheck   # ضمن pnpm typecheck
pnpm lint                                 # ESLint وPrettier وفحص العلامة يغطي التطبيق
pnpm --filter @point/customer run export  # حزمتا iOS وأندرويد (وظيفة CI customer-app)
pnpm --filter @point/customer run doctor  # expo-doctor
```

الاختبارات على الوحدات النقية (العميل مقابل الخادم الوهمي، نماذج الشاشات، القاموس، الرموز، الإعداد)، والشاشات رقيقة فوقها؛ اختبارات التصيير على الأجهزة لـV2-018.
