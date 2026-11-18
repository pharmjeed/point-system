# بيانات المتجر لتطبيق العميل «بوينت» (V2-052)

> نصوص جاهزة للصق في App Store Connect وGoogle Play Console، بالعربية (اللغة الأساسية) والإنجليزية. كل جملة هنا تصف ما في التطبيق فعلًا اليوم (`apps/customer`، `docs/v2/01_Customer_App.md`)؛ لا ميزة غير مبنية (لا تتبع جغرافي، لا حجز مسبق، ولا Apple Pay حتى يُبنى موفّره الأصلي). أي تعديل في الميزات يعدّل هذا الملف معه. القرارات: DEC-565 … DEC-569. التصريحات الخصوصية في `PRIVACY_LABELS.md`، واللقطات في `SCREENSHOTS.md`، وخطوات الرفع في `RELEASE_CHECKLIST.md`.
>
> الحدود المذكورة بين قوسين (عدد الأحرف) من وثائق المتجرين كما فهمناها وقت الكتابة؛ يتحقق منها المالك في الواجهة عند اللصق، فالواجهة ترفض ما يتجاوزها.

## 1. الهوية في المتجر

| الحقل | App Store | Google Play |
|---|---|---|
| اسم التطبيق (≤ 30) | AR: **بوينت - صف السيارات** · EN: **POINT - Valet Parking** | العنوان نفسه (≤ 30) |
| الاسم تحت الأيقونة | من `BRAND_CUSTOMER_APP_NAME_AR/_EN` (الافتراضي «بوينت» / «POINT»)، لا من المتجر | كذلك |
| العنوان الفرعي (≤ 30) | AR: **اركن بلا انتظار واطلب سيارتك** · EN: **Valet parking, on your phone** | — |
| الوصف القصير (≤ 80) | — | AR: **صف السيارات في مواقعك: سلّم سيارتك، تابعها، واطلبها قبل خروجك.** · EN: **Valet parking at your venues: hand over your car, follow it, request it.** |
| معرّف الحزمة | `sa.point.app` (DEC-565) | `sa.point.app` |
| SKU (App Store فقط، داخلي) | `point-customer-ios` | — |
| اللغة الأساسية | العربية (`ar-SA`)، ومعها الإنجليزية (`en-US`) | العربية (`ar`)، ومعها `en-US` |
| الفئة | الأساسية **Travel**، والثانوية **Lifestyle** | **Auto & Vehicles** |
| السعر | مجاني (المدفوعات خدمة فعلية خارج التطبيق، V2-D09) | مجاني، «يحتوي على مشتريات» = لا (لا مشتريات رقمية؛ انظر §6) |
| الأجهزة | iPhone فقط (`supportsTablet: false`)؛ يعمل على iPad بوضع التوافق | الهاتف؛ لا لقطات لوحية |

> **الاسم:** «POINT» وحده غالبًا محجوز في App Store، والاسم الوصفي يساعد البحث. اسم التطبيق في المتجر يُعدَّل مع كل إصدار، فلا يلزم القرار النهائي الآن؛ لكن يجب أن يكون الاسم المحجوز عند إنشاء السجل متاحًا.

## 2. النص الترويجي (App Store، ≤ 170، يُعدَّل بلا إصدار جديد)

- **AR:** اشترك شهريًا أو سنويًا في المواقع التي تزورها كثيرًا، واعرض بطاقة الدخول للسائق، واطلب سيارتك من جوالك لتجدها جاهزة عند البوابة.
- **EN:** Subscribe monthly or yearly at the venues you visit often, show your entry pass to the driver, and request your car from your phone so it is ready at the gate.

## 3. الوصف (≤ 4000)

### العربية

بوينت يجعل صف السيارات أسهل في المواقع التي تزورها: المكاتب والأبراج والمولات والمستشفيات والفنادق والقاعات.

سلّم سيارتك وامضِ إلى وجهتك
اعرض «بطاقة الدخول» للسائق عند البوابة؛ رمزها يتغير كل 30 ثانية ويعمل حتى بلا إنترنت، فتُستلم سيارتك وتُربط بحسابك فورًا.

تابع سيارتك لحظة بلحظة
في «سيارتي الآن» ترى حالة سيارتك وصور فحصها عند الاستلام، ويصلك إشعار عند الاستلام وحين تصبح جاهزة.

اطلب سيارتك قبل خروجك
اضغط «اطلب السيارة» فيبدأ السائق بإحضارها، وتجدها جاهزة عند البوابة. عند التسليم يظهر لك رمز التسليم في التطبيق لتقوله للسائق.

اشترك ووفّر
في المواقع التي تقبل الاشتراك: باقة شهرية أو سنوية لسيارة أو أكثر، بزيارات غير محدودة، وتجديد تلقائي يمكنك إيقافه في أي وقت.

ادفع بسهولة
ادفع رسوم الزيارة أو الاشتراك ببطاقة مدى أو بطاقتك الائتمانية عبر بوابة دفع مرخّصة؛ لا تُحفظ بيانات بطاقتك لدينا، ويمكنك حفظها بموافقتك للدفع والتجديد. وتجد فواتيرك الضريبية في التطبيق.

كل ما يخصك في مكان واحد
سياراتك، وزياراتك، واشتراكاتك، ووسائل دفعك، وفواتيرك. الدخول برقم جوالك ورمز تحقق يصلك على واتساب، بلا كلمة مرور. ويمكنك حذف حسابك من الإعدادات في أي وقت.

بالعربية والإنجليزية، وبتوقيت الرياض.

### English

POINT makes valet parking easier at the venues you visit: offices, towers, malls, hospitals, hotels and event halls.

Hand over your car and go
Show your entry pass to the driver at the gate. Its code changes every 30 seconds and works even offline, so your car is received and linked to your account right away.

Follow your car
"My car now" shows your car's status and the inspection photos taken at intake, and notifies you when the car is received and when it is ready.

Request your car before you leave
Tap "Request my car" and a driver brings it to the gate. At the handover the app shows your handover code to tell the driver.

Subscribe and save
At venues that offer subscriptions: a monthly or yearly plan for one car or more, unlimited visits, and automatic renewal you can stop at any time.

Pay with ease
Pay the visit or subscription fee with mada or a credit card through a licensed payment gateway. Your card details are never stored by us; you may save a card, with your consent, for payments and renewals. Your tax invoices are in the app.

Everything in one place
Your cars, visits, subscriptions, payment methods and invoices. Sign in with your mobile number and a code sent on WhatsApp, no password. You can delete your account from Settings at any time.

In Arabic and English, on Riyadh time.

## 4. الكلمات المفتاحية (App Store، ≤ 100، مفصولة بفواصل بلا مسافات، بلا تكرار كلمات الاسم)

- **AR:** `فاليه,صف,مواقف,موقف,ركن,باركنج,اشتراك,سيارة,سيارتي,مول,برج,مستشفى,فندق,قاعة,الرياض`
- **EN:** `valet,parking,park,car,garage,subscription,mall,tower,hospital,hotel,riyadh,saudi`

## 5. الروابط (عناوين مقترحة على `pointsa.net` — لا يخدمها هذا المستودع؛ ينشرها المالك قبل التقديم)

| الرابط | العنوان المقترح | الحالة |
|---|---|---|
| Marketing URL (App Store، اختياري) | `https://pointsa.net/` | ينتظر المالك |
| Support URL (App Store، إلزامي) / بريد الدعم (Play، إلزامي) | `https://pointsa.net/support` وبريد `CUSTOMER_SUPPORT_EMAIL` | ينتظر المالك (DEC-509: قنوات الدعم من الإعداد) |
| Privacy Policy URL (المتجران، إلزامي) | `https://pointsa.net/privacy` | **النص غير مكتوب** — مراجعة قانونية (06 §3)؛ ويطابقه `CUSTOMER_PRIVACY_URL` في الخادم |
| الشروط والأحكام | `https://pointsa.net/terms` | **غير مكتوب**؛ يطابقه `CUSTOMER_TERMS_URL` |
| سياسة الاسترداد | `https://pointsa.net/refund` | **غير مكتوب** (04 §1 الاسترداد النسبي، DEC-536) |
| رابط حذف الحساب على الويب (Play، إلزامي) | `https://pointsa.net/delete-account` | ينتظر المالك؛ المحتوى المقترح في §8 |
| روابط التطبيق | `https://pointsa.net/app` (ملفا `.well-known`، DEC-566) | ينتظر Team ID وبصمة شهادة أندرويد |

## 6. ملاحظات المراجعة لـApple (App Review Information → Notes) — بالإنجليزية

```text
POINT is a valet-parking service in Saudi Arabia. Drivers employed by the venue operator receive the customer's car
at the venue gate, park it, and bring it back when the customer requests it in the app.

Payments (Guideline 3.1.3(e)): every payment in the app is for a physical, real-world service consumed outside the
app — valet parking of the customer's car at a physical venue (a per-visit fee, or a monthly/yearly valet
subscription at one venue). No digital content, features or currency are sold or unlocked in the app. Payments go
through a licensed Saudi payment gateway (Moyasar: mada and credit cards, 3-D Secure); card details are entered in
the app and tokenized by the gateway directly, and never reach our servers. Customers may also pay the driver in
cash or by card terminal at the venue. In-app purchase therefore does not apply.

Sign-in: mobile number + a 6-digit code sent over WhatsApp (no password, no SMS). See the demo account below.

Account deletion (Guideline 5.1.1(v)): Settings → Delete account. A fresh WhatsApp code confirms it; deletion is
refused only while a car is currently with the valet (the car must be handed back first).

Permissions: notifications are requested only after the customer has a car with the valet (or from Settings). The
app never requests location, camera, photos, contacts or microphone. The entry pass is a QR code the customer SHOWS;
the driver's own app scans it.

Demo account: [filled in at submission — see docs/v2/store/RELEASE_CHECKLIST.md §7]
```

> **مرجع داخلي:** القاعدة V2-D09 (لا IAP) بنص Apple الحالي هي **3.1.3(e) «Goods and Services Outside of the App»**؛ وكان V2-D09 يذكر «3.1.5(a)» فصُحح (DEC-569). Google Play: نظام فوترة Play لا يدعم شراء الخدمات المادية، فتُدفع ببوابة عادية (سياسة Payments في Play، «physical services»)؛ لا يلزم إعلان خاص.

## 7. تصنيف العمر

### App Store (Age Rating questionnaire)

كل الأسئلة **None / No**: لا عنف، لا محتوى جنسي، لا مقامرة ولا مسابقات، لا مخدرات أو كحول، لا محتوى طبي، لا رعب، لا ألفاظ. **Unrestricted Web Access: No** (المتصفح الداخلي يفتح صفحة 3-D Secure للبوابة ونصوص الشروط فقط). **User-Generated Content: No** (ملاحظة التقييم تذهب لبوينت وحدها ولا يراها مستخدم آخر). **Messaging/Chat: No**. **Advertising: No**. النتيجة المتوقعة **4+**. (Apple غيّرت الاستبيان وفئاته في 2025 — راجع الأسئلة كما تظهر في الواجهة.)

### Google Play (IARC)

الفئة: **All Other App Types** (ليس لعبة). كل الأسئلة **No**: لا عنف ولا جنس ولا ألفاظ ولا مقامرة؛ **Users interact or exchange content: No**؛ **Shares user's current location with other users: No**؛ **Allows users to purchase digital goods: No**. النتيجة المتوقعة **3+ / Everyone** (PEGI 3، ESRB Everyone). ومعها في «App content»: **Ads: No**، **Target audience: 18+** (العميل صاحب سيارة يدفع)، **News app: No**، **Government app: No**، **Financial features: No** (الدفع لخدمة، لا خدمات مالية)، **Health: No**.

## 8. صفحة «حذف الحساب» على الويب (مطلوبة في Play) — نص مقترح

**AR — حذف حسابك في بوينت**
يمكنك حذف حسابك من داخل التطبيق: الإعدادات ← حذف الحساب، ثم أدخل رمز التأكيد الذي يصلك على واتساب. إن لم تستطع فتح التطبيق، راسلنا من رقم جوالك المسجل على واتساب الدعم أو على البريد `{CUSTOMER_SUPPORT_EMAIL}` بعنوان «حذف حسابي»، ونحذفه خلال 30 يومًا بعد التحقق من ملكية الرقم.
**ما يُحذف:** اسمك ورقم جوالك (يبقى منه بصمة لا تُعكس لمنع الاحتيال)، وسياراتك، وبطاقاتك المحفوظة (تُحذف رموزها لدى بوابة الدفع)، وجلساتك وإشعاراتك، وتُلغى اشتراكاتك. **ما يبقى:** الفواتير الضريبية وسجلات المدفوعات المطلوبة نظامًا (هيئة الزكاة والضريبة والجمارك) لمدة الاحتفاظ النظامية، وسجلات التدقيق بلا بياناتك الشخصية. لا يُحذف الحساب أثناء وجود سيارتك لدى الخدمة.

**EN — Delete your POINT account**
Delete it in the app: Settings → Delete account, then enter the confirmation code sent to you on WhatsApp. If you cannot open the app, message our WhatsApp support from your registered number or email `{CUSTOMER_SUPPORT_EMAIL}` with the subject "Delete my account"; we delete it within 30 days after verifying the number is yours.
**Deleted:** your name and mobile number (an irreversible fingerprint is kept to prevent fraud), your cars, saved cards (their tokens are deleted at the payment gateway), sessions and notifications; your subscriptions are cancelled. **Kept:** tax invoices and payment records required by law (ZATCA) for the legal retention period, and audit records without your personal data. An account cannot be deleted while your car is with the valet.

> المصدر: DEC-507/DEC-508 (ما يحذفه `DELETE /v1/customer/me`)، DEC-536 (إنهاء الاشتراكات). مهلة «30 يومًا» للطلب اليدوي اقتراح يقرّه المالك مع سياسة الخصوصية.
