import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import QRCode from 'qrcode';
import {
  platformChangeSecret,
  platformConfirmMfa,
  platformLogin,
  platformPendingStep,
  platformSetupMfa,
  platformVerifyMfa,
  type PlatformMe,
} from '@/api/platform';
import { queryKeys } from '@/api/queryClient';
import type { MfaSetup } from '@/api/types';
import { paths } from '@/app/paths';
import { Banner, Button, CodeInput, Dialog, FieldError, PhoneInput, TextField } from '@/components';
import { AuthLayout } from '@/features/auth/AuthLayout';
import { classifyLoginError, type LoginErrorAction } from '@/features/auth/loginErrors';
import { useSubmitGuard } from '@/hooks/useCommand';
import { useCountdown } from '@/hooks/useCountdown';
import { useOnline } from '@/hooks/useOnline';
import { useThemeArea } from '@/hooks/useThemeArea';
import { buttons, d01, ui } from '@/i18n/ar';
import { p01, s01 } from '@/i18n/ar.staff';
import { fmt } from '@/i18n/fmt';
import { formatClock } from '@/lib/format';
import { normalizeSaudiMobile } from '@/lib/phone';
import { isLongEnoughPassword } from '@/lib/secretPolicy';
import { serverNow } from '@/lib/serverClock';
import { usePlatformMe } from './usePlatformMe';

type FormError = { message: string; requestId: string | null } | null;
type Step = 'credentials' | 'mfa' | 'password' | 'mfa-setup';

function FormErrorLine({ error }: { error: FormError }) {
  if (!error) return null;
  return (
    <div>
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
 * Platform console sign-in (V2-002, docs/v2/02 §1 «MFA إلزامي»): 1 phone + password → 2 TOTP code on every sign-in;
 * the first sign-in (temporary password of create-platform-owner) goes 1 → 3 password change → 4 TOTP set-up, like
 * S-01. The step comes from the in-memory mfa_token and from `GET /v1/platform/me` (its `pending` list); nothing of
 * it is persisted and the staff session of the same browser is never read nor changed.
 */
export function PlatformLoginPage() {
  useThemeArea('staff');
  const me = usePlatformMe();
  const online = useOnline();
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  let step: Step | 'done' = 'credentials';
  if (mfaToken) step = 'mfa';
  else if (me.data) step = platformPendingStep(me.data) ?? 'done';
  if (step === 'done') return <Navigate to={paths.platform} replace />;

  const title =
    step === 'password' ? s01.changeTitle : step === 'mfa-setup' ? s01.setupTitle : p01.loginTitle;
  const banner = !online ? <Banner kind="offline" message={d01.offline} /> : null;
  return (
    <AuthLayout title={title} banner={banner}>
      {step === 'credentials' ? (
        <CredentialsStep
          online={online}
          notice={notice}
          onMfa={(token) => {
            setNotice(null);
            setMfaToken(token);
          }}
        />
      ) : null}
      {step === 'mfa' && mfaToken ? (
        <MfaStep
          token={mfaToken}
          online={online}
          onRestart={(message) => {
            setMfaToken(null);
            setNotice(message);
          }}
          onDone={() => setMfaToken(null)}
        />
      ) : null}
      {step === 'password' ? <PasswordStep online={online} /> : null}
      {step === 'mfa-setup' ? <MfaSetupStep online={online} /> : null}
    </AuthLayout>
  );
}

function useSetPlatformMe() {
  const qc = useQueryClient();
  return (me: PlatformMe) => qc.setQueryData(queryKeys.platformMe, me);
}

function CredentialsStep({
  online,
  notice,
  onMfa,
}: {
  online: boolean;
  notice: string | null;
  onMfa: (token: string) => void;
}) {
  const setMe = useSetPlatformMe();
  const { guard, pending } = useSubmitGuard();
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
    const e164 = normalizeSaudiMobile(phone);
    if (!e164) {
      setPhoneError(d01.phoneInvalid);
      phoneRef.current?.focus();
      return;
    }
    void guard(async () => {
      try {
        const r = await platformLogin({ phone: e164, secret: password });
        setPassword('');
        if (r.mfa_required && r.mfa_token) onMfa(r.mfa_token);
        else if (r.me) setMe(r.me); // the restricted first sign-in: the page moves to the pending step
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
          id="platform-phone"
          ref={phoneRef}
          name="phone"
          label={p01.phoneLabel}
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
          id="platform-password"
          ref={passwordRef}
          name="password"
          label={p01.passwordLabel}
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
          {p01.submit}
        </Button>
      </form>
      <div className="pt-auth__links">
        <Link className="pt-link" to={paths.staffLogin}>
          {p01.staffLink}
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
  const setMe = useSetPlatformMe();
  return (me: PlatformMe) => {
    setMe(me);
    if (!platformPendingStep(me)) navigate(paths.platform, { replace: true });
  };
}

function MfaStep({
  token,
  online,
  onRestart,
  onDone,
}: {
  token: string;
  online: boolean;
  onRestart: (message: string) => void;
  onDone: () => void;
}) {
  const finish = useFinish();
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
        const me = await platformVerifyMfa({ mfa_token: token, code });
        onDone();
        finish(me);
      } catch (error) {
        const action = classifyLoginError(error, 'mfa');
        if (action.kind === 'field') {
          setCode('');
          setCodeError(action.message);
        } else if (action.kind === 'restart' || action.kind === 'locked') {
          onRestart(action.message); // the 5-minute token is gone, or the account locked: back to the password
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
        id="platform-mfa-code"
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
        const me = await platformChangeSecret({ current_secret: current, new_secret: next });
        setCurrent('');
        setNext('');
        setConfirm('');
        finish(me);
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
        id="platform-pw-current"
        label={s01.currentPassword}
        type="password"
        autoComplete="current-password"
        dir="ltr"
        value={current}
        error={errors.current}
        onChange={(e) => setCurrent(e.target.value)}
      />
      <TextField
        id="platform-pw-next"
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
        id="platform-pw-confirm"
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
    platformSetupMfa()
      .then(async (s) => {
        setSetup(s);
        // generated locally (no third party): error correction M, 4-module quiet zone (03 §3.13)
        setQrSvg(await QRCode.toString(s.otpauth_uri, { type: 'svg', errorCorrectionLevel: 'M', margin: 4 }));
      })
      .catch((error: unknown) => setLoadError(toFormError(classifyLoginError(error, 'mfa'))));
  };

  useEffect(() => {
    if (started.current) return; // StrictMode runs effects twice; the set-up secret is issued once
    started.current = true;
    load();
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setCodeError(null);
    setFormError(null);
    void guard(async () => {
      try {
        const me = await platformConfirmMfa({ code });
        setSetup(null);
        setQrSvg('');
        finish(me);
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
        id="platform-mfa-setup-code"
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
