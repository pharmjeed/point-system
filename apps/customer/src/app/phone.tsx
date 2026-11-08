/**
 * C-02 رقم الجوال: fixed `+966` prefix, Saudi mobile validation (shared rule), «إرسال الرمز» asks the server to
 * send a code over WhatsApp (DEC-460). The server rate limits per number and per device.
 */
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet } from 'react-native';
import { errorText } from '../features/errorText';
import { sanitizePhoneInput, validatePhone } from '../features/phone';
import { useI18n } from '../i18n/I18nProvider';
import { useSession } from '../session/SessionProvider';
import { font, fontSize } from '../theme/tokens';
import { AppText } from '../ui/AppText';
import { Button } from '../ui/Button';
import { Banner } from '../ui/Controls';
import { DevBanner } from '../ui/DevBanner';
import { Field } from '../ui/Field';
import { Screen } from '../ui/Screen';

export default function Phone() {
  const { t, locale } = useI18n();
  const { api } = useSession();
  const router = useRouter();
  const [value, setValue] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const check = validatePhone(value);

  const submit = async () => {
    setTouched(true);
    if (!check.ok || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const c = await api.requestOtp(check.e164, locale);
      router.push({
        pathname: '/otp',
        params: {
          phone: check.e164,
          masked: c.phone_masked,
          resendAt: c.resend_available_at,
          expiresAt: c.expires_at,
          attempts: String(c.attempts_left),
        },
      });
    } catch (e) {
      setFailure(errorText(e, t, locale));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen
      footer={
        <Button
          label={t.phone.submit}
          loadingLabel={t.common.sending}
          loading={busy}
          disabled={!check.ok}
          onPress={submit}
          testID="phone-submit"
        />
      }
    >
      <DevBanner />
      <AppText variant="title" accessibilityRole="header">
        {t.phone.title}
      </AppText>
      <AppText tone="muted">{t.phone.hint}</AppText>
      <Field
        label={t.phone.label}
        testID="phone-input"
        value={value}
        onChangeText={(v) => setValue(sanitizePhoneInput(v))}
        onBlur={() => setTouched(true)}
        keyboardType="phone-pad"
        textContentType="telephoneNumber"
        autoComplete="tel"
        placeholder={t.phone.placeholder}
        error={touched && value && !check.ok ? t.phone.invalid : null}
        prefix={<AppText style={styles.prefix}>+966</AppText>}
        returnKeyType="send"
        onSubmitEditing={submit}
        ltr
        autoFocus
      />
      {failure ? <Banner tone="danger">{failure}</Banner> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  prefix: { fontFamily: font.monoSemibold, ...fontSize.base },
});
