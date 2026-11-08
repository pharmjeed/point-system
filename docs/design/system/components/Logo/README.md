# Logo

يعرض ملفات SVG للعلامتين كما هي، دون إعادة رسم أو تغيير ألوان (03 §3.17، BRAND §2).

**المستهلك يوفّر:** `brand` (`point` · `masaf`)، `variant`، `theme` (`light` · `dark` · `auto`)، `height`، `alt`.

| brand | variant | الملف (فاتح / داكن) | متى |
|---|---|---|---|
| point | `mark` | point-mark | TopBar للجوال (28px + «بوينت» نصًا)، الأيقونات؛ حد أدنى 24px |
| point | `mark-white` | point-mark-white | على `pt-brand-blue` فقط |
| point | `lockup-rtl` | point-lockup-horizontal-rtl / -on-dark | SideNav ولوحة المشرف الواسعة؛ حد أدنى 140px |
| point | `stacked` | point-logo-stacked / -on-dark | شاشة الدخول والمستندات؛ حد أدنى 120px |
| masaf | `wordmark` | masaf-wordmark / -on-dark | أسطح العميل فقط؛ حد أدنى 64px |
| masaf | `avatar` | masaf-avatar | صورة حساب واتساب، معاينة الرسائل |

`theme="auto"` يتبع أقرب `data-theme`. `wordmark` لبوينت غير متاح في المصادر (انظر الملاحظات).
