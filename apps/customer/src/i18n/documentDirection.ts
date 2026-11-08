/**
 * iOS and Android: nothing to do — the native layout direction comes from I18nManager (I18nProvider.alignDirection).
 * The web export used by the e2e suite (V2-018, DEC-551) resolves `documentDirection.web.ts` instead.
 */
export function applyDocumentDirection(_locale: 'ar' | 'en'): void {}
