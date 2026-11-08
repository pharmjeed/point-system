# AppShell

غلاف الجوال: عرض أقصى `pt-shell-max-w` (480px) في المنتصف، حشوة 16px، فجوة 12px، ويحجز `env(safe-area-inset-*)` (03 §2.4، §3.2).

**المستهلك يوفّر:** `topBar`، `bottomNav`، `banner` اختياري، `offer` (طبقة `OfferLayer` فوق المحتوى بـ`pt-z-offer`)، `toast`، والمحتوى.

- `OfferCard` يظهر في الطبقة دون أن يمسح مسودة الاستلام تحتها (03 §4.3).
- السائق: `<html data-theme="system">` افتراضيًا مع مفتاح يدوي؛ المشرف: `light` (DEC-19).
- لا تمرير أفقي عند 360 و390 و430px.
