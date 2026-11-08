# بوينت · POINT — نظام التصميم

نسخة كاملة من نظام التصميم المنشور على Claude بتاريخ 27 أكتوبر 2026، مع المصادر الأصلية ومعرض مكونات يعمل دون إنترنت.

## ابدأ من هنا

- افتح `showcase/index.html` في المتصفح: الغلاف وروابط 51 مكونًا، كل صفحة تعرض حالات المكون (عادي، ضغط، تعطيل، «جارٍ…»، خطأ) بالوضعين.
- اقرأ `docs/brand-book.md` ثم `docs/masaf.md` ثم `docs/notes.md` (التعارضات والتباين الناقص والملفات المفقودة).

## المحتويات

| المسار | المحتوى |
|---|---|
| `tokens/tokens.json` | الرموز بصيغة نظام التصميم (ألوان بالوضعين، خطوط، مسافات، زوايا، ظلال، أحجام، حركة، طبقات) |
| `tokens/source/` | `tokens.css` و`tailwind.theme.css` الأصليان — مصدر الحقيقة |
| `components/bundle.js` | المكونات (React 18، يعرّف `window.Point`) |
| `components/bundle.css` | أنماط المكونات، تقرأ متغيرات `--pt-*` فقط |
| `components/index.d.ts` | أنواع خصائص كل مكون |
| `components/<Comp>/` | `README.md` (الإرشادات) و`preview.html` (المعاينة) |
| `docs/` | دليل العلامة، قسم «مصاف»، ملاحظات التعارض، ومستندات المصدر في `docs/source/` |
| `assets/` | شعارات بوينت ومصاف كما هي، ولقطات المعاينة الأصلية |
| `fonts/` | IBM Plex Sans Arabic (400–700، العربي واللاتيني في ملف واحد لكل وزن) وIBM Plex Mono (400، 600) |
| `licenses/` | رخص SIL OFL للخطين |
| `showcase/` | معرض محلي: React مضمّن والخطوط مضمّنة |
| `screenshots/` | لقطة PNG لكل مكون وللغلاف |
| `design-system.json` | فهرس النظام كما هو على Claude |

## الاستخدام في التطبيق

حمّل `tokens/source/tokens.css` ثم `components/bundle.css`، ثم React 18 وReactDOM، ثم `components/bundle.js`. ضع `<html lang="ar" dir="rtl" data-theme="system">` للسائق و`data-theme="light"` للمشرف.
