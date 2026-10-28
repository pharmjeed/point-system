import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Navigate, useNavigate } from 'react-router';
import { z } from 'zod';
import { changeSecret } from '@/api/auth';
import { paths } from '@/app/paths';
import { Button, FieldError, Header, TextField } from '@/components';
import { useSubmitGuard } from '@/hooks/useCommand';
import { useSetMe } from '@/hooks/useMe';
import { useThemeArea } from '@/hooks/useThemeArea';
import { d02, ui } from '@/i18n/ar';
import { fmt } from '@/i18n/fmt';
import { toLatinDigits } from '@/lib/digits';
import { isSixDigitPin, isWeakPin } from '@/lib/secretPolicy';
import { RequireSession } from '@/app/guards';
import { classifyLoginError } from './loginErrors';

/** Local pre-checks of D-02; the server stays the judge (09 §9.1). */
export const changePinSchema = z
  .object({
    current: z.string().min(1, d02.currentWrong),
    next: z
      .string()
      .refine(isSixDigitPin, d02.intro)
      .refine((v) => !isWeakPin(v), d02.weak),
    confirm: z.string(),
  })
  .refine((v) => v.next === v.confirm, { path: ['confirm'], message: d02.mismatch });

type PinValues = z.infer<typeof changePinSchema>;

/**
 * D-02 — change the PIN: forced on first sign-in (no back button), later reachable from D-14.
 * After success the first-login driver goes to D-03 (PNT-022 acceptance 3). The PINs live only in the
 * form state and are reset after the request (acceptance 2).
 */
export function ChangeSecretPage() {
  useThemeArea('driver');
  return (
    <RequireSession>
      {(me) =>
        me.user.role === 'driver' ? (
          <ChangePinForm firstLogin={!!me.user.must_change_secret} />
        ) : (
          <Navigate to={paths.staffLogin} replace />
        )
      }
    </RequireSession>
  );
}

function ChangePinForm({ firstLogin }: { firstLogin: boolean }) {
  const navigate = useNavigate();
  const setMe = useSetMe();
  const { guard, pending } = useSubmitGuard();
  const [formError, setFormError] = useState<{ message: string; requestId: string | null } | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    setValue,
    reset,
    formState: { errors },
  } = useForm<PinValues>({
    resolver: zodResolver(changePinSchema),
    defaultValues: { current: '', next: '', confirm: '' },
    mode: 'onSubmit',
  });

  const latin = (name: keyof PinValues) =>
    register(name, { setValueAs: (v: string) => toLatinDigits(String(v ?? '')).replace(/\s/g, '') });

  const onSubmit = handleSubmit((values) =>
    guard(async () => {
      setFormError(null);
      try {
        const me = await changeSecret({ current_secret: values.current, new_secret: values.next });
        reset({ current: '', next: '', confirm: '' });
        setMe({ ...me, user: { ...me.user, must_change_secret: false } });
        navigate(firstLogin ? paths.driverStart : paths.driverAccount, { replace: true });
      } catch (error) {
        const action = classifyLoginError(error, 'secret');
        if (action.kind === 'field') {
          const field = action.field === 'current' ? 'current' : 'next';
          if (action.clearField) setValue(field, '');
          setError(field, { type: 'server', message: action.message }, { shouldFocus: true });
        } else if (action.kind === 'form') {
          setFormError({ message: action.message, requestId: action.requestId });
        } else if ('message' in action) {
          setFormError({ message: action.message, requestId: null });
        }
      }
    }),
  );

  return (
    <div className="pt-auth">
      <Header title={d02.title} onBack={firstLogin ? undefined : () => navigate(paths.driverAccount)} />
      <main className="pt-auth__main" id="main">
        <p className="m-0 text-text-muted">{d02.intro}</p>
        <form className="pt-auth__form" method="post" noValidate onSubmit={onSubmit}>
          <TextField
            id="pin-current"
            label={d02.current}
            type="password"
            inputMode="numeric"
            autoComplete="current-password"
            dir="ltr"
            error={errors.current?.message}
            {...latin('current')}
          />
          <TextField
            id="pin-next"
            label={d02.next}
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            dir="ltr"
            error={errors.next?.message}
            {...latin('next')}
          />
          <TextField
            id="pin-confirm"
            label={d02.confirm}
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            dir="ltr"
            hint={d02.hint}
            error={errors.confirm?.message}
            {...latin('confirm')}
          />
          {formError ? (
            <div>
              <FieldError role="alert">{formError.message}</FieldError>
              {formError.requestId ? (
                <p className="pt-field__hint">{fmt(ui.requestId, { id: formError.requestId })}</p>
              ) : null}
            </div>
          ) : null}
          <Button type="submit" size="lg" loading={pending}>
            {d02.submit}
          </Button>
        </form>
      </main>
    </div>
  );
}
