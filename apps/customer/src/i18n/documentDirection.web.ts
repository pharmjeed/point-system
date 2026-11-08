/**
 * Web export for the e2e suite only (V2-018, DEC-551): react-native-web ignores I18nManager.forceRTL (its isRTL is
 * always false) and takes the direction from the document, so the language chosen by I18nProvider is written to
 * `<html dir lang>` — Arabic RTL, English LTR — exactly what the native app gets from I18nManager.
 */
export function applyDocumentDirection(locale: 'ar' | 'en'): void {
  document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
  document.documentElement.lang = locale;
}
