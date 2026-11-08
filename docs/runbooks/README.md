# أدلة التشغيل والإطلاق

فهرس ما يلزم المالك والمشغّل والمشرفين لتشغيل «بوينت» وقناة «مصاف» خارج الكود. الأدلة عملية وتتبع المواصفات المرقمة في `docs/`؛ عند
أي اختلاف تُقدَّم المواصفات وتُحدَّث هذه الأدلة.

| الملف | لمن | متى |
|---|---|---|
| [`go-live-checklist.md`](go-live-checklist.md) | المالك، قائد التطوير، المشغّل | قبل بوابة G5 والحفل التجريبي الأول، وبعده |
| [`whatsapp-production.md`](whatsapp-production.md) | المالك، المشغّل | تجهيز الرقم الواحد «مصاف» لدى Meta، القوالب، الـWebhook، تشغيل G2 اليدوي |
| [`paper-fallback.md`](paper-fallback.md) | المشرف، السائقون، المشغّل | الانقطاع الكلي: العمل بالورق ثم المطابقة؛ التمرين في البروفة |
| [`../DEPLOYMENT.md`](../DEPLOYMENT.md) | المشغّل | النشر والترقية والتراجع والمراقبة والنسخ الاحتياطي والاستعادة |
| [`../training/driver-guide.md`](../training/driver-guide.md) | السائقون، المدرب | قبل أول وردية؛ تمارين TD في البروفة |
| [`../training/supervisor-guide.md`](../training/supervisor-guide.md) | المشرفون، المدرب | قبل أول حفل؛ تمارين TS في البروفة |
| [`../test-evidence/devices/PROTOCOL.md`](../test-evidence/devices/PROTOCOL.md) | فريق الاختبار | مصفوفة الأجهزة الفعلية (17 H-07، G3 وPNT-099) |
| [`../test-evidence/devices/TEMPLATE.md`](../test-evidence/devices/TEMPLATE.md) | فريق الاختبار | قالب تسجيل كل جولة أجهزة |

النماذج المطبوعة في `brand/print/`، جاهزة للطباعة: دفتر تذاكر «مصاف» (`masaf-paper-ticket.pdf`)، وسجل الانقطاع المرقّم
(`point-outage-log.pdf`: غلاف ثم P01…P50؛ يُطبع العدد المحسوب لكل موقع في `paper-fallback.md` §2)، وتسليم النقد للمشرف
(`point-cash-handover.pdf`). ملفات HTML بجانبها هي المصدر، وتُفتح من مجلد `brand/print/` داخل المستودع فقط.

الأدلة اليدوية تُحفظ في `docs/test-evidence/`: `devices/<التاريخ>/`، `restore/<التاريخ>.md`، `g2/<التاريخ>.md`،
`rehearsal/<التاريخ>.md`. لا رقم عميل ولا رمز تسليم ولا سر في أي دليل؛ الفيديو خارج المستودع برابطه وبصمته `sha256`.
