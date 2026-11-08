# PlateInput

إدخال اللوحة السعودية: حتى 4 أرقام + 3 أحرف عبر `LetterPad`، وخيار «لوحة أخرى» لحقل حر `plate_raw` (03 §3.7).

**المستهلك يوفّر:** `digits`، `letters` (`[[ar, en], …]`)، `error`، `disabled`، `other`؛ ويخزّن `plate_letters_ar` و`plate_letters_en` معًا.

الأرقام `inputmode="numeric"` بخط Mono داخل `dir="ltr"`؛ الأرقام يسارًا والأحرف يمينًا كاللوحة الحقيقية.
