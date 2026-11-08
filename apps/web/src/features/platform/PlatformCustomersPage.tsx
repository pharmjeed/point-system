import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  Ban,
  CircleCheck,
  CirclePause,
  CircleSlash,
  LogOut,
  RotateCcw,
  Search,
  Users,
} from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router';
import {
  consoleApi,
  consoleKeys,
  type CustomerCommand,
  type CustomerFilters,
  type CustomerStatus,
  type PlatformCustomerDetail,
} from '@/api/platformConsole';
import { paths, platformCustomerPath, platformPaymentPath } from '@/app/paths';
import { Button, Card, DataTable, EmptyState, PhoneInput, Select } from '@/components';
import { StateChip } from '@/features/common/StateChip';
import { QueryError, ReasonDialog, Section } from '@/features/supervisor/ui';
import { useStaffCommand } from '@/features/supervisor/useStaffCommand';
import { useOnline } from '@/hooks/useOnline';
import { errorMessagesAr } from '@/i18n/errors';
import { onlinePaymentStatus, p06, p08 } from '@/i18n/ar.staff';
import { fmt } from '@/i18n/fmt';
import { formatDateTime, formatHalalas } from '@/lib/format';
import { usePlatformAccount } from './PlatformLayout';
import {
  CUSTOMER_TONE,
  PAYMENT_TONE,
  customerCommandIsDestructive,
  customerCommands,
  phoneQuery,
} from './consoleModel';
import { platformCan } from './platformModel';

const STATUS_ICON = { active: CircleCheck, suspended: CirclePause, deleted: CircleSlash } as const;
const COMMAND_ICON = { suspend: CirclePause, reactivate: RotateCcw, revoke_sessions: LogOut } as const;

/** Account status: text + tone + icon, never colour alone (03 §3.3). */
export function CustomerStatusChip({ status }: { status: CustomerStatus }) {
  return (
    <StateChip label={p06.status[status]} tone={CUSTOMER_TONE[status]} icon={STATUS_ICON[status] ?? Ban} />
  );
}

/** «23.00 ر.س» with «شامل الضريبة 3.00 ر.س» under it (docs/v2/04 §4: prices include VAT, shown apart). */
export function Amount({ halalas, vat }: { halalas: number; vat: number }) {
  return (
    <span>
      <bdi dir="ltr" className="pt-num font-bold">
        {formatHalalas(halalas)}
      </bdi>
      <span className="block text-sm text-text-muted">{fmt(p08.vatLine, { vat: formatHalalas(vat) })}</span>
    </span>
  );
}

type StatusFilter = '' | CustomerStatus;

/**
 * P-06 «العملاء» (V2-024, docs/v2/02 §2; DEC-526): an exact phone search (any Saudi format; audited by the server)
 * or the newest accounts, phones always masked; the table from 1024px, cards below (S-05's DataTable).
 */
export function PlatformCustomersPage() {
  const me = usePlatformAccount();
  const navigate = useNavigate();
  const readable = platformCan(me, 'platform.customer_read');
  const [input, setInput] = useState('');
  const [issue, setIssue] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusFilter>('');
  const [phone, setPhone] = useState<string | null>(null);
  const filters: CustomerFilters = { ...(phone ? { phone } : {}), ...(status ? { status } : {}) };
  const list = useInfiniteQuery({
    queryKey: consoleKeys.customers(filters),
    queryFn: ({ pageParam, signal }) => consoleApi.customers(filters, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: readable,
  });
  if (!readable) return <EmptyState icon={Users} title={errorMessagesAr.PERMISSION_DENIED} />;
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const q = phoneQuery(input);
    if (!q.ok) return setIssue(p06.phoneInvalid);
    setIssue(null);
    setPhone(q.phone);
  };
  return (
    <div className="st-page" data-testid="platform-customers">
      <h1 className="pt-page-title">{p06.title}</h1>
      <Card>
        <form className="st-form" noValidate onSubmit={submit} role="search">
          <PhoneInput
            id="p06-phone"
            label={p06.searchLabel}
            hint={p06.searchHint}
            value={input}
            error={issue ?? undefined}
            onChange={(e) => setInput(e.target.value)}
          />
          <Select
            id="p06-status"
            label={p06.state}
            value={status}
            options={[
              ['', p06.filters.all],
              ['active', p06.filters.active],
              ['suspended', p06.filters.suspended],
              ['deleted', p06.filters.deleted],
            ]}
            onChange={(e) => setStatus(e.target.value as StatusFilter)}
          />
          <div className="st-row-actions">
            <Button type="submit" compact iconStart={Search}>
              {p06.search}
            </Button>
            {phone ? (
              <Button
                variant="secondary"
                compact
                onClick={() => {
                  setInput('');
                  setPhone(null);
                  setIssue(null);
                }}
              >
                {p06.clear}
              </Button>
            ) : null}
          </div>
        </form>
      </Card>
      <h2 className="m-0 font-bold">{phone ? p06.results : p06.newest}</h2>
      {list.isError && !list.data ? (
        <QueryError error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data && !rows.length ? (
        <EmptyState icon={Users} title={phone ? p06.noMatch : p06.empty} />
      ) : (
        <DataTable
          layout="auto"
          loading={list.isPending}
          rows={rows}
          rowKey={(a) => a.id}
          hasNext={list.hasNextPage}
          loadingMore={list.isFetchingNextPage}
          onNext={() => void list.fetchNextPage()}
          columns={[
            {
              key: 'name',
              label: p06.name,
              render: (a) => <span className="font-bold">{a.display_name ?? p06.noName}</span>,
            },
            {
              key: 'phone',
              label: p06.phone,
              render: (a) => (
                <bdi dir="ltr" className="pt-num">
                  {a.phone_masked ?? '—'}
                </bdi>
              ),
            },
            { key: 'status', label: p06.state, render: (a) => <CustomerStatusChip status={a.status} /> },
            {
              key: 'counts',
              label: `${p06.vehicles} · ${p06.sessions}`,
              render: (a) => (
                <bdi dir="ltr" className="pt-num">
                  {a.vehicles_count} · {a.live_sessions}
                </bdi>
              ),
            },
            { key: 'created', label: p06.created, render: (a) => formatDateTime(a.created_at) },
            {
              key: 'open',
              label: p06.open,
              render: (a) => (
                <Button variant="secondary" compact onClick={() => navigate(platformCustomerPath(a.id))}>
                  {p06.open}
                </Button>
              ),
            },
          ]}
        />
      )}
    </div>
  );
}

/** P-06 — one account (V2-024): read with an audit row on the server; suspend / reactivate / revoke with a reason. */
export function PlatformCustomerPage() {
  const me = usePlatformAccount();
  const { accountId = '' } = useParams();
  const navigate = useNavigate();
  const readable = platformCan(me, 'platform.customer_read');
  const detail = useQuery({
    queryKey: consoleKeys.customer(accountId),
    queryFn: ({ signal }) => consoleApi.customer(accountId, signal),
    enabled: readable,
    // the read is audited: no background refetch on focus (one row per opening)
    refetchOnWindowFocus: false,
  });
  if (!readable) return <EmptyState icon={Users} title={errorMessagesAr.PERMISSION_DENIED} />;
  const back = (
    <Button variant="ghost" compact iconStart={ArrowRight} onClick={() => navigate(paths.platformCustomers)}>
      {p06.back}
    </Button>
  );
  if (detail.isError && !detail.data)
    return (
      <div className="st-page">
        {back}
        <QueryError error={detail.error} onRetry={() => void detail.refetch()} />
      </div>
    );
  if (!detail.data)
    return (
      <div className="st-page" aria-busy>
        {back}
      </div>
    );
  return <CustomerView account={detail.data} back={back} />;
}

function CustomerView({ account: a, back }: { account: PlatformCustomerDetail; back: ReactNode }) {
  const me = usePlatformAccount();
  const online = useOnline();
  const navigate = useNavigate();
  const commands = customerCommands(me, a.status);
  const [command, setCommand] = useState<CustomerCommand | null>(null);
  const cmd = useStaffCommand(
    (input: { command: CustomerCommand; reason: string }, key: string) =>
      consoleApi.customerCommand(a.id, input.command, input.reason, key),
    {
      successMessage: command ? p06.done[command] : undefined,
      invalidate: [consoleKeys.customer(a.id), ['platform', 'customers']],
      onSuccess: () => setCommand(null),
    },
  );
  const payments = platformCan(me, 'platform.payment_read');
  return (
    <div className="st-page" data-testid="platform-customer">
      {back}
      <div className="st-head">
        <div className="st-head__title">
          <h1 className="pt-page-title">{a.display_name ?? p06.noName}</h1>
          <CustomerStatusChip status={a.status} />
        </div>
        {commands.length ? (
          <div className="st-head__actions">
            {commands.map((c) => (
              <Button
                key={c}
                compact
                variant={c === 'suspend' ? 'danger' : 'secondary'}
                iconStart={COMMAND_ICON[c]}
                disabled={!online}
                onClick={() => {
                  cmd.reset();
                  setCommand(c);
                }}
              >
                {p06.action[c]}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
      {a.status === 'deleted' ? <p className="m-0 text-sm text-text-muted">{p06.deletedNote}</p> : null}

      <Card>
        <dl className="pt-kv">
          <dt>{p06.phone}</dt>
          <dd>
            <bdi dir="ltr" className="pt-num">
              {a.phone_masked ?? '—'}
            </bdi>
          </dd>
          <dt>{p06.locale}</dt>
          <dd>{p06.localeName[a.locale]}</dd>
          <dt>{p06.created}</dt>
          <dd>{formatDateTime(a.created_at)}</dd>
          <dt>{p06.updated}</dt>
          <dd>{formatDateTime(a.updated_at)}</dd>
        </dl>
        <p className="m-0 text-sm text-text-muted">{p06.maskedNote}</p>
      </Card>

      <Section title={p06.consents}>
        <ul className="st-stack">
          {a.consents.current.map((c) => (
            <li key={c.kind}>
              <span>
                <span className="font-bold">
                  {fmt(p06.consentLine, {
                    kind: p06.consentKind[c.kind],
                    version: c.answered_version ?? '—',
                    answer:
                      c.granted === null
                        ? p06.consentNone
                        : c.granted
                          ? p06.consentGranted
                          : p06.consentRefused,
                  })}
                </span>
                {!c.up_to_date ? (
                  <span className="block text-sm text-text-muted">
                    {fmt(p06.consentStale, { version: c.current_version })}
                  </span>
                ) : null}
              </span>
              {c.answered_at ? (
                <span className="text-sm text-text-muted">{formatDateTime(c.answered_at)}</span>
              ) : null}
            </li>
          ))}
        </ul>
      </Section>

      <Section title={p06.vehiclesTitle}>
        {a.vehicles.length ? (
          <ul className="st-stack">
            {a.vehicles.map((v) => (
              <li key={v.id}>
                <span>
                  <bdi className="pt-num font-bold">{v.plate_display ?? '—'}</bdi>
                  <span className="block text-sm text-text-muted">
                    {[v.make, v.model, v.color].filter(Boolean).join(' · ') || '—'}
                  </span>
                </span>
                {v.removed_at ? (
                  <span className="text-sm text-text-muted">
                    {fmt(p06.removed, { time: formatDateTime(v.removed_at) })}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title={p06.noVehicles} />
        )}
      </Section>

      <Section title={p06.visits}>
        {a.visits.length ? (
          <ul className="st-stack">
            {a.visits.map((v) => (
              <li key={v.ticket_id}>
                <span>
                  <span className="font-bold">
                    {v.venue.name_ar ?? '—'} · {v.org.name_ar ?? '—'}
                  </span>
                  <span className="block text-sm text-text-muted">
                    {[p06.channel[v.channel], v.plate_display, formatDateTime(v.received_at)]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                <span className="text-sm">
                  {v.open
                    ? p06.visitOpen
                    : v.delivered_at
                      ? fmt(p06.visitDelivered, { time: formatDateTime(v.delivered_at) })
                      : '—'}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title={p06.noVisits} />
        )}
      </Section>

      <Section title={p06.sessionsTitle}>
        <p className="m-0">
          {fmt(p06.sessionsMeta, {
            live: a.sessions.live,
            total: a.sessions.total,
            devices: a.sessions.devices,
          })}
        </p>
        {a.sessions.items.length ? (
          <ul className="st-stack">
            {a.sessions.items.map((s) => (
              <li key={s.id}>
                <span>
                  <bdi dir="ltr" className="pt-num font-bold">
                    {fmt(p06.device, { platform: p06.platformName[s.platform], hint: s.device_hint })}
                  </bdi>
                  <span className="block text-sm text-text-muted">
                    {[
                      s.last_seen_at ? fmt(p06.lastSeen, { time: formatDateTime(s.last_seen_at) }) : null,
                      s.push_enabled ? p06.pushOn : null,
                    ]
                      .filter(Boolean)
                      .join(' · ') || formatDateTime(s.created_at)}
                  </span>
                </span>
                <span className="text-sm">
                  {s.live
                    ? p06.sessionLive
                    : s.revoked_reason
                      ? ((p06.revokedReason as Record<string, string>)[s.revoked_reason] ?? p06.sessionEnded)
                      : p06.sessionEnded}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </Section>

      <Section title={p06.cards}>
        {a.payment_methods.length ? (
          <ul className="st-stack">
            {a.payment_methods.map((c) => (
              <li key={c.id}>
                <bdi dir="ltr" className="pt-num">
                  {fmt(p06.cardLine, {
                    brand: c.brand ?? '—',
                    last4: c.last4 ?? '••••',
                    month: c.expires_month ?? '—',
                    year: c.expires_year ?? '—',
                  })}
                </bdi>
                <span className="text-sm text-text-muted">
                  {c.removed_at
                    ? fmt(p06.removed, { time: formatDateTime(c.removed_at) })
                    : c.is_default
                      ? p06.cardDefault
                      : ''}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title={p06.noCards} />
        )}
      </Section>

      <Section
        title={p06.payments}
        actions={
          payments && a.payments.length ? (
            <Button
              variant="secondary"
              compact
              onClick={() => navigate(`${paths.platformPayments}?account_id=${encodeURIComponent(a.id)}`)}
            >
              {p06.allPayments}
            </Button>
          ) : null
        }
      >
        {a.payments.length ? (
          <ul className="st-stack">
            {a.payments.map((p) => (
              <li key={p.id}>
                <span>
                  <Amount halalas={p.amount_halalas} vat={p.vat_halalas} />
                  <span className="block text-sm text-text-muted">
                    {[p.venue?.name_ar, formatDateTime(p.created_at)].filter(Boolean).join(' · ')}
                  </span>
                </span>
                <span className="st-row-actions">
                  <StateChip
                    label={onlinePaymentStatus[p.status]}
                    tone={PAYMENT_TONE[p.status]}
                    icon={CircleCheck}
                  />
                  {payments ? (
                    <Button variant="secondary" compact onClick={() => navigate(platformPaymentPath(p.id))}>
                      {p08.open}
                    </Button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title={p06.noPayments} />
        )}
      </Section>

      <Section title={p06.history}>
        {a.history.length ? (
          <ul className="st-stack">
            {a.history.map((h, i) => (
              <li key={`${h.action}-${h.occurred_at}-${i}`}>
                <span>
                  <span className="font-bold">
                    {fmt(p06.historyLine, {
                      action: p06.historyAction[h.action] ?? h.action,
                      time: formatDateTime(h.occurred_at),
                      actor: h.actor?.full_name ?? '—',
                    })}
                  </span>
                  {h.reason ? <span className="block text-sm text-text-muted">{h.reason}</span> : null}
                </span>
                {h.revoked_sessions !== null ? (
                  <span className="text-sm">{fmt(p06.revokedCount, { n: h.revoked_sessions })}</span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title={p06.noHistory} />
        )}
      </Section>

      {command ? (
        <ReasonDialog
          id={`customer-${command}`}
          open
          onOpenChange={(open) => (open ? undefined : setCommand(null))}
          title={p06.action[command]}
          body={p06.confirm[command]}
          confirmLabel={p06.action[command]}
          destructive={customerCommandIsDestructive(command)}
          pending={cmd.pending}
          error={cmd.message}
          reasonError={cmd.fields.reason ?? null}
          onConfirm={(reason) => cmd.run({ command, reason })}
        />
      ) : null}
    </div>
  );
}
