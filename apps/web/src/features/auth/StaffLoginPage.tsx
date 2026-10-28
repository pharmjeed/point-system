import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import QRCode from 'qrcode';
import { changeSecret, confirmMfa, login, setupMfa, verifyMfa } from '@/api/auth';
import { queryKeys } from '@/api/queryClient';
import type { Me, MfaSetup } from '@/api/types';
import { homePathFor, paths, restrictedStaffStep } from '@/app/paths';
import { sessionEndText } from '@/app/sessionEnd';
import { Banner, Button, CodeInput, Dialog, FieldError, PhoneInput, TextField } from '@/components';
import { useSubmitGuard } from '@/hooks/useCommand';
import { useCountdown } from '@/hooks/useCountdown';
import { useMe, useSetMe } from '@/hooks/useMe';
import { useOnline } from '@/hooks/useOnline';
import { useThemeArea } from '@/hooks/useThemeArea';
import { buttons, d01, s01, ui } from '@/i18n/ar';
import { fmt } from '@/i18n/fmt';
import { formatClock } from '@/lib/format';
import { normalizeSaudiMobile } from '@/lib/phone';
import { isLongEnoughPassword } from '@/lib/secretPolicy';
import { serverNow } from '@/lib/serverClock';
import { useSessionStore, type StaffStep } from '@/stores/session';
import { AuthLayout } from './AuthLayout';
import { useAfterLogin } from './DriverLoginPage';
import { classifyLoginError, type LoginErrorAction } from './loginErrors';

type FormError = { message: string; requestId: string | null } | null;

function FormErrorLine({ error, id }: { error: FormError; id?: string }) {
  if (!error) return null;
  return (
    <div id={id}>
      <FieldError role="alert">{error.message}</FieldError>
      {error.requestId ? (
        <p className="pt-field__hint">{fmt(ui.requestId, { id: error.requestId })}</p>
      ) : null}
    </div>
  );
}

function toFormError(action: LoginErrorAction): FormError {
  if (action.kind === 'form') return { message: action.message, requestId: action.requestId };
  if ('message' in action) return { message: action.message, requestId: null };
  return null;
}

/**
 * S-01 — staff sign-in (02 S-01): 1 phone + password → 2 TOTP code (when MFA is on) → 3 password change
 * (first time) → 4 MFA setup (first time). The step is derived from the in-memory mfa_token and from the
 * (restricted) session in `/v1/me`; nothing of it is persisted.
 */
export function StaffLoginPage() {
  useThemeArea('staff');
  const me = useMe();
  const mfaToken = useSessionStore((s) => s.mfaToken);
  const ended = useSessionStore((s) => s.ended);
  const online = useOnline();

  let step: StaffStep | 'done' = 'credentials';
  if (mfaToken) step = 'mfa';
  else if (me.data) step = me.data.user.role === 'driver' ? 'done' : (restrictedStaffStep(me.data) ?? 'done');

  if (step === 'done' && me.data) return <Navigate to={homePathFor(me.data)} replace />;

  const reasonLine = ended ? <Banner kind="info" message={sessionEndText(ended)} /> : null;
  const banner = !online ? (
    <Banner kind="offline" message={d01.offline} />
  ) : step === 'credentials' ? (
    reasonLine
  ) : null;

  return (
    <AuthLayout
      title={step === 'password' ? s01.changeTitle : step === 'mfa-setup' ? s01.setupTitle : s01.title}
      banner={banner}
    >
      {step === 'credentials' ? <CredentialsStep online={online} /> : null}
      {step === 'mfa' && mfaToken ? <MfaStep token={mfaToken} online={online} /> : null}
      {step === 'password' ? <PasswordStep online={online} /> : null}
      {step === 'mfa-setup' ? <MfaSetupStep online={online} /> : null}
    </AuthLayout>
  );
}

function CredentialsStep({ online }: { online: boolean }) {
  const qc = useQueryClient();
  const afterLogin = useAfterLogin();
  const { guard, pending } = useSubmitGuard();
  const notice = useSessionStore((s) => s.staffNotice);
  const clearStaffNotice = useSessionStore((s) => s.clearStaffNotice);
  const goToStaffStep = useSessionStore((s) => s.goToStaffStep);
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [formError, setFormError] = useState<FormError>(null);
  const [blockedUntil, setBlockedUntil] = useState<number | null>(null);
  const [dialog, setDialog] = useState<string | null>(null);
  const blockedFor = useCountdown(blockedUntil);
  const phoneRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setPhoneError(null);
    setPasswordError(null);
    setFormError(null);
    clearStaffNotice();
    const e164 = normalizeSaudiMobile(phone);
    if (!e164) {
      setPhoneError(d01.phoneInvalid);
      phoneRef.current?.focus();
      return;
    }
    void guard(async () => {
      try {
        await afterLogin(await login({ phone: e164, secret: password }));
        setPassword('');
      } catch (error) {
        const action = classifyLoginError(error, 'login');
        if (action.kind === 'field') {
          if (action.field === 'phone') {
            setPhoneError(action.message);
            phoneRef.current?.focus();
          } else {
            setPasswordError(action.message);
            if (action.clearField) setPassword('');
            passwordRef.current?.focus();
          }
        } else if (action.kind === 'locked') {
          setFormError({ message: action.message, requestId: null });
          setBlockedUntil(action.until ?? serverNow() + 15 * 60_000);
        } else if (action.kind === 'rate') {
          setFormError({ message: action.message, requestId: null });
          setBlockedUntil(action.until);
        } else if (action.kind === 'dialog') {
          setDialog(action.message);
        } else if (action.kind === 'secretChange' || action.kind === 'mfaSetup') {
          // Restricted session: `/v1/me` tells which S-01 step comes next (secret change before MFA setup).
          goToStaffStep(action.kind === 'secretChange' ? 'password' : 'mfa-setup');
          void qc.invalidateQueries({ queryKey: queryKeys.me });
        } else {
          setFormError(toFormError(action));
        }
      }
    });
  };

  const blocked = blockedFor > 0;
  return (
    <>
      <form className="pt-auth__form" method="post" noValidate onSubmit={submit}>
        <PhoneInput
          id="staff-phone"
          ref={phoneRef}
          name="phone"
          label={s01.phoneLabel}
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
          id="staff-password"
          ref={passwordRef}
          name="password"
          label={s01.passwordLabel}
          revealable
          autoComplete="current-password"
          dir="ltr"
          value={password}
          error={passwordError}
          onChange={(e) => {
            setPassword(e.target.value);
            if (passwordError) setPasswordError(null);
          }}
        />
        <FormErrorLine error={formError ?? (notice ? { message: notice, requestId: null } : null)} />
        {blocked ? (
          <p className="pt-field__hint" aria-live="polite">
            {fmt(d01.lockedUntil, { time: formatClock(blockedFor) })}
          </p>
        ) : null}
        <Button
          type="submit"
          size="lg"
          loading={pending}
          disabled={!online || blocked || !phone || !password}
        >
          {s01.submit}
        </Button>
      </form>
      <div className="pt-auth__links">
        <Link className="pt-link" to={paths.login}>
          {s01.driverLink}
        </Link>
      </div>
      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => !open && setDialog(null)}
        title={dialog ?? ''}
        cancelLabel={buttons.gotIt}
        onCancel={() => setDialog(null)}
      />
    </>
  );
}

function useFinish() {
  const navigate = useNavigate();
  const setMe = useSetMe();
  const clearMfa = useSessionStore((s) => s.clearMfa);
  const goToStaffStep = useSessionStore((s) => s.goToStaffStep);
  const clearEnded = useSessionStore((s) => s.clearEnded);
  return (me: Me) => {
    clearMfa();
    goToStaffStep(null);
    clearEnded();
    setMe(me);
    if (!restrictedStaffStep(me)) navigate(homePathFor(me), { replace: true });
  };
}

function MfaStep({ token, online }: { token: string; online: boolean }) {
  const finish = useFinish();
  const restartStaffLogin = useSessionStore((s) => s.restartStaffLogin);
  const { guard, pending } = useSubmitGuard();
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [formError, setFormError] = useState<FormError>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setCodeError(null);
    setFormError(null);
    void guard(async () => {
      try {
        finish(await verifyMfa({ mfa_token: token, code }));
      } catch (error) {
        const action = classifyLoginError(error, 'mfa');
        if (action.kind === 'field') {
          setCode('');
          setCodeError(action.message);
        } else if (action.kind === 'restart' || action.kind === 'locked') {
          // Token expired/used, or account locked: back to phone + password with the reason (08 §4.1).
          restartStaffLogin(action.message);
        } else {
          setFormError(toFormError(action));
        }
      }
    });
  };

  return (
    <form className="pt-auth__form" method="post" noValidate onSubmit={submit}>
      <p className="m-0 text-center">{s01.mfaTitle}</p>
      <CodeInput
        id="mfa-code"
        label={s01.mfaCodeLabel}
        value={code}
        onChange={setCode}
        error={codeError}
        autoComplete="one-time-code"
        autoFocus
      />
      <FormErrorLine error={formError} />
      <Button type="submit" size="lg" loading={pending} disabled={!online || code.length !== 6}>
        {s01.mfaSubmit}
      </Button>
    </form>
  );
}

function PasswordStep({ online }: { online: boolean }) {
  const finish = useFinish();
  const { guard, pending } = useSubmitGuard();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<{ current?: string; next?: string; confirm?: string }>({});
  const [formError, setFormError] = useState<FormError>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);
    const local: typeof errors = {};
    if (!isLongEnoughPassword(next)) local.next = s01.passwordHint;
    if (next !== confirm) local.confirm = s01.passwordMismatch;
    setErrors(local);
    if (local.next || local.confirm) return;
    void guard(async () => {
      try {
        const me = await changeSecret({ current_secret: current, new_secret: next });
        setCurrent('');
        setNext('');
        setConfirm('');
        finish({ ...me, user: { ...me.user, must_change_secret: false } });
      } catch (error) {
        const action = classifyLoginError(error, 'secret');
        if (action.kind === 'field') {
          if (action.field === 'current') {
            setCurrent('');
            setErrors({ current: action.message });
          } else setErrors({ next: action.message });
        } else setFormError(toFormError(action));
      }
    });
  };

  return (
    <form className="pt-auth__form" method="post" noValidate onSubmit={submit}>
      <TextField
        id="pw-current"
        label={s01.currentPassword}
        type="password"
        autoComplete="current-password"
        dir="ltr"
        value={current}
        error={errors.current}
        onChange={(e) => setCurrent(e.target.value)}
      />
      <TextField
        id="pw-next"
        label={s01.newPassword}
        revealable
        autoComplete="new-password"
        dir="ltr"
        hint={s01.passwordHint}
        value={next}
        error={errors.next}
        onChange={(e) => setNext(e.target.value)}
      />
      <TextField
        id="pw-confirm"
        label={s01.confirmPassword}
        type="password"
        autoComplete="new-password"
        dir="ltr"
        value={confirm}
        error={errors.confirm}
        onChange={(e) => setConfirm(e.target.value)}
      />
      <FormErrorLine error={formError} />
      <Button type="submit" size="lg" loading={pending} disabled={!online || !current || !next || !confirm}>
        {s01.changeSubmit}
      </Button>
    </form>
  );
}

function MfaSetupStep({ online }: { online: boolean }) {
  const finish = useFinish();
  const { guard, pending } = useSubmitGuard();
  const started = useRef(false);
  const [setup, setSetup] = useState<MfaSetup | null>(null);
  const [qrSvg, setQrSvg] = useState('');
  const [loadError, setLoadError] = useState<FormError>(null);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [formError, setFormError] = useState<FormError>(null);

  const load = () => {
    setLoadError(null);
    setupMfa()
      .then(async (s) => {
        setSetup(s);
        // Generated locally (no third party): error correction M, 4-module quiet zone (03 §3.13 rules).
        setQrSvg(await QRCode.toString(s.otpauth_uri, { type: 'svg', errorCorrectionLevel: 'M', margin: 4 }));
      })
      .catch((error: unknown) => setLoadError(toFormError(classifyLoginError(error, 'mfa'))));
  };

  useEffect(() => {
    if (started.current) return; // StrictMode runs effects twice; the setup secret is issued once
    started.current = true;
    load();
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setCodeError(null);
    setFormError(null);
    void guard(async () => {
      try {
        const me = await confirmMfa({ code });
        setSetup(null);
        setQrSvg('');
        finish({
          ...me,
          session: { ...me.session, restricted: false },
          user: { ...me.user, mfa_enabled: true },
        });
      } catch (error) {
        const action = classifyLoginError(error, 'mfa');
        if (action.kind === 'field') {
          setCode('');
          setCodeError(action.message);
        } else setFormError(toFormError(action));
      }
    });
  };

  if (loadError) {
    return (
      <div className="pt-auth__form">
        <FormErrorLine error={loadError} />
        <Button variant="secondary" onClick={load}>
          {buttons.retry}
        </Button>
      </div>
    );
  }

  return (
    <form className="pt-auth__form" method="post" noValidate onSubmit={submit}>
      <p className="m-0">{s01.setupBody}</p>
      {qrSvg ? (
        <div
          className="pt-qrbox"
          role="img"
          aria-label={s01.setupQrAlt}
          dangerouslySetInnerHTML={{ __html: qrSvg }}
        />
      ) : null}
      {setup ? (
        <div className="flex flex-col gap-1">
          <p className="m-0 text-sm text-text-muted">{s01.setupManual}</p>
          <bdi dir="ltr" className="pt-secret">
            {setup.secret_base32}
          </bdi>
        </div>
      ) : null}
      <CodeInput
        id="mfa-setup-code"
        label={s01.mfaCodeLabel}
        value={code}
        onChange={setCode}
        error={codeError}
        autoComplete="one-time-code"
      />
      <FormErrorLine error={formError} />
      <Button type="submit" size="lg" loading={pending} disabled={!online || !setup || code.length !== 6}>
        {s01.setupSubmit}
      </Button>
    </form>
  );
}
