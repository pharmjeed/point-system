/**
 * The language of the app (DEC-481): from the device's preferred languages, Arabic unless English comes first;
 * the choice made on C-19 (kept in secure storage, V2-017) overrides the device, and `CUSTOMER_FORCE_LOCALE`
 * overrides both in development. The native layout direction follows the device (expo-localization
 * `supportsRTL`); when it disagrees with the chosen language, RTL is forced for the next launch — so a switch on
 * C-19 changes every text at once and the direction when the app is opened again (DEC-509).
 */
import { getLocales } from 'expo-localization';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { I18nManager } from 'react-native';
import { appConfig } from '../config';
import { parseStoredLocale } from '../features/settings';
import { flags } from '../session/secureStore';
import { dictionaries, fmt, resolveLocale, type AppLocale, type Dictionary } from './index';
import { isRtl } from './format';

interface I18nValue {
  locale: AppLocale;
  t: Dictionary;
  /** `fmt` with `{brand}` always available (the customer app brand from the config, DEC-480). */
  f(template: string, values?: Readonly<Record<string, string | number>>): string;
  brand: string;
  /** C-19: switch the language now and keep it on the device. */
  setLocale(next: AppLocale): Promise<void>;
}

const I18nContext = createContext<I18nValue | null>(null);

const deviceLocale = () =>
  resolveLocale(
    getLocales().map((l) => l.languageTag),
    appConfig.forceLocale,
  );

/** The next launch draws in the direction of the language (applies from the next start). */
function alignDirection(locale: AppLocale) {
  if (I18nManager.isRTL !== isRtl(locale)) {
    I18nManager.allowRTL(true);
    I18nManager.forceRTL(isRtl(locale));
  }
}

export function I18nProvider({ children }: { children: ReactNode }) {
  // undefined while the stored choice is read (a few milliseconds, behind the splash screen)
  const [locale, setLocaleState] = useState<AppLocale | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = appConfig.forceLocale ? null : parseStoredLocale(await flags.locale().catch(() => null));
      const chosen = stored ?? deviceLocale();
      alignDirection(chosen);
      if (!cancelled) setLocaleState(chosen);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setLocale = useCallback(async (next: AppLocale) => {
    await flags.setLocale(next);
    alignDirection(next);
    setLocaleState(next);
  }, []);

  const value = useMemo<I18nValue | null>(() => {
    if (!locale) return null;
    const brand = locale === 'ar' ? appConfig.brand.nameAr : appConfig.brand.nameEn;
    return {
      locale,
      t: dictionaries[locale],
      brand,
      f: (template, values = {}) => fmt(template, { brand, ...values }),
      setLocale,
    };
  }, [locale, setLocale]);

  if (!value) return null;
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n outside I18nProvider');
  return value;
}
