import { Platform } from 'react-native';
import { useI18n } from '../i18n/I18nProvider';
import { useSession } from '../session/SessionProvider';
import { Banner } from './Controls';

/**
 * Marks the fake backend so nobody mistakes sample data for the real service (development only). Not drawn on
 * web: the web target exists only for the one web export (`export:web`, DEC-568) — the store screenshots show the
 * fake backend's sample data as store art, and the e2e suite (V2-018) needs no banner (C-03's code line is apart).
 */
export function DevBanner() {
  const { fake } = useSession();
  const { t } = useI18n();
  return fake && Platform.OS !== 'web' ? <Banner tone="warning">{t.common.devFakeApi}</Banner> : null;
}
