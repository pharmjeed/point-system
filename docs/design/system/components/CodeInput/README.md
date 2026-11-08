# CodeInput

رمز التسليم: ست خانات رقمية بخط IBM Plex Mono 600 ‏24px، `inputmode="numeric"` و`autocomplete="off"`، ويدعم اللصق (03 §3.11).

**المستهلك يوفّر:** `value`، `onChange`، `attemptsLeft` (من `details.attempts_left`)، `error`، `locked` (`HANDOVER_CODE_LOCKED`)، `disabled`.

- **لا يُعبّأ مسبقًا ولا يُعرض الرمز من الخادم إطلاقًا.**
- لا إرسال تلقائي عند اكتمال الخانات: زر «تأكيد التسليم» (`Button variant="success" size="lg"`) يرسل.
- عند القفل: «تواصل مع المشرف».
