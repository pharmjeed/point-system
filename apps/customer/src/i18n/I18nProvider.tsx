/**
 * The language of the app (DEC-481): from the device's preferred languages, Arabic unless English comes first;
 * `CUSTOMER_FORCE_LOCALE` overrides it in development. The native layout direction follows the device
 * (expo-localization `supportsRTL`); when it disagrees with the chosen language (a forced locale), RTL is forced
 * for the next launch.
 */
import { getLocales } from 'expo-localization';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { I18nManager } from 'react-native';
import { appConfig } from '../config';
import { dictionaries, fmt, resolveLocale, type AppLocale, type Dictionary } from './index';
import { isRtl } from './format';

interface I18nValue {
  locale: AppLocale;
  t: Dictionary;
  /** `fmt` with `{brand}` always available (the customer app brand from the config, DEC-480). */
  f(template: string, values?: Readonly<Record<string, string | number>>): string;
  brand: string;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const value = useMemo<I18nValue>(() => {
    const locale = resolveLocale(
      getLocales().map((l) => l.languageTag),
      appConfig.forceLocale,
    );
    if (I18nManager.isRTL !== isRtl(locale)) {
      I18nManager.allowRTL(true);
      I18nManager.forceRTL(isRtl(locale)); // applies from the next launch
    }
    const brand = locale === 'ar' ? appConfig.brand.nameAr : appConfig.brand.nameEn;
    return {
      locale,
      t: dictionaries[locale],
      brand,
      f: (template, values = {}) => fmt(template, { brand, ...values }),
    };
  }, []);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n outside I18nProvider');
  return value;
}
