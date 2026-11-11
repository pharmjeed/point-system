/**
 * C-03 رمز التحقق: six digits delivered on WhatsApp (DEC-460), «إعادة الإرسال» after the server's 60 s, the
 * attempts left from the server, and the 15-minute stop after five wrong codes. No automatic submit (03 §3.11).
 * V2-UX (DEC-576): the step head, the six boxes with their caret, the resend countdown with a timer icon.
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import {
  applyResendError,
  applyResent,
  applyVerifyError,
  canResend,
  canSubmit,
  isLocked,
  resendSecondsLeft,
  sanitizeCode,
  type OtpNotice,
  type OtpState,
} from '../features/otp';
import { minutesUntil } from '../i18n/format';
import { isolate } from '../i18n';
import { useI18n } from '../i18n/I18nProvider';
import { useSession } from '../session/SessionProvider';
import { space } from '../theme/tokens';
import { Button } from '../ui/Button';
import { CodeInput } from '../ui/CodeInput';
import { Banner } from '../ui/Controls';
import { DevBanner } from '../ui/DevBanner';
import { Screen } from '../ui/Screen';
import { StepHeader } from '../ui/StepHeader';

export default function Otp() {
  const params = useLocalSearchParams<{
    phone: string;
    masked: string;
    resendAt: string;
    attempts: string;
  }>();
  const { t, f, locale } = useI18n();
  const session = useSession();
  const router = useRouter();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'verify' | 'resend' | null>(null);
  const [now, setNow] = useState(Date.now());
  const [state, setState] = useState<OtpState>(() => ({
    phoneE164: params.phone,
    phoneMasked: params.masked,
    resendAvailableAt: Date.parse(params.resendAt),
    attemptsLeft: Number(params.attempts),
    lockedUntil: null,
    notice: null,
  }));

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const locked = isLocked(state, now);
  const devCode = useMemo(
    () => (session.fake ? session.fake.lastCode(state.phoneE164) : null),
    // re-read after every resend (the notice changes)
    [session.fake, state.phoneE164, state.notice],
  );

  const verify = async () => {
    if (!canSubmit(state, code, now) || busy) return;
    setBusy('verify');
    try {
      const result = await session.api.verifyOtp(state.phoneE164, code);
      router.replace(await session.setMe(result.account));
    } catch (e) {
      setState((s) => applyVerifyError(s, e, Date.now()));
      setCode('');
    } finally {
      setBusy(null);
    }
  };

  const resend = async () => {
    if (!canResend(state, now) || busy) return;
    setBusy('resend');
    try {
      const c = await session.api.requestOtp(state.phoneE164, locale);
      setState((s) => applyResent(s, c));
      setCode('');
    } catch (e) {
      setState((s) => applyResendError(s, e, Date.now()));
    } finally {
      setBusy(null);
    }
  };

  const noticeText = (n: OtpNotice): { tone: 'danger' | 'success' | 'warning'; text: string } => {
    switch (n.kind) {
      case 'invalid':
        return {
          tone: 'danger',
          text: n.attemptsLeft === null ? t.otp.invalid : f(t.otp.attemptsLeft, { count: n.attemptsLeft }),
        };
      case 'expired':
        return { tone: 'warning', text: t.otp.expired };
      case 'locked':
        return {
          tone: 'danger',
          text: f(t.otp.locked, {
            minutes: state.lockedUntil ? minutesUntil(new Date(state.lockedUntil).toISOString(), now) : 15,
          }),
        };
      case 'resent':
        return { tone: 'success', text: t.otp.resent };
      case 'rateLimited':
        return { tone: 'warning', text: t.errors.RATE_LIMITED };
      case 'channelDown':
        return { tone: 'warning', text: t.otp.channelDown };
      case 'network':
        return { tone: 'danger', text: t.common.networkError };
      case 'server':
        return { tone: 'danger', text: locale === 'ar' ? n.messageAr : n.message };
    }
  };

  const notice =
    state.notice && !(state.notice.kind === 'locked' && !locked) ? noticeText(state.notice) : null;
  const seconds = resendSecondsLeft(state, now);

  return (
    <Screen
      footer={
        <>
          <Button
            label={t.otp.submit}
            loading={busy === 'verify'}
            loadingLabel={t.common.loading}
            disabled={!canSubmit(state, code, now)}
            onPress={verify}
            testID="otp-submit"
          />
          <Button
            label={canResend(state, now) ? t.otp.resend : f(t.otp.resendIn, { seconds })}
            variant="secondary"
            size="md"
            icon={canResend(state, now) ? 'refresh' : 'timer'}
            loading={busy === 'resend'}
            loadingLabel={t.common.sending}
            disabled={!canResend(state, now)}
            onPress={resend}
          />
          <Button label={t.otp.changeNumber} variant="ghost" size="md" onPress={() => router.back()} />
        </>
      }
    >
      <DevBanner />
      <StepHeader
        icon="message-circle"
        title={t.otp.title}
        hint={f(t.otp.sentTo, { phone: isolate(state.phoneMasked) })}
        step={2}
      />
      <View style={styles.code}>
        <CodeInput
          value={code}
          onChange={(v) => setCode(sanitizeCode(v))}
          label={t.otp.label}
          disabled={locked}
          invalid={state.notice?.kind === 'invalid'}
        />
      </View>
      {notice ? <Banner tone={notice.tone}>{notice.text}</Banner> : null}
      {devCode ? <Banner tone="info">{f(t.otp.devCode, { code: isolate(devCode) })}</Banner> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({ code: { paddingVertical: space[4] } });
