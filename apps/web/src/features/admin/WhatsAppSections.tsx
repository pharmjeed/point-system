import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import type { Me, WaChannelMode, WhatsAppChannel, WhatsAppTemplate } from '@/api/types';
import { Button, Card, EmptyState, FieldError, Logo, Select, TextField } from '@/components';
import { can } from '@/features/supervisor/permissions';
import { commands, fetchWaChannel, fetchWaTemplates, staffKeys } from '@/features/supervisor/staffApi';
import { Fact, PageSkeleton, ReadError } from '@/features/supervisor/ui';
import { useStaffCommand } from '@/features/supervisor/useStaffCommand';
import { useBrand } from '@/hooks/useMe';
import { useOnline } from '@/hooks/useOnline';
import { buttons, s13, staff, waChannelMode, waHealth, waTemplateStatus } from '@/i18n/ar';
import { formatDateTime } from '@/lib/format';

/**
 * «قناة واتساب» and «القوالب» (02 S-13; canon §1 rule 2: one of the three staff surfaces that may show the
 * customer brand). Channel: display name, number, health (سليمة/متدهورة/متوقفة), quality, mode (حي/محاكي) —
 * secret references only, never secrets (09 §3 `wa.channel_read`); the owner edits it (`wa.channel_manage`).
 * Templates W-01…W-08 with approval status, last sync, a bubble preview, and «مزامنة من Meta»
 * (`wa.templates_manage`).
 */
export function ChannelSection({ me }: { me: Me }) {
  const channel = useQuery({
    queryKey: staffKeys.waChannel(),
    queryFn: ({ signal }) => fetchWaChannel(signal),
  });
  const [editing, setEditing] = useState(false);
  if (channel.isPending) return <PageSkeleton />;
  if (channel.isError && !channel.data)
    return <ReadError error={channel.error} onRetry={() => void channel.refetch()} />;
  const c = channel.data ?? null;
  const manage = can(me, 'wa.channel_manage');
  return (
    <div className="st-section">
      {c ? (
        <Card as="section" aria-label={s13.sections.channel}>
          <dl className="st-facts">
            <div className="st-facts__row">
              <Fact label={s13.channel.displayName}>{c.display_name}</Fact>
              <Fact label={s13.channel.number}>
                <bdi dir="ltr">{c.phone_display ?? c.phone_number_id}</bdi>
              </Fact>
            </div>
            <div className="st-facts__row">
              <Fact label={s13.channel.status}>{waHealth[c.health_status]}</Fact>
              <Fact label={s13.channel.quality}>{c.quality_rating ?? staff.none}</Fact>
              <Fact label={s13.channel.mode}>{waChannelMode[c.mode]}</Fact>
            </div>
            {c.health_changed_at ? (
              <div className="st-facts__row">
                <Fact label={s13.channel.healthChanged}>{formatDateTime(c.health_changed_at)}</Fact>
              </div>
            ) : null}
            <div className="st-facts__row">
              <Fact label={s13.channel.secrets}>
                {(['access_token', 'app_secret', 'verify_token'] as const)
                  .map(
                    (k) =>
                      `${s13.channel.secretNames[k]}: ${s13.channel.secretConfigured[c.secrets_configured[k] ? 'true' : 'false']}`,
                  )
                  .join(' · ')}
              </Fact>
            </div>
          </dl>
        </Card>
      ) : (
        <EmptyState title={s13.channel.empty} />
      )}
      {manage && !editing ? (
        <Button variant="secondary" onClick={() => setEditing(true)}>
          {buttons.open}
        </Button>
      ) : null}
      {manage && editing ? <ChannelForm channel={c} onDone={() => setEditing(false)} /> : null}
    </div>
  );
}

const SECRET_REF_FORMAT = 'env://NAME · sm://path';

function ChannelForm({ channel, onDone }: { channel: WhatsAppChannel | null; onDone: () => void }) {
  const online = useOnline();
  const qc = useQueryClient();
  const brand = useBrand();
  const [form, setForm] = useState({
    display_name: channel?.display_name ?? brand.customerNameAr,
    business_account_id: channel?.business_account_id ?? '',
    phone_number_id: channel?.phone_number_id ?? '',
    phone_display: channel?.phone_display ?? '',
    api_version: channel?.api_version ?? '',
    mode: (channel?.mode ?? 'simulator') as WaChannelMode,
    access_token_secret_ref: '',
    app_secret_ref: '',
    verify_token_secret_ref: '',
  });
  const save = useStaffCommand(
    (body: Parameters<typeof commands.putWaChannel>[0], key: string) => commands.putWaChannel(body, key),
    {
      onSuccess: (saved) => {
        qc.setQueryData(staffKeys.waChannel(), saved);
        onDone();
      },
    },
  );
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  const required: Array<keyof typeof form> = [
    'business_account_id',
    'phone_number_id',
    'api_version',
    'access_token_secret_ref',
    'app_secret_ref',
    'verify_token_secret_ref',
  ];
  const ready = required.every((k) => String(form[k]).trim()) && /^v\d+\.\d+$/.test(form.api_version.trim());
  const field = (k: keyof typeof form, label: string, hint?: string) => (
    <TextField
      id={`wa-${k}`}
      label={label}
      hint={hint}
      dir="ltr"
      autoComplete="off"
      value={String(form[k])}
      error={save.fields[k]}
      onChange={set(k)}
    />
  );
  return (
    <form
      className="st-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void save.run({
          display_name: form.display_name.trim() || undefined,
          business_account_id: form.business_account_id.trim(),
          phone_number_id: form.phone_number_id.trim(),
          phone_display: form.phone_display.trim() || null,
          api_version: form.api_version.trim(),
          mode: form.mode,
          access_token_secret_ref: form.access_token_secret_ref.trim(),
          app_secret_ref: form.app_secret_ref.trim(),
          verify_token_secret_ref: form.verify_token_secret_ref.trim(),
        });
      }}
    >
      {field('display_name', s13.channel.displayName)}
      <div className="st-grid2">
        {field('business_account_id', s13.channel.businessAccountId)}
        {field('phone_number_id', s13.channel.phoneNumberId)}
        {field('phone_display', s13.channel.phoneDisplay)}
        {field('api_version', s13.channel.apiVersion, 'v26.0')}
      </div>
      <Select
        id="wa-mode"
        label={s13.channel.mode}
        value={form.mode}
        options={(['simulator', 'live'] as const).map((m) => [m, waChannelMode[m]] as const)}
        onChange={(e) => setForm((f) => ({ ...f, mode: e.target.value as WaChannelMode }))}
      />
      <p className="st-muted m-0">{s13.channel.refsHint}</p>
      <div className="st-grid2">
        {/* the format only: server variable names stay out of the bundle (05 §7.7, scripts/check-secrets.mjs) */}
        {field('access_token_secret_ref', s13.channel.accessTokenRef, SECRET_REF_FORMAT)}
        {field('app_secret_ref', s13.channel.appSecretRef, SECRET_REF_FORMAT)}
        {field('verify_token_secret_ref', s13.channel.verifyTokenRef, SECRET_REF_FORMAT)}
      </div>
      {save.message ? <FieldError role="alert">{save.message}</FieldError> : null}
      <div className="st-row-actions">
        <Button type="submit" loading={save.pending} disabled={!online || !ready}>
          {buttons.save}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          {buttons.cancel}
        </Button>
      </div>
    </form>
  );
}

/** Body text of a template for the preview bubble (`components[]` of the Meta definition). */
export function templateBody(t: WhatsAppTemplate): string {
  const body = t.components.find((c) => String(c.type ?? '').toUpperCase() === 'BODY');
  return typeof body?.text === 'string' ? body.text : '';
}

export function TemplatesSection({ me }: { me: Me }) {
  const online = useOnline();
  const qc = useQueryClient();
  const brand = useBrand();
  const templates = useQuery({
    queryKey: staffKeys.waTemplates(),
    queryFn: ({ signal }) => fetchWaTemplates(signal),
  });
  const sync = useStaffCommand((_: Record<string, never>, key: string) => commands.syncTemplates(key), {
    onSuccess: (list) => {
      qc.setQueryData(staffKeys.waTemplates(), list);
    },
  });
  return (
    <div className="st-section">
      {can(me, 'wa.templates_manage') ? (
        <Button
          variant="secondary"
          iconStart={RefreshCw}
          loading={sync.pending}
          disabled={!online}
          error={sync.message ?? undefined}
          onClick={() => sync.run({})}
        >
          {s13.templates.sync}
        </Button>
      ) : null}
      {templates.isPending ? (
        <PageSkeleton />
      ) : !templates.data ? (
        <ReadError error={templates.error} onRetry={() => void templates.refetch()} />
      ) : !templates.data.length ? (
        <EmptyState title={s13.templates.empty} />
      ) : (
        <ul className="st-stack">
          {templates.data.map((t) => (
            <li key={t.id}>
              <Card as="article" aria-label={t.name}>
                <dl className="st-facts">
                  <div className="st-facts__row">
                    <Fact label={staff.type}>
                      <bdi dir="ltr">{t.name}</bdi>
                    </Fact>
                    <Fact label={s13.templates.approval}>{waTemplateStatus[t.status] ?? t.status}</Fact>
                    <Fact label={s13.templates.lastSync}>
                      {t.last_synced_at ? formatDateTime(t.last_synced_at) : staff.none}
                    </Fact>
                  </div>
                  {t.rejection_reason ? (
                    <div className="st-facts__row">
                      <Fact label={staff.reason}>{t.rejection_reason}</Fact>
                    </div>
                  ) : null}
                </dl>
                {templateBody(t) ? (
                  <div className="st-bubble" aria-label={s13.templates.preview}>
                    <span className="pt-tl__brand">
                      <Logo brand="masaf" variant="avatar" height={20} alt="" />
                      {brand.customerNameAr}
                    </span>
                    <p>{templateBody(t)}</p>
                  </div>
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
