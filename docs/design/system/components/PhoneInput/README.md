# PhoneInput

جوال العميل: بادئة ثابتة `+966`، يقبل `05XXXXXXXX` أو `5XXXXXXXX` ويطبّع إلى E.164 مع تحقق فوري `PHONE_INVALID` (03 §3.8).

**المستهلك يوفّر:** `id`، `value`، `error` (من `message_ar`)، `disabled`، `loading`.

الحقل كله `dir="ltr"` بخط 16px. بعد الإرسال يعرض `MaskedPhone` فقط.
