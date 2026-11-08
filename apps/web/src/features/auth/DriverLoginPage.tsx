import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import { getMe, login } from '@/api/auth';
import { queryKeys } from '@/api/queryClient';
import type { LoginResult, Me } from '@/api/types';
import { homePathFor, paths } from '@/app/paths';
import { sessionEndText } from '@/app/sessionEnd';
import { Banner, Button, Dialog, FieldError, PhoneInput, TextField } from '@/components';
import { useSubmitGuard } from '@/hooks/useCommand';
import { useCountdown } from '@/hooks/useCountdown';
import { useMe, useSetMe } from '@/hooks/useMe';
import { useOnline } from '@/hooks/useOnline';
import { useThemeArea } from '@/hooks/useThemeArea';
import { buttons, d01, ui } from '@/i18n/ar';
import { fmt } from '@/i18n/fmt';
import { formatClock } from '@/lib/format';
import { normalizeSaudiMobile } from '@/lib/phone';
import { serverNow } from '@/lib/serverClock';
import { useSessionStore } from '@/stores/session';
import { AuthLayout } from './AuthLayout';
import { classifyLoginError } from './loginErrors';

/**
 * After a successful POST /v1/auth/login: MFA → S-01 step 2 (token in memory only); otherwise the user
 * record decides the destination (02 §2.1). Shared with S-01.
 */
export function useAfterLogin() {
  const navigate = useNavigate();
  const setMe = useSetMe();
  const beginMfa = useSessionStore((s) => s.beginMfa);
  const clearEnded = useSessionStore((s) => s.clearEnded);
  return async (result: LoginResult) => {
    if (result.mfa_required && result.mfa_token) {
      beginMfa(result.mfa_token);
      navigate(paths.staffLogin, { replace: true });
      return;
    }
    let me: Me = result.me ?? (await getMe());
    // Keep the flags of the login reply even if /v1/me is less explicit (restricted session, 07 §1.2).
    me = {
      ...me,
      user: { ...me.user, must_change_secret: result.must_change_secret || !!me.user.must_change_secret },
      session: {
        ...me.session,
        restricted: result.must_change_secret || result.mfa_setup_required || !!me.session.restricted,
      },
    };
    clearEnded();
    setMe(me);
    navigate(homePathFor(me), { replace: true });
  };
}

/** D-01 — driver sign-in with phone + 6-digit PIN (02 D-01). */
export function DriverLoginPage() {
  useThemeArea('driver');
  const me = useMe();
  const online = useOnline();
  const ended = useSessionStore((s) => s.ended);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const afterLogin = useAfterLogin();
  const goToStaffStep = useSessionStore((s) => s.goToStaffStep);
  const { guard, pending } = useSubmitGuard();

  const [phone, setPhone] = useState('');
  const [secret, setSecret] = useState('');
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [secretError, setSecretError] = useState<string | null>(null);
  const [formError, setFormError] = useState<{ message: string; requestId: string | null } | null>(null);
  const [blockedUntil, setBlockedUntil] = useState<number | null>(null);
  const [dialog, setDialog] = useState<string | null>(null);
  const phoneRef = useRef<HTMLInputElement>(null);
  const secretRef = useRef<HTMLInputElement>(null);
  const blockedFor = useCountdown(blockedUntil);

  if (me.data) return <Navigate to={homePathFor(me.data)} replace />;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setPhoneError(null);
    setSecretError(null);
    setFormError(null);
    const e164 = normalizeSaudiMobile(phone);
    if (!e164) {
      setPhoneError(d01.phoneInvalid);
      phoneRef.current?.focus();
      return;
    }
    void guard(async () => {
      try {
        await afterLogin(await login({ phone: e164, secret }));
        setSecret('');
      } catch (error) {
        const action = classifyLoginError(error, 'login');
        switch (action.kind) {
          case 'field':
            if (action.field === 'phone') {
              setPhoneError(action.message);
              phoneRef.current?.focus();
            } else {
              setSecretError(action.message);
              if (action.clearField) setSecret('');
              secretRef.current?.focus();
            }
            break;
          case 'locked':
            setFormError({ message: action.message, requestId: null });
            setBlockedUntil(action.until ?? serverNow() + 15 * 60_000);
            break;
          case 'rate':
            setFormError({ message: action.message, requestId: null });
            setBlockedUntil(action.until);
            break;
          case 'dialog':
            setDialog(action.message);
            break;
          case 'secretChange':
            void qc.invalidateQueries({ queryKey: queryKeys.me });
            navigate(paths.changeSecret);
            break;
          case 'mfaSetup':
            goToStaffStep('mfa-setup');
            void qc.invalidateQueries({ queryKey: queryKeys.me });
            navigate(paths.staffLogin);
            break;
          case 'restart':
          case 'offline':
            setFormError({ message: action.message, requestId: null });
            break;
          case 'form':
            setFormError({ message: action.message, requestId: action.requestId });
            break;
        }
      }
    });
  };

  const blocked = blockedFor > 0;
  const notice =
    ended && ended.reason === 'unauthenticated' ? (
      <Banner kind="info" message={sessionEndText(ended)} />
    ) : null;

  return (
    <AuthLayout title={d01.title} banner={!online ? <Banner kind="offline" message={d01.offline} /> : notice}>
      <form
        className="pt-auth__form"
        method="post"
        noValidate
        onSubmit={submit}
        aria-describedby={formError ? 'login-form-err' : undefined}
      >
        <PhoneInput
          id="login-phone"
          ref={phoneRef}
          name="phone"
          label={d01.phoneLabel}
          placeholder={d01.phonePlaceholder}
          autoComplete="username"
          value={phone}
          error={phoneError}
          onChange={(e) => {
            setPhone(e.target.value);
            if (phoneError) setPhoneError(null);
          }}
        />
        <TextField
          id="login-secret"
          ref={secretRef}
          name="secret"
          label={d01.secretLabel}
          revealable
          inputMode="numeric"
          autoComplete="current-password"
          dir="ltr"
          value={secret}
          error={secretError}
          onChange={(e) => {
            setSecret(e.target.value);
            if (secretError) setSecretError(null);
          }}
        />
        {formError ? (
          <div id="login-form-err">
            <FieldError role="alert">{formError.message}</FieldError>
            {formError.requestId ? (
              <p className="pt-field__hint">{fmt(ui.requestId, { id: formError.requestId })}</p>
            ) : null}
          </div>
        ) : null}
        {blocked ? (
          <p className="pt-field__hint" aria-live="polite">
            {fmt(d01.lockedUntil, { time: formatClock(blockedFor) })}
          </p>
        ) : null}
        <Button type="submit" size="lg" loading={pending} disabled={!online || blocked || !phone || !secret}>
          {d01.submit}
        </Button>
      </form>
      <div className="pt-auth__links">
        <Link className="pt-link" to={paths.staffLogin}>
          {d01.staffLink}
        </Link>
      </div>
      <p className="pt-auth__footer">{d01.forgot}</p>
      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => !open && setDialog(null)}
        title={dialog ?? ''}
        cancelLabel={buttons.gotIt}
        onCancel={() => setDialog(null)}
      />
    </AuthLayout>
  );
}
