# تصريحات الخصوصية في المتجرين (V2-052، DEC-567)

> الإجابات مشتقة من **ما يجمعه التطبيق والخادم فعلًا** بعد تدقيق الكود في هذه التذكرة، لا من قالب عام. أي ميزة جديدة تجمع بيانات (تحليلات، تقارير أعطال، الموقع…) تعدّل هذا الملف و`ios.privacyManifests` في `apps/customer/app.config.ts` واختبار `apps/customer/test/store.test.ts` معًا، وإلا افترق التصريح عن الواقع.

## 1. جرد البيانات (المصدر)

| البيان | من أين | أين يُحفظ | لماذا | يُربط بالحساب |
|---|---|---|---|---|
| رقم الجوال | `C-02` | `customer_accounts.phone_e164` (يُمحى عند الحذف وتبقى بصمته HMAC، DEC-508) | الدخول برمز واتساب (V2-D11)، الربط بزيارات واتساب | نعم |
| الاسم | `C-04` | `customer_accounts.display_name` (يُمحى عند الحذف) | المناداة، يراه المشغل مختصرًا عند الاستلام (V2-D12) | نعم |
| الموافقات بإصداراتها | `C-04` | `customer_account_consents` | نظام حماية البيانات الشخصية | نعم |
| السيارات: اللوحة، الشركة، الطراز، اللون، النوع | `C-05`، `C-15` | `customer_vehicles` (حذف ناعم) | الاستلام والأهلية والاشتراك | نعم |
| معرّف تثبيت عشوائي (`device_id`) والمنصة | يولّده التطبيق (`expo-crypto`، ليس معرّف عتاد) | `customer_account_sessions` | حدود المعدل لكل جهاز، الجلسات | نعم |
| رمز الإشعارات (Expo push token) | بإذن العميل فقط (`C-12`/`C-19`) | `customer_account_sessions.push_token` (يسقط عند الخروج والحذف) | إشعارات الزيارة والاشتراك | نعم |
| البطاقة | تُدخل في التطبيق وتُرمَّز **من الجهاز مباشرة** لدى Moyasar بالمفتاح العام (DEC-524) | لا يصل الرقم خوادمنا؛ يُحفظ رمز البوابة والعلامة وآخر 4 أرقام والانتهاء (`customer_payment_methods`، قيد `ck_payment_methods_no_pan`) | الدفع والتجديد بموافقة `card_on_file` | نعم |
| المدفوعات والزيارات والاشتراكات والفواتير | استعمال الخدمة | `online_payments`، `tickets`، `subscriptions`، `invoices` (تبقى نظامًا بعد الحذف) | الخدمة، الفوترة الإلكترونية (ZATCA)، التسوية | نعم |
| التقييم وملاحظته الاختيارية | `C-13` | `customer_visit_ratings` | جودة الخدمة؛ لا يراه مستخدم آخر | نعم |
| عنوان IP ووكيل المستخدم | كل طلب | `customer_audit_log` | الأمن ومنع الإساءة | نعم (لسجل التدقيق) |
| نص البحث عن موقع | `C-07` | لا يُحفظ (يخدم الطلب فقط) | البحث | — |

**ما لا يجمعه التطبيق إطلاقًا:** الموقع الجغرافي (لا يُطلب الإذن، DEC-506)، الكاميرا والصور ومكتبة الصور (صور السيارة يلتقطها السائق بتطبيق الموظفين ويراها العميل فقط)، جهات الاتصال، الميكروفون، البريد الإلكتروني، تاريخ الميلاد أو الجنس أو الهوية الوطنية، التحليلات وتتبع الاستخدام، تقارير الأعطال والأداء، الإعلانات ومعرّف الإعلان (IDFA/AAID)، التتبع عبر التطبيقات (لا `NSPrivacyTracking`، ولا طلب ATT).

**من يعالج البيانات نيابة عن بوينت (مزودو خدمة، لا «مشاركة»):** Meta (WhatsApp Cloud API: إرسال رمز التحقق إلى الرقم)، Moyasar (البطاقة والدفع)، Expo وApple APNs وGoogle FCM (توصيل الإشعارات بمحتوى عام بلا لوحة ولا رمز، DEC-23، DEC-520)، مزود الفوترة الإلكترونية (حين يُختار، V2-D13)، والاستضافة (خادم جدة، DEC-457).
**المشغّل** (شركة صف السيارات في الموقع) يرى لزيارات مواقعه فقط: الاسم المختصر، الجوال مقنّعًا، السيارة (V2-D12) — نعدّه «مشاركة» في نموذج Google احتياطًا (§3).

## 2. App Store Connect → App Privacy

**Do you or your third-party partners collect data from this app?** Yes.
**Data used to track you:** None. (لا تتبع ولا ATT.)

| فئة Apple | النوع | Linked to user | Used for tracking | الأغراض |
|---|---|---|---|---|
| Contact Info | Name | Yes | No | App Functionality |
| Contact Info | Phone Number | Yes | No | App Functionality |
| Financial Info | Payment Info | Yes | No | App Functionality |
| Purchases | Purchase History | Yes | No | App Functionality |
| Identifiers | User ID | Yes | No | App Functionality |
| Identifiers | Device ID | Yes | No | App Functionality (يشمل منع الاحتيال والأمن ضمن تعريف Apple) |
| User Content | Other User Content (ملاحظة التقييم) | Yes | No | App Functionality |
| Other Data | Other Data Types (بيانات السيارة) | Yes | No | App Functionality |

**غير مجموعة (No):** Health & Fitness، Location (Precise/Coarse)، Sensitive Info، Contacts، Emails or Text Messages، Photos or Videos، Audio Data، Gameplay Content، Customer Support (الدعم خارج التطبيق عبر واتساب/البريد)، Browsing History، Search History، Usage Data (Product Interaction، Advertising Data، Other Usage Data)، Diagnostics (Crash Data، Performance Data، Other Diagnostic Data)، Emails.

> **Payment Info:** تقول Apple إن معلومات الدفع التي تُدخل خارج تطبيقك ولا تصل إليك لا تُصرَّح. هنا تُدخل البطاقة داخل واجهة التطبيق (وتُرمَّز لدى البوابة)، ونحفظ آخر 4 أرقام والعلامة والانتهاء، فنصرّح بها احتياطًا.
> **ملف الخصوصية في البناء:** `ios.privacyManifests` يطابق هذا الجدول (`NSPrivacyCollectedDataTypes`) ويضيف واجهات «السبب المطلوب» التي تعلنها مكتبات React Native وExpo نفسها (UserDefaults `CA92.1`، FileTimestamp `C617.1`/`0A2A.1`/`3B52.1`، SystemBootTime `35F9.1`، DiskSpace `E174.1`/`85F4.1`). مكتبة `react-native-maps` تعلن في ملفها «Precise Location» لميزة «موقعي» التي لا يستعملها التطبيق (لا `showsUserLocation` ولا إذن)؛ فلا نصرّح بالموقع، وتقرير الخصوصية الذي يولّده Xcode للأرشيف قد يذكرها — راجعه عند أول رفع (RELEASE_CHECKLIST §9).

## 3. Google Play Console → App content → Data safety

| السؤال | الإجابة |
|---|---|
| Does your app collect or share any of the required user data types? | **Yes** |
| Is all of the user data collected by your app encrypted in transit? | **Yes** (HTTPS فقط؛ بناء الإصدار يرفض `http`، `configModel.ts`) |
| Which of the following methods of account creation does your app support? | **Phone number** + OTP (عبر واتساب) |
| Do you provide a way for users to request that their data is deleted? | **Yes** — داخل التطبيق (`C-20`) ورابط الويب `https://pointsa.net/delete-account` (LISTING §8) |
| Delete account URL | `https://pointsa.net/delete-account` |
| Has your app successfully completed an independent security review (MASA)? | No (اختياري) |

| فئة Google | النوع | Collected | Shared | Ephemeral | Required/Optional | الأغراض |
|---|---|---|---|---|---|---|
| Personal info | Name | Yes | **Yes** (المشغّل: الاسم المختصر) | No | Required | App functionality, Account management |
| Personal info | Phone number | Yes | No (المشغّل يراه مقنّعًا؛ Meta مزود خدمة) | No | Required | App functionality, Account management, Fraud prevention/security |
| Personal info | Other info (بيانات السيارة) | Yes | **Yes** (المشغّل عند الاستلام) | No | Optional (يمكن تخطي `C-05`) | App functionality |
| Financial info | User payment info | Yes | No (Moyasar مزود خدمة) | No | Optional (الدفع في التطبيق اختياري) | App functionality |
| Financial info | Purchase history | Yes | No | No | Required | App functionality |
| App activity | Other user-generated content (ملاحظة التقييم) | Yes | No | No | Optional | App functionality |
| Device or other IDs | Device or other IDs (معرّف التثبيت، رمز الإشعارات) | Yes | No | No | Required | App functionality, Fraud prevention/security |

**غير مجموعة:** Location، Web browsing، Messages، Photos and videos، Audio، Files and docs، Calendar، Contacts، App info and performance (Crash logs، Diagnostics)، Health and fitness، Email address، Personal identifiers أخرى، Race/ethnicity/political/religious/sexual orientation، App interactions، In-app search history، Installed apps.

> **«Shared»:** تعريف Google يستثني نقل البيانات إلى «مزود خدمة» يعالجها نيابة عنك (Meta، Moyasar، Expo/FCM، الاستضافة)، فلا تُعد مشاركة. المشغّل شركة مستقلة تقدم الخدمة في موقعها؛ صرّحنا بالاسم وبيانات السيارة «مشاركة» احتياطًا. إن رأى المستشار القانوني أن المشغّل يعمل نيابة عن بوينت تعاقديًا (عقد المشغل، 06 §3) فتصير «No».

## 4. سياسة الخصوصية (ما يجب أن تقوله لتطابق ما سبق)

النص القانوني لم يُكتب بعد (06 §3، مراجعة قانونية). ليتسق مع المتجرين يجب أن يذكر على الأقل: الجرد في §1 وأغراضه، ومزودي الخدمة والمشغّل في §1، ومكان المعالجة (المملكة، منطقة جدة؛ DEC-457)، ومدد الاحتفاظ (الفواتير نظامًا؛ صور السيارة لمدة الاحتفاظ، 01 `C-16`)، وحق الحذف وطريقته (`C-20` ورابط الويب)، وموافقة التسويق المنفصلة الاختيارية (`C-04`)، وحفظ البطاقة بموافقة صريحة، وأن الإشعارات لا تحمل بيانات شخصية على شاشة القفل، وجهة التواصل.
