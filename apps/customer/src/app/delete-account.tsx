/**
 * C-20 حذف الحساب (V2-017; Apple and Google require deletion inside the app). Step 1 explains what deleting means;
 * step 2 confirms with a fresh WhatsApp code for the account's own number (the C-03 rules: attempts, lock, resend
 * wait from the server) → a single-use proof; step 3 `DELETE /v1/customer/me`, then back to C-01 (DEC-507,
 * DEC-508). A visit in progress refuses it: the customer collects the car first.
 */
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { CommandKey } from '../features/commandKey';
import {
  AFTER_DELETE_ROUTE,
  deleteIssueFromError,
  stepAfterDeleteError,
  type DeleteStep,
} from '../features/deleteAccount';
import { errorText } from '../features/errorText';
import {
  applyResendError,
  applyResent,
  applyVerifyError,
  canResend,
  canSubmit,
  fromChallenge,
  isLocked,
  otpNoticeText,
  resendSecondsLeft,
  sanitizeCode,
  type OtpState,
} from '../features/otp';
import { isolate } from '../i18n';
import { useI18n } from '../i18n/I18nProvider';
import { newIdempotencyKey } from '../session/secureStore';
import { useSession } from '../session/SessionProvider';
import { space } from '../theme/tokens';
import { AppText } from '../ui/AppText';
import { Button } from '../ui/Button';
import { CodeInput } from '../ui/CodeInput';
import { Banner, Card } from '../ui/Controls';
import { DevBanner } from '../ui/DevBanner';
import { Screen } from '../ui/Screen';
import { ScreenHeader } from '../ui/ScreenHeader';

export default function DeleteAccount() {
  const { t, f, locale } = useI18n();
  const session = useSession();
  const router = useRouter();
  const [step, setStep] = useState<DeleteStep>('confirm');
  const [otp, setOtp] = useState<OtpState | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'send' | 'resend' | 'delete' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const key = useRef(new CommandKey(newIdempotencyKey)).current;
  const phone = session.me?.phone_e164 ?? null;

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const devCode = useMemo(
    () => (session.fake && phone && otp ? session.fake.lastCode(phone) : null),
    [session.fake, phone, otp],
  );

  if (!phone) return null;

  const sendCode = async () => {
    if (busy) return;
    setBusy('send');
    setFailure(null);
    try {
      const challenge = await session.api.requestOtp(phone, locale);
      setOtp(fromChallenge(phone, challenge));
      setCode('');
      setStep('code');
    } catch (e) {
      setFailure(errorText(e, t, locale));
    } finally {
      setBusy(null);
    }
  };

  const resend = async () => {
    if (!otp || !canResend(otp, now) || busy) return;
    setBusy('resend');
    try {
      const c = await session.api.requestOtp(phone, locale);
      setOtp((s) => (s ? applyResent(s, c) : s));
      setCode('');
    } catch (e) {
      setOtp((s) => (s ? applyResendError(s, e, Date.now()) : s));
    } finally {
      setBusy(null);
    }
  };

  const confirm = async () => {
    if (!otp || !canSubmit(otp, code, now) || busy) return;
    setBusy('delete');
    setFailure(null);
    let proof: string;
    try {
      proof = (await session.api.reauthVerify(code)).reauth_token;
    } catch (e) {
      setOtp((s) => (s ? applyVerifyError(s, e, Date.now()) : s));
      setCode('');
      setBusy(null);
      return;
    }
    setStep('deleting');
    try {
      await session.api.deleteAccount(proof, key.for(proof));
      key.reset();
      session.forgetAccount();
      router.replace(AFTER_DELETE_ROUTE);
    } catch (e) {
      const issue = deleteIssueFromError(e);
      setFailure(
        issue === 'visit_active'
          ? t.deleteAccount.visitActive
          : issue === 'reauth'
            ? t.deleteAccount.reauth
            : errorText(e, t, locale),
      );
      setStep(stepAfterDeleteError(issue));
      setCode('');
    } finally {
      setBusy(null);
    }
  };

  const notice = otp ? otpNoticeText(otp, t, locale, now) : null;
  const seconds = otp ? resendSecondsLeft(otp, now) : 0;

  return (
    <Screen
      footer={
        step === 'confirm' ? (
          <>
            <Button
              label={t.deleteAccount.sendCode}
              loading={busy === 'send'}
              loadingLabel={t.common.sending}
              onPress={() => void sendCode()}
              testID="delete-send-code"
            />
            <Button label={t.deleteAccount.cancel} variant="ghost" size="md" onPress={() => router.back()} />
          </>
        ) : otp ? (
          <>
            <Button
              label={t.deleteAccount.confirm}
              loading={busy === 'delete' || step === 'deleting'}
              loadingLabel={t.deleteAccount.deleting}
              disabled={!canSubmit(otp, code, now)}
              onPress={() => void confirm()}
              testID="delete-confirm"
            />
            <Button
              label={canResend(otp, now) ? t.otp.resend : f(t.otp.resendIn, { seconds })}
              variant="secondary"
              size="md"
              loading={busy === 'resend'}
              loadingLabel={t.common.sending}
              disabled={!canResend(otp, now) || step === 'deleting'}
              onPress={() => void resend()}
            />
            <Button
              label={t.deleteAccount.cancel}
              variant="ghost"
              size="md"
              disabled={step === 'deleting'}
              onPress={() => router.back()}
            />
          </>
        ) : undefined
      }
    >
      <ScreenHeader title={t.deleteAccount.title} backLabel={t.common.back} onBack={() => router.back()} />
      <DevBanner />
      {failure ? <Banner tone="danger">{failure}</Banner> : null}
      {step === 'confirm' ? (
        <Card>
          <AppText variant="bodyStrong" tone="danger">
            {t.deleteAccount.intro}
          </AppText>
          <View style={styles.list}>
            {t.deleteAccount.consequences.map((line) => (
              <AppText key={line}>{`• ${line}`}</AppText>
            ))}
          </View>
        </Card>
      ) : otp ? (
        <>
          <AppText variant="cardTitle" accessibilityRole="header">
            {t.deleteAccount.codeTitle}
          </AppText>
          <AppText tone="muted">{f(t.deleteAccount.codeSentTo, { phone: isolate(otp.phoneMasked) })}</AppText>
          <View style={styles.code}>
            <CodeInput
              value={code}
              onChange={(v) => setCode(sanitizeCode(v))}
              label={t.otp.label}
              disabled={isLocked(otp, now) || step === 'deleting'}
              invalid={otp.notice?.kind === 'invalid'}
            />
          </View>
          {notice ? <Banner tone={notice.tone}>{notice.text}</Banner> : null}
          {devCode ? <Banner tone="info">{f(t.otp.devCode, { code: isolate(devCode) })}</Banner> : null}
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { gap: space[2] },
  code: { paddingVertical: space[4] },
});
