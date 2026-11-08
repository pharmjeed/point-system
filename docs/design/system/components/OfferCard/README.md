# OfferCard

بطاقة طلب الإحضار (D-09): العنوان، رقم التذكرة بحجم display، المركبة + `PlateBadge`، «ينتظر منذ…»، `CountdownRing` للعرض الفردي، وزر كبير واحد (03 §3.5).

**المستهلك يوفّر:** `mode` (`single` · `broadcast`)، `ticketNumber`، `vehicleSummary`، `plate`، `venue`، `waiting` (محسوبة من `requested_at` ووقت الخادم)، `secondsLeft` (من `expires_at - serverNow`)، `canAcceptAs`، `onAccept`، `loading`، `error`، `offline`.

| `canAcceptAs` | الزر |
|---|---|
| `accept` | «قبول الطلب» primary |
| `reserve_next` | «حجز كمهمة تالية» بنفسجي + ملاحظة «احجزه فقط وأنت متوقف. لا تستخدم الجوال أثناء القيادة.» |
| `none` | بلا زر: «لديك مهمة تالية محجوزة؛ لا يمكنك حجز أخرى.» |

- طلب واحد فقط يظهر: الأقدم القابل للتصرف. `task.claimed` / `offer.closed` يزيلها فورًا ويوقف الصوت (تلاشٍ 200ms).
- أخطاء 409/410 كرسالة: «قبل الطلب سائق آخر»، «انتهى العرض»، «يوجد طلب أقدم» ثم مزامنة.
- `aria-live="assertive"` يعلن «طلب إحضار جديد، تذكرة 125».
- رقم التذكرة بخط IBM Plex Mono 600 حسب توجيه المشروع (انظر ملاحظات التعارض).
