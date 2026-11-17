import type { ViewStyle } from 'react-native';

/**
 * The web export (e2e and store pictures, DEC-551/DEC-568): the document's own direction (`<html dir>`, set from the
 * language by src/i18n/documentDirection.web.ts) — react-native-web's I18nManager stays left to right.
 */
export const isRTL = (): boolean =>
  typeof document !== 'undefined' && document.documentElement.getAttribute('dir') === 'rtl';

/**
 * An absolute offset from the start edge of the line, physical on the web export: react-native-web resolves `start`
 * from its own (left-to-right) context, not from `<html dir>`.
 */
export const fromStart = (value: number): ViewStyle => (isRTL() ? { right: value } : { left: value });

/** An absolute offset from the end edge of the line, physical on the web export (as `fromStart`). */
export const fromEnd = (value: number): ViewStyle => (isRTL() ? { left: value } : { right: value });
