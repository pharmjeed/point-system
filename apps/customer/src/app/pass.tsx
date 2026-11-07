/**
 * C-11 بطاقة الدخول — stub target of the C-06 button. The rotating, offline, signed QR (V2-D14,
 * `customer_passes`, `GET /v1/customer/pass`) is built by V2-013.
 */
import { useRouter } from 'expo-router';
import { useI18n } from '../i18n/I18nProvider';
import { AppText } from '../ui/AppText';
import { Button } from '../ui/Button';
import { Card } from '../ui/Controls';
import { Screen } from '../ui/Screen';

export default function Pass() {
  const { t } = useI18n();
  const router = useRouter();
  return (
    <Screen footer={<Button label={t.common.back} variant="secondary" onPress={() => router.back()} />}>
      <AppText variant="title" accessibilityRole="header">
        {t.pass.title}
      </AppText>
      <Card>
        <AppText variant="bodyStrong">{t.pass.comingSoon}</AppText>
        <AppText tone="muted">{t.pass.body}</AppText>
      </Card>
    </Screen>
  );
}
