import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Banner, Button, FieldError, TextField, Toggle } from '@/components';
import { commands, fetchOrgSettings, staffKeys } from '@/features/supervisor/staffApi';
import { PageSkeleton, ReadError } from '@/features/supervisor/ui';
import { useStaffCommand } from '@/features/supervisor/useStaffCommand';
import { useOnline } from '@/hooks/useOnline';
import { buttons } from '@/i18n/ar';
import { s13, staff } from '@/i18n/ar.staff';
import { fmt } from '@/i18n/fmt';
import {
  formFromSettings,
  HEARTBEAT_BOUNDS,
  HEARTBEAT_KEYS,
  orgSettingsBody,
  SECURITY_BOUNDS,
  SECURITY_KEYS,
  validateOrgSettings,
  type OrgSettingsForm,
} from './settingsModel';

/**
 * «إعدادات المؤسسة» (02 S-13, PNT-091, DEC-39): owner only (`org.settings_manage`). Security —
 * «إلزام التحقق الثنائي للمشرفين»، مدة جلسة السائق والطاقم بالساعات، محاولات الدخول، خمول الإدارة، حد كشف
 * الجوال — and heartbeat — الفاصل وحد «غير مؤكد» وحد «منقطع». `security.pin_length` is fixed (6) and not
 * shown. Bounds and the heartbeat order are checked inline; the server's VALIDATION_FAILED fields are shown on
 * the same inputs.
 */
export function OrgSettingsSection() {
  const settings = useQuery({
    queryKey: staffKeys.orgSettings(),
    queryFn: ({ signal }) => fetchOrgSettings(signal),
  });
  const initial = useMemo(() => (settings.data ? formFromSettings(settings.data) : null), [settings.data]);
  if (settings.isPending) return <PageSkeleton />;
  if (!settings.data || !initial)
    return <ReadError error={settings.error} onRetry={() => void settings.refetch()} />;
  return <OrgSettingsEditor initial={initial} updatedAt={settings.data.updated_at ?? null} />;
}

function OrgSettingsEditor({ initial, updatedAt }: { initial: OrgSettingsForm; updatedAt: string | null }) {
  const online = useOnline();
  const qc = useQueryClient();
  const [form, setForm] = useState(initial);
  const [touched, setTouched] = useState(false);
  // a refetch (another owner saved) replaces the values only while nothing was typed here
  useEffect(() => {
    if (!touched) setForm(initial);
  }, [initial, touched]);
  const save = useStaffCommand(
    (body: ReturnType<typeof orgSettingsBody>, key: string) => commands.putOrgSettings(body, key),
    {
      onSuccess: (saved) => {
        qc.setQueryData(staffKeys.orgSettings(), saved);
        setTouched(false);
      },
    },
  );
  const local = validateOrgSettings(form);
  const errorOf = (path: string) => (touched ? local[path] : undefined) ?? save.fields[path];
  // an edit starts a new intent: the server's field errors of the previous attempt no longer apply
  const edit = (change: (f: OrgSettingsForm) => OrgSettingsForm) => {
    setTouched(true);
    save.reset();
    setForm(change);
  };
  const setSecurity = (k: keyof OrgSettingsForm['security'], v: string) =>
    edit((f) => ({ ...f, security: { ...f.security, [k]: v } }));
  const setHeartbeat = (k: keyof OrgSettingsForm['heartbeat'], v: string) =>
    edit((f) => ({ ...f, heartbeat: { ...f.heartbeat, [k]: v } }));
  return (
    <form
      className="st-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (Object.keys(local).length) return;
        void save.run({ ...orgSettingsBody(form), updated_at: updatedAt });
      }}
    >
      <Banner kind="info" rounded message={s13.org.notice} />
      <fieldset className="pt-card st-cardset">
        <legend className="pt-card__title">{s13.org.security}</legend>
        <Toggle
          id="org-supervisor_mfa_required"
          label={s13.org.supervisor_mfa_required}
          checked={form.supervisor_mfa_required}
          onChange={(v) => edit((f) => ({ ...f, supervisor_mfa_required: v }))}
        />
        <div className="st-grid2">
          {SECURITY_KEYS.map((k) => (
            <TextField
              key={k}
              id={`org-security-${k}`}
              label={s13.org[k]}
              hint={fmt(staff.minValue, { n: SECURITY_BOUNDS[k].min })}
              inputMode="numeric"
              dir="ltr"
              value={form.security[k]}
              error={errorOf(`security.${k}`)}
              onChange={(e) => setSecurity(k, e.target.value)}
            />
          ))}
        </div>
      </fieldset>
      <fieldset className="pt-card st-cardset">
        <legend className="pt-card__title">{s13.org.heartbeat}</legend>
        <p className="st-muted m-0" id="org-heartbeat-rule">
          {s13.org.heartbeatRule}
        </p>
        <div className="st-grid2">
          {HEARTBEAT_KEYS.map((k) => (
            <TextField
              key={k}
              id={`org-heartbeat-${k}`}
              label={s13.org[k]}
              hint={fmt(staff.minValue, { n: HEARTBEAT_BOUNDS[k].min })}
              inputMode="numeric"
              dir="ltr"
              value={form.heartbeat[k]}
              error={errorOf(`heartbeat.${k}`)}
              onChange={(e) => setHeartbeat(k, e.target.value)}
            />
          ))}
        </div>
      </fieldset>
      {save.message ? <FieldError role="alert">{save.message}</FieldError> : null}
      <Button
        type="submit"
        fullWidth
        loading={save.pending}
        disabled={!online || (touched && Object.keys(local).length > 0)}
      >
        {buttons.save}
      </Button>
    </form>
  );
}
