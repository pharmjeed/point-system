import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { Me, RetentionPolicy } from '@/api/types';
import { Banner, Button, FieldError, TextField } from '@/components';
import { can } from '@/features/supervisor/permissions';
import { commands, fetchRetention, staffKeys } from '@/features/supervisor/staffApi';
import { PageSkeleton, ReadError } from '@/features/supervisor/ui';
import { useStaffCommand } from '@/features/supervisor/useStaffCommand';
import { useOnline } from '@/hooks/useOnline';
import { buttons } from '@/i18n/ar';
import { s13, staff } from '@/i18n/ar.staff';
import { fmt } from '@/i18n/fmt';
import { formatDateTime } from '@/lib/format';
import {
  RETENTION_BOUNDS,
  RETENTION_KEYS,
  retentionBody,
  validateRetention,
  type RetentionKey,
} from './settingsModel';

/**
 * «سياسة الاحتفاظ» (02 S-13, PNT-091): read with `audit.read` (admin: view), edit with `retention.manage`
 * (owner). The durations are proposals until the owner approves them (Q-06, DEC-67 `approved_by_owner`).
 */
export function RetentionSection({ me }: { me: Me }) {
  const policy = useQuery({
    queryKey: staffKeys.retention(),
    queryFn: ({ signal }) => fetchRetention(signal),
  });
  if (policy.isPending) return <PageSkeleton />;
  if (!policy.data) return <ReadError error={policy.error} onRetry={() => void policy.refetch()} />;
  return <RetentionForm policy={policy.data} editable={can(me, 'retention.manage')} />;
}

const toForm = (p: RetentionPolicy) =>
  Object.fromEntries(RETENTION_KEYS.map((k) => [k, String(p[k])])) as Record<RetentionKey, string>;

function RetentionForm({ policy, editable }: { policy: RetentionPolicy; editable: boolean }) {
  const online = useOnline();
  const qc = useQueryClient();
  const [form, setForm] = useState(() => toForm(policy));
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!touched) setForm(toForm(policy));
  }, [policy, touched]);
  const save = useStaffCommand(
    (body: ReturnType<typeof retentionBody>, key: string) => commands.putRetention(body, key),
    {
      onSuccess: (saved) => {
        qc.setQueryData(staffKeys.retention(), saved);
        setTouched(false);
      },
    },
  );
  const local = validateRetention(form);
  return (
    <form
      className="st-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (Object.keys(local).length) return;
        void save.run(retentionBody(form));
      }}
    >
      <Banner kind="info" rounded message={s13.retention.warning} />
      <p className="st-muted m-0">
        {policy.approved_by_owner ? s13.retention.approved : s13.retention.proposed}
        {policy.updated_at ? ` · ${formatDateTime(policy.updated_at)}` : ''}
      </p>
      <div className="st-grid2">
        {RETENTION_KEYS.map((k) => (
          <TextField
            key={k}
            id={`retention-${k}`}
            label={s13.retention[k]}
            hint={`${fmt(staff.minValue, { n: RETENTION_BOUNDS[k].min })} · ${fmt(staff.maxValue, { n: RETENTION_BOUNDS[k].max })}`}
            inputMode="numeric"
            dir="ltr"
            readOnly={!editable}
            value={form[k]}
            error={(touched ? local[k] : undefined) ?? save.fields[k]}
            onChange={(e) => {
              setTouched(true);
              setForm((f) => ({ ...f, [k]: e.target.value }));
            }}
          />
        ))}
      </div>
      {save.message ? <FieldError role="alert">{save.message}</FieldError> : null}
      {editable ? (
        <Button
          type="submit"
          fullWidth
          loading={save.pending}
          disabled={!online || (touched && Object.keys(local).length > 0)}
        >
          {buttons.save}
        </Button>
      ) : null}
    </form>
  );
}
