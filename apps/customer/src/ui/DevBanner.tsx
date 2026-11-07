import { useI18n } from '../i18n/I18nProvider';
import { useSession } from '../session/SessionProvider';
import { Banner } from './Controls';

/** Marks the fake backend so nobody mistakes sample data for the real service (development only). */
export function DevBanner() {
  const { fake } = useSession();
  const { t } = useI18n();
  return fake ? <Banner tone="warning">{t.common.devFakeApi}</Banner> : null;
}
