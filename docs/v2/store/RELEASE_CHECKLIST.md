# قائمة نشر تطبيق العميل على المتجرين (V2-052)

> كل ما يمكن أن يعيش في المستودع جاهز: `apps/customer/eas.json`، اكتمال `app.config.ts` للمتجرين، الأيقونة 1024، ملف الخصوصية، روابط التطبيق، سكربت اللقطات، ونصوص المتجر (`LISTING.md`) وتصريحات الخصوصية (`PRIVACY_LABELS.md`) وخطة اللقطات (`SCREENSHOTS.md`). ما يبقى يحتاج حسابات المالك (Apple Developer وGoogle Play Console وExpo) ويُنفَّذ على جهازه أو جلسة لاحقة عليه. لم يُنشأ أي شيء خارجي في هذه التذكرة. القرارات: DEC-565 … DEC-569.

## 0. ما في المستودع (للمراجعة قبل البدء)

| البند | الملف | القرار |
|---|---|---|
| معرّفا التطبيق `sa.point.app` (iOS وأندرويد) | `apps/customer/app.config.ts` | DEC-565 |
| ملفات EAS: `development` (محاكي/APK على الخادم الوهمي)، `preview` (توزيع داخلي على خادم التجريب)، `production` (المتجر، رقم البناء يزيد آليًا) | `apps/customer/eas.json` | DEC-566 |
| الإصدار `1.0.0` يُرفع يدويًا لكل إصدار متجر؛ أرقام البناء عند EAS (`appVersionSource: remote` و`autoIncrement`) | `app.config.ts` `CUSTOMER_APP_VERSION` | DEC-566 |
| روابط `https://pointsa.net/app…` (universal links وApp Links) وتوجيهها داخل التطبيق | `app.config.ts`، `src/app/+native-intent.ts`، `src/features/links.ts`، `scripts/well-known.mjs` | DEC-566 |
| التشفير: HTTPS ونظام التشغيل فقط → `ITSAppUsesNonExemptEncryption = false` | `app.config.ts` | DEC-566 |
| الأيقونة 1024 بلا شفافية من متجه العلامة، وملف الخصوصية `PrivacyInfo.xcprivacy`، وأذونات أندرويد المحذوفة، وعبارة الموقع | `app.config.ts`، `assets/brand/icon-1024.png`، `scripts/store-icon.mjs` | DEC-567 |
| لقطات المتجر من تصدير الويب على الخادم الوهمي | `scripts/store-screenshots.mjs` | DEC-568 |
| حساب العرض للمراجعة: لا تجاوز لرمز الدخول في الكود | §7 | DEC-569 |

## 1. ما يوفّره المالك (القائمة الكاملة)

**حسابات ومعرّفات (ليست أسرارًا):**
1. **Apple Team ID** (10 أحرف) — من Membership في حساب Apple Developer (منظمة).
2. **حساب Expo** ومنظمته (`EXPO_OWNER`)، ومشروع EAS **`EAS_PROJECT_ID`** (UUID) بعد `eas init` (§2).
3. **سجل التطبيق في App Store Connect** ومعرّفه الرقمي **`ascAppId`** (يُضاف إلى `eas.json` → `submit.production.ios.ascAppId` بعد إنشائه، أو يجيب EAS عنه تفاعليًا).
4. **تطبيق في Google Play Console** (حساب منظمة) بالحزمة `sa.point.app`.
5. **بصمة SHA-256** لمفتاح توقيع التطبيق في Play (App integrity → App signing) ولمفتاح الرفع الذي يولّده EAS (`eas credentials -p android`) — لـ`assetlinks.json`.
6. **مشروع Firebase** للتطبيق `sa.point.app` وملفه `google-services.json` (إشعارات أندرويد عبر FCM) — يُرفع ملفًا في متغيرات EAS لا في المستودع.
7. **مفتاح خدمة FCM V1** (JSON) يُرفع إلى EAS (`eas credentials -p android` → Push Notifications) ليرسل Expo عبر FCM.
8. **مفتاح APNs** (`.p8`) — يولّده EAS تلقائيًا عند أول بناء iOS بإذن الحساب، أو يُرفع.
9. **رقم/عنوان خادم الإنتاج** لـ`CUSTOMER_API_BASE_URL` (اليوم `app.pointsa.net` بيئة تجريب بالمحاكي، DEC-457)، وخادم التجريب لملف `preview`.
10. **مفتاح Moyasar العام** `pk_live_…` للإنتاج و`pk_test_…` للتجريب (DEC-524)، و**مفتاح Google Maps لأندرويد** مقيّد بالحزمة والبصمة (DEC-506).
11. **قنوات الدعم:** رقم واتساب الدعم وبريده (`CUSTOMER_SUPPORT_WHATSAPP`، `CUSTOMER_SUPPORT_EMAIL`، DEC-509).

**أصول ومحتوى:**
12. **صورة العرض في Google Play 1024×500** (إلزامية، غير موجودة في `brand/`).
13. (اختياري) **أيقونة أندرويد أحادية اللون** مربعة، و**تأكيد الأيقونة 1024** المصدّرة من المتجه أو استبدالها بتصدير المصمم.
14. **النصوص القانونية منشورة** على `pointsa.net` (§8): سياسة الخصوصية، الشروط، سياسة الاسترداد، صفحة حذف الحساب، وصفحة الدعم.
15. **استضافة ملفي `.well-known`** على `pointsa.net` (الجذر لا يخدمه هذا المستودع؛ §5).
16. **قرار حساب العرض للمراجعة** (§7).
17. مراجعة نصوص `LISTING.md` واعتماد الاسم في المتجر والفئة، والموافقة على اللقطات قبل الرفع.

## 2. الإعداد لمرة واحدة (على جهاز المالك)

```bash
npm install -g eas-cli            # أو: npx eas-cli@latest …  (يتطلب eas.json ≥ 27.5.0)
eas login
cd apps/customer
eas init                          # ينشئ المشروع ويطبع معرّفه؛ مع app.config.ts الديناميكي لا يكتبه في الملف:
export EAS_PROJECT_ID=<المعرّف>   # وفي كل أمر eas لاحق (أو في ملف .env محلي غير محفوظ في git)
export EXPO_OWNER=<المنظمة>        # إن كان المشروع لمنظمة Expo
```

**متغيرات EAS** (expo.dev → المشروع → Environment variables، أو `eas env:create`) — بالأسماء فقط هنا؛ القيم لا تُحفظ في المستودع:

| المتغير | development | preview | production | الظهور في EAS |
|---|---|---|---|---|
| `EAS_PROJECT_ID` | ✓ | ✓ | ✓ | plain (ليس سرًا) |
| `CUSTOMER_API_BASE_URL` | — (الخادم الوهمي) | خادم التجريب `https://…` | خادم الإنتاج `https://…` | plain |
| `CUSTOMER_MOYASAR_PUBLISHABLE_KEY` | — | `pk_test_…` | `pk_live_…` | sensitive |
| `CUSTOMER_MOYASAR_ALLOW_TEST_KEY` | — | `true` | — | plain |
| `CUSTOMER_MOYASAR_BASE_URL` | — | إن كان غير `https://api.moyasar.com` | — | plain |
| `CUSTOMER_SUPPORT_WHATSAPP` / `CUSTOMER_SUPPORT_EMAIL` | اختياري | ✓ | ✓ | plain |
| `CUSTOMER_ANDROID_GOOGLE_MAPS_API_KEY` | اختياري | ✓ | ✓ | secret |
| `GOOGLE_SERVICES_JSON` | — | ✓ (ملف) | ✓ (ملف) | secret file |
| `CUSTOMER_CARD_ON_FILE_VERSION` | — | يطابق الخادم | يطابق الخادم | plain |
| `BRAND_CUSTOMER_APP_NAME_AR` / `_EN`، `CUSTOMER_LINK_DOMAIN` | اختيارية (الافتراضات في الكود) | | | plain |

`eas.json` يضع `CUSTOMER_API_MODE` وحده حرفيًا (`fake` في development، `http` في preview/production)؛ وبناء الإصدار يرفض الخادم الوهمي ضمنًا ويرفض `http://` (`configModel.ts`). لا يُعطى `CUSTOMER_APPLE_PAY_MERCHANT_ID` حتى يُبنى موفّر PassKit الأصلي (Apple Pay غير معروض اليوم).

**الخادم (ليس EAS):** `CUSTOMER_PUSH_MODE=live` في الإنتاج، و`EXPO_ACCESS_TOKEN` إن فُعّل «push security» في مشروع Expo، و`CUSTOMER_TERMS_URL`/`CUSTOMER_PRIVACY_URL`/`CUSTOMER_MARKETING_URL` بعد نشر النصوص، و`CUSTOMER_PAY_CALLBACK_URL=sa.point.app://pay/return` كما هو (يطابق مخطط التطبيق).

**App Store Connect:** My Apps → «+» → New App: iOS، الاسم (`LISTING.md` §1)، اللغة الأساسية Arabic، Bundle ID `sa.point.app` (يُسجَّل المعرّف في Certificates, IDs & Profiles أولًا أو يسجله EAS عند أول بناء مع قدرات Associated Domains وPush Notifications)، SKU `point-customer-ios`. ثم انسخ **Apple ID** الرقمي للتطبيق إلى `ascAppId`.

**Google Play Console:** Create app → الاسم، اللغة الافتراضية العربية، App، Free، الإقرارات. ثم App content كاملًا (`PRIVACY_LABELS.md` §3، `LISTING.md` §7).

## 3. البناء

```bash
cd apps/customer
# تجربة محلية للإعداد قبل أي بناء (لا تحتاج حسابًا):
pnpm --filter @point/customer exec expo config --type public > /dev/null
pnpm --filter @point/customer run export

eas build -p ios --profile development        # محاكي iOS على الخادم الوهمي
eas build -p android --profile development    # APK على الخادم الوهمي
eas build -p all --profile preview            # توزيع داخلي (أجهزة مسجلة / APK) على خادم التجريب
eas build -p ios --profile production         # IPA للمتجر، رقم البناء يزيد آليًا
eas build -p android --profile production     # AAB للمتجر
```

قبل `production`: ارفع `CUSTOMER_APP_VERSION` في `app.config.ts` لكل إصدار متجر جديد (الإصدار المرفوض أو المسحوب لا يُعاد رقمه). `requireCommit: true` يمنع البناء من شجرة غير محفوظة.

## 4. الاختبار قبل النشر

**TestFlight (iOS):**
1. `eas submit -p ios --profile production --latest` (أو `eas build … --auto-submit`) — يرفع آخر بناء إنتاج إلى App Store Connect.
2. App Store Connect → TestFlight: أجب «Export Compliance» إن سُئل (المفتاح `ITSAppUsesNonExemptEncryption=false` يجيب عنه عادة).
3. **مختبرون داخليون** (أعضاء الفريق، حتى 100) بلا مراجعة؛ **خارجيون** بعد «Beta App Review» — يحتاجون معلومات الدخول نفسها (§7).
4. بوابة V2 **H2** وV6: رحلة R3 كاملة على آيفون حقيقي — الدخول، بطاقة الدخول، الاستلام بالمسح، الطلب، رمز التسليم، الإشعارات، الدفع ببطاقة اختبار، حذف الحساب.

**Google Play:**
1. **أول رفع يدويًا:** Play Console لا يقبل أول AAB عبر الـAPI قبل وجود إصدار (يُرفع ملف `.aab` من صفحة البناء في expo.dev إلى Internal testing) — غير متحقق منه حديثًا، جرّب `eas submit` أولًا.
2. بعدها: `eas submit -p android --profile production --latest` (المسار `internal` بحالة `draft` كما في `eas.json`)، بحساب خدمة Google مرفوع إلى EAS.
3. Internal testing (حتى 100) ثم **Closed testing**. **حساب شخصي** أُنشئ بعد 13 نوفمبر 2023 يحتاج 12 مختبرًا مستمرين 14 يومًا قبل طلب الإنتاج؛ **حساب المنظمة** معفى بحسب مصادر غير رسمية — تحقق في Play Console.
4. تحقق من التحقق التلقائي للروابط: `adb shell pm get-app-links sa.point.app` (الحالة `verified`).

## 5. روابط التطبيق على `pointsa.net` (DEC-566)

التطبيق يعلن `applinks:pointsa.net` ومرشّح `https://pointsa.net/app…` بـ`autoVerify`. حتى يُستضاف الملفان، تفتح الروابط في المتصفح ولا ينكسر شيء.

```bash
APPLE_TEAM_ID=<TEAM_ID> ANDROID_CERT_SHA256=<بصمة توقيع Play>,<بصمة رفع EAS> \
  node apps/customer/scripts/well-known.mjs ./well-known
# → well-known/apple-app-site-association و well-known/assetlinks.json
```

انشرهما على **`https://pointsa.net/.well-known/`** بالضبط (HTTPS، `Content-Type: application/json`، بلا تحويل). هذا المستودع يخدم `app.pointsa.net` وحده (`infra/caddy/Caddyfile`، DEC-457)؛ إن كان الجذر `pointsa.net` على بوابة Caddy المشتركة نفسها فمقطع موقعه مثلًا:

```caddyfile
pointsa.net {
	handle /.well-known/apple-app-site-association {
		root * /data/point-well-known
		header Content-Type application/json
		file_server
	}
	handle /.well-known/assetlinks.json {
		root * /data/point-well-known
		header Content-Type application/json
		file_server
	}
	# … بقية الموقع (صفحات الخصوصية والشروط والدعم وحذف الحساب)
}
```

(`/data/point-well-known` مجلد على البوابة ينسخ إليه المالك الملفين.) التحقق: `curl -sI https://pointsa.net/.well-known/apple-app-site-association` (200 وJSON)، وما يراه Apple: `https://app-site-association.cdn-apple.com/a/v1/pointsa.net` (قد يتأخر التحديث ساعات)، وGoogle: Digital Asset Links API `https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://pointsa.net&relation=delegate_permission/common.handle_all_urls`.
رسالة الترحيب في واتساب (V2-050) تستعمل `https://pointsa.net/app` رابطًا للتطبيق؛ وصفحة `https://pointsa.net/app` نفسها على الويب يجب أن تعرض روابط المتجرين لمن لا يملك التطبيق.

## 6. بيانات المتجر والرفع

1. النصوص: `LISTING.md` §1–§4 بالعربية والإنجليزية (App Store: Name، Subtitle، Promotional Text، Description، Keywords، Support/Marketing URL؛ Play: Title، Short/Full description).
2. الخصوصية: App Privacy وData safety من `PRIVACY_LABELS.md`؛ Privacy Policy URL؛ وفي Play رابط حذف الحساب.
3. تصنيف العمر: `LISTING.md` §7.
4. اللقطات: `pnpm --filter @point/customer run store:screenshots` ثم يراجعها المالك (`SCREENSHOTS.md`)؛ وصورة العرض 1024×500 لـPlay.
5. Apple: «App Review Information» → جهة اتصال، ملاحظات `LISTING.md` §6، ومعلومات الدخول (§7). «Content Rights»: لا محتوى طرف ثالث. «Pricing»: مجاني، السعودية (وغيرها حسب قرار المالك).
6. Play: Store settings → الفئة Auto & Vehicles، بريد الدعم؛ Countries: السعودية.

## 7. حساب العرض للمراجعة (DEC-569)

الدخول برمز على واتساب فقط (V2-D11، DEC-460)، والمراجع لا يملك واتساب الرقم. **لم يُضف في هذه التذكرة أي تجاوز لرمز الدخول في الكود**: بناء المتجر يتصل بخادم الإنتاج، وأي رمز ثابت هناك ثغرة دخول في الإنتاج. الخيارات للمالك:

| الخيار | كيف | المقابل |
|---|---|---|
| **أ. رقم عرض حي (الموصى به للإصدار الأول)** | رقم سعودي تملكه بوينت عليه واتساب، حساب عميل حقيقي عليه بسيارة خيالية، وموقع تجريبي باسم «موقع العرض» بمشغّل بوينت نفسه. في الملاحظات: الرقم، وأن الرمز يُرسل على واتساب، وجهة اتصال متاحة أثناء المراجعة (رقم/بريد) تعطي الرمز فورًا عند الطلب، أو جلسة موجهة | يعتمد على حضور المالك وقت المراجعة؛ Apple قد ترفض إن لم تستطع الدخول (2.1) |
| **ب. وضع عرض مدمج** | Guideline 2.1 تسمح بـ«built-in demo mode» **بموافقة Apple المسبقة** عند تعذّر حساب العرض لأسباب أمنية؛ التطبيق يملك الخادم الوهمي، لكن بناء الإصدار يرفضه ضمنًا اليوم | تذكرة منفصلة: زر عرض صريح لا يمس الخادم، وطلب موافقة Apple |
| **ج. رقم مراجعة في الخادم** | رقم واحد برمز ثابت مخزّن هاشًا، حساب معزول بلا بيانات حقيقية، منعه ممكن في أي لحظة، وتدقيق كل دخول | استثناء أمني في مصادقة الإنتاج: **قرار مالك** وتذكرة بمراجعة أمنية (V2-051)، لا يُبنى ضمنيًا |

لـ**TestFlight الداخلي و`preview`**: حساب على خادم التجريب (المحاكي يعرض الرمز في `sim.pointsa.net` خلف كلمة مرور، DEC-457) أو بناء `development` على الخادم الوهمي (الرقم `0500000099` بزيارة جارية؛ الرمز يظهر تحت لافتة «وضع التطوير»).

## 8. النصوص القانونية

| الوثيقة | الحالة | أين تُستعمل |
|---|---|---|
| سياسة الخصوصية | **غير مكتوبة** — مراجعة قانونية (06 §3)؛ ما يجب أن تقوله في `PRIVACY_LABELS.md` §4 | المتجران (إلزامي)، `C-04`، `CUSTOMER_PRIVACY_URL` |
| الشروط والأحكام | **غير مكتوبة** | `C-04`، `CUSTOMER_TERMS_URL`؛ Apple تقبل EULA الافتراضية إن لم تُعط |
| سياسة الاسترداد | **غير مكتوبة**؛ القواعد المنفذة: استرداد الدفعة المزدوجة آليًا، والنسبي عند إنهاء الاشتراك بتجميد/إغلاق (DEC-536)، واليدوي من P-06/P-08 | صفحة الدعم، `C-09` (الشروط المختصرة) |
| صفحة حذف الحساب | نص مقترح في `LISTING.md` §8 | Google Play (إلزامي) |
| موافقة التسويق | الإصدار `CUSTOMER_MARKETING_VERSION` بلا نص منشور | `C-04` (اختيارية) |

## 9. بعد أول بناء إنتاج (فحوص لا تُجرى إلا على البناء الحقيقي)

- [ ] Xcode/App Store Connect: لا تحذير «ITMS-91053 Missing API declaration» ولا «ITMS-90683 Missing purpose string»؛ وإلا أضف السبب/العبارة في `app.config.ts`.
- [ ] تقرير الخصوصية للأرشيف (Xcode → Organizer → Generate Privacy Report) يطابق `PRIVACY_LABELS.md`؛ إعلان `react-native-maps` للموقع متوقع (§2 هناك).
- [ ] البيان المدمج لأندرويد (`aapt dump permissions` أو Play Console → App bundle explorer): لا موقع ولا كاميرا ولا تخزين ولا `WRITE_SETTINGS`.
- [ ] الأيقونة على الشاشة الرئيسية بالعربية والإنجليزية، والاسم «بوينت»/«POINT»، واتجاه RTL على جهاز عربي.
- [ ] رابط `https://pointsa.net/app` يفتح التطبيق على iOS وأندرويد (بعد §5)، و3-D Secure يعود إلى التطبيق ويقرأ النتيجة من الخادم.
- [ ] الإشعارات تصل على iOS (APNs) وأندرويد (FCM) بنص عام بلا لوحة ولا رمز.

## 10. ما لم يُتحقق منه (وثائق Expo وGoogle محجوبة عن بيئة البناء)

- مخطط `eas.json` تحقق منه **مقابل `@expo/eas-json` 27.5.0 نفسه** (آخر إصدار في npm يوم 2026-11-08)، لا من docs.expo.dev؛ وأولوية `env` في الملف على متغيرات بيئة EAS بالاسم نفسه لم تُختبر — لذا لا يتكرر اسم بينهما.
- أن `eas build` يقرأ `EAS_PROJECT_ID` من متغيرات EAS عند تقييم `app.config.ts` محليًا: غير مؤكد، فصّدره في الصدفة (§2).
- مقاسات لقطات Apple: من صفحة المواصفات (developer.apple.com) بقراءة آلية؛ أي المقاسات «إلزامي» تحسمه واجهة App Store Connect.
- أكواد أسباب الواجهات (`CA92.1`…): من ملفات `PrivacyInfo.xcprivacy` في React Native 0.88.1 وحزم Expo 58 المثبتة، لا من صفحة Apple (لم تُقرأ كاملة).
- حاجة `NSLocationWhenInUseUsageDescription` مع `react-native-maps` بلا طلب إذن: احتياط؛ يُحذف إن لم يحذّر الرفع.
- إعفاء حسابات منظمات Play من شرط 12 مختبرًا/14 يومًا، وشرط أول رفع يدوي: مصادر غير رسمية.
- فئات تصنيف العمر الجديدة لدى Apple (2025) ونص أسئلتها: من الذاكرة؛ أجب كما تظهر.
- حدود الأحرف في `LISTING.md` (الكلمات المفتاحية 100 «حرف» أم «بايت» للعربية): الكلمات العربية 82 حرفًا و150 بايتًا — إن رفضتها الواجهة فاحذف أواخرها.
- Node 24.22.2 وpnpm 12.15.0 في `eas.json`: صالحان صيغةً، وتوفرهما على صور EAS لم يُختبر (EAS يثبّت المطلوب عادة).
