import { Platform } from 'react-native';
import { useI18n } from '../i18n/I18nProvider';
import { useSession } from '../session/SessionProvider';
import { Banner } from './Controls';

/**
 * Marks the fake backend so nobody mistakes sample data for the real service (development only). Not drawn on
 * web: the web target exists only for the store-screenshot export (V2-052, DEC-568), whose pictures show the
 * sample data of the fake backend as store art.
 */
export function DevBanner() {
  const { fake } = useSession();
  const { t } = useI18n();
  return fake && Platform.OS !== 'web' ? <Banner tone="warning">{t.common.devFakeApi}</Banner> : null;
}
