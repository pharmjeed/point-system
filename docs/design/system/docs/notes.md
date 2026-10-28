# ملاحظات التعارض

قاعدة الحسم: `tokens.css` أولًا، ثم `03_Design_System.md`، ثم `BRAND_GUIDELINES.md`. كل قيمة هنا بقيت كما في المصدر؛ ما يلي توثيق للتعارضات والفجوات وكيف عولجت.

## بين الملفات

1. **رقم التذكرة الكبير.** 03 §2.3 والمعاينة يضعانه بنمط `display` (IBM Plex Sans 700)، وتوجيه المشروع يخص IBM Plex Mono بأرقام التذاكر. اتُّبع التوجيه: `pt-ticket-display` (Mono 600، 40/48)، وبقي نمط `pt-display` (Sans 700) متاحًا إن قُرر الرجوع.
2. **نقطة StatusChip.** 03 §3.3 يصف الشارة بنقطة 8px، و03 §1.3 مع قاعدة المشروع يشترطان نص + لون + أيقونة. استُبدلت النقطة بأيقونة Lucide 16px لكل حالة (الخريطة في `Point.TICKET_STATUS` و`Point.DRIVER_STATE`). أيقونات الحالات اختيار النظام لأن المصادر لا تحددها.
3. **ظلال الوضع الداكن.** 03 §2.5 يقول تُستبدل الظلال بحدود في الداكن، و`tokens.css` يعرّف ظلالًا داكنة. اتُّبع `tokens.css`: الظلال باقية، والبطاقات تحمل حد `pt-border` دائمًا.
4. **ألوان المركبات.** «ممنوع أي لون خارج الرموز»، و`ColorChips` تحتاج طلاء سيارات. رُبطت السواتش بقيم أولية موجودة (`pt-ink-0/300/500/950`، `pt-red-600`، `pt-blue-600`، `pt-amber-100/500/800`، `pt-green-600`) دون إضافة لون؛ وهو الاستثناء الوحيد لقاعدة «الأدوار الدلالية فقط».
5. **نص على زر danger وsuccess في الداكن.** لا يوجد `on-danger` ولا `on-success` في الرموز، والأبيض على `red-400` 2.8:1. `danger` يكتب بـ`pt-text-inverse` (6.57:1 داكنًا)، و`success` يستخدم زوج `pt-status-ready-bg/-fg` (9.45:1).
6. **`#3D7BFF`** (دبوس مصاف على الكحلي، BRAND §3) ليس في `tokens.css`. لم يُضف رمزًا؛ يعيش داخل `masaf-wordmark-on-dark.svg` كما هو.
7. **سلم الخطوط.** جدول 03 §2.3 لا يذكر 28/38 و32/42؛ `tokens.css` يعرّفهما، فأُضيفا (`pt-heading-3xl` لعنوان QrPanel، `pt-heading-4xl`).

## ملفات مذكورة غير موجودة في المصادر

`point-logo-stacked-navy/-white.svg`، `point-lockup-horizontal-ltr.svg`، `point-lockup-horizontal-rtl-white.svg`، `point-mark-navy.svg`، `point-wordmark.svg`، `masaf-wordmark-navy/-white.svg`، `whatsapp/masaf-profile-640.png`، مجلد `png/`، الأصوات، أيقونات التطبيق، `manifest/`، `print/masaf-paper-ticket.*`، `tokens.json`. لذلك: `Logo variant="wordmark"` يخدم «مصاف» فقط، ولا توجد نسخة بيضاء من الشعار الكامل على الأزرق.

## تباين يقل عن الحد في المصدر (لم يُعدّل)

| الزوج | الوضع | النسبة | المعالجة / اقتراح |
|---|---|---|---|
| `pt-border-strong` على `pt-surface` (حد الحقول) | فاتح / داكن | 1.81 / 1.95 | التسمية الظاهرة فوق كل حقل تعرّفه. اقتراح: حد الحقول بـ`pt-text-muted` (5.64:1 فاتحًا، 7.90:1 داكنًا)؛ `pt-ink-400` لا يكفي (2.96:1) |
| `pt-focus-ring` (55% من `pt-focus` شفاف) | فاتح | ≈2.2 | اقتراح: حلقة مصمتة بـ`pt-focus` (4.52:1) |
| `pt-conn-uncertain` / `pt-warning` على الأبيض | فاتح | 2.12 | النقطة زخرفية؛ النص والأيقونة بـ`pt-warning-text` (5.12:1) |
| `pt-primary-text` على `pt-primary-subtle` | داكن | 4.36 | العناصر المختارة تكتب بـ`pt-text` وتُبقي الأزرق للأيقونة والحد |
| `pt-info-text` على `pt-info-subtle` | داكن | 4.36 | Banner «تحديث» يكتب بـ`pt-text` والأيقونة بـ`pt-info-text` |
| `pt-on-primary` على `pt-primary-hover` | داكن | 3.13 | حالة تمرير عابرة؛ لا تُثبَّت |
| `pt-text-disabled` | فاتح | 2.96 | للمعطّل فقط (مستثنى في WCAG) |

## الخط

ملفات IBM Plex Sans Arabic في المصدر مقسومة إلى مجموعتين لكل وزن (عربي ولاتيني) تعملان بـ`unicode-range`. لأن رموز النظام تقبل ملفًا واحدًا لكل وزن، دُمج الجزءان في ملف واحد لكل وزن (`fonts/IBMPlexSansArabic-<w>.woff2`) دون تغيير أي حرف. التطبيق نفسه يستخدم حزم `@fontsource` كما في DEC-18. رخص OFL في `licenses/`.
