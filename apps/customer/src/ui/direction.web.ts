/**
 * The web export (e2e and store pictures, DEC-551/DEC-568): the document's own direction (`<html dir>`, set from the
 * language by src/i18n/documentDirection.web.ts) — react-native-web's I18nManager stays left to right.
 */
export const isRTL = (): boolean =>
  typeof document !== 'undefined' && document.documentElement.getAttribute('dir') === 'rtl';
