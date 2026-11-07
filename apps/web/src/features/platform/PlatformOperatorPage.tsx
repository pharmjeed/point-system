import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  Ban,
  CalendarX,
  FileSignature,
  KeyRound,
  Play,
  RotateCcw,
  CirclePause,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router';
import {
  platformApi,
  platformKeys,
  type OperatorCommand,
  type OperatorContract,
  type PlatformOperatorDetail,
} from '@/api/platform';
import { paths } from '@/app/paths';
import { Button, Card, DataTable, EmptyState, Radio, TextField } from '@/components';
import { FormSheet } from '@/features/common/FormSheet';
import { fieldError, NO_ERRORS, toFormErrors, type FormErrors } from '@/features/common/formErrors';
import { SetupStatusChip, StateChip, UserStatusChip } from '@/features/common/StateChip';
import { QueryError, ReasonDialog, Section } from '@/features/supervisor/ui';
import { useStaffCommand } from '@/features/supervisor/useStaffCommand';
import { useOnline } from '@/hooks/useOnline';
import { errorMessagesAr } from '@/i18n/errors';
import { p02, p03, staffRole } from '@/i18n/ar.staff';
import { fmt } from '@/i18n/fmt';
import { formatDateTime, formatHalalas } from '@/lib/format';
import { usePlatformAccount } from './PlatformLayout';
import { OneTimePasswordDialog, OperatorStatusChip, contractPeriod } from './platformUi';
import {
  bpToPercent,
  commandIsDestructive,
  commandNeedsReason,
  operatorCommands,
  platformCan,
  validateContractForm,
  type ContractForm,
} from './platformModel';

const COMMAND_ICON = { activate: Play, suspend: CirclePause, reactivate: RotateCcw, terminate: Ban } as const;

/**
 * P-03 «المشغل» (V2-003 / V2-005, docs/v2/02 §2, §4): the operator's status and lifecycle commands (suspend and
 * terminate with a recorded reason; terminate is final), its details, owner (masked phone, a new temporary password
 * until the first sign-in), venues, contracts with their history (create, end — never edited or deleted), its staff
 * read-only and the status history. Commands are offered per the platform matrix; the server decides.
 */
export function PlatformOperatorPage() {
  const me = usePlatformAccount();
  const { orgId = '' } = useParams();
  const navigate = useNavigate();
  const readable = platformCan(me, 'platform.operator_read');
  const detail = useQuery({
    queryKey: platformKeys.operator(orgId),
    queryFn: ({ signal }) => platformApi.operator(orgId, signal),
    enabled: readable,
  });
  if (!readable) return <EmptyState title={errorMessagesAr.PERMISSION_DENIED} />;
  const back = (
    <Button variant="ghost" compact iconStart={ArrowRight} onClick={() => navigate(paths.platformOperators)}>
      {p03.back}
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
  return <OperatorView operator={detail.data} back={back} />;
}

function OperatorView({ operator: o, back }: { operator: PlatformOperatorDetail; back: ReactNode }) {
  const me = usePlatformAccount();
  const online = useOnline();
  const manage = platformCan(me, 'platform.operator_manage');
  const commands = operatorCommands(me, o.operator_status);
  const [command, setCommand] = useState<OperatorCommand | null>(null);
  const [addingContract, setAddingContract] = useState(false);
  const [ending, setEnding] = useState<OperatorContract | null>(null);
  const [reissue, setReissue] = useState(false);
  const [password, setPassword] = useState<{ value: string | null } | null>(null);
  const invalidate = [platformKeys.operator(o.id), platformKeys.operators, platformKeys.overview];

  const transition = useStaffCommand(
    (input: { command: OperatorCommand; reason: string }, key: string) =>
      platformApi.transition(o.id, input.command, input.reason || null, key),
    { invalidate, onSuccess: () => setCommand(null) },
  );
  const reissueCmd = useStaffCommand(
    (_: object, key: string) => platformApi.reissueOwnerPassword(o.id, key),
    {
      successMessage: null,
      invalidate,
      onSuccess: (r) => {
        setReissue(false);
        setPassword({ value: r.temporary_password });
      },
    },
  );

  return (
    <div className="st-page" data-testid="platform-operator">
      {back}
      <div className="st-head">
        <div className="st-head__title">
          <h1 className="pt-page-title">{o.name_ar}</h1>
          <OperatorStatusChip status={o.operator_status} />
        </div>
        {commands.length ? (
          <div className="st-head__actions">
            {commands.map((c) => (
              <Button
                key={c}
                compact
                variant={commandIsDestructive(c) ? 'danger' : 'secondary'}
                iconStart={COMMAND_ICON[c]}
                disabled={!online}
                onClick={() => {
                  transition.reset();
                  setCommand(c);
                }}
              >
                {p03.action[c]}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
      {o.operator_status === 'terminated' ? (
        <p className="m-0 text-sm text-text-muted">{p03.terminatedNote}</p>
      ) : null}

      <Card>
        <dl className="pt-kv">
          <dt>{p03.legalName}</dt>
          <dd>{o.legal_name ?? '—'}</dd>
          <dt>{p03.crNumber}</dt>
          <dd>
            <bdi dir="ltr" className="pt-num">
              {o.cr_number ?? '—'}
            </bdi>
          </dd>
          <dt>{p03.vatNumber}</dt>
          <dd>
            <bdi dir="ltr" className="pt-num">
              {o.vat_number ?? '—'}
            </bdi>
          </dd>
          <dt>{p03.createdAt}</dt>
          <dd>{formatDateTime(o.created_at)}</dd>
          <dt>{p03.owner}</dt>
          <dd>
            {o.owner ? (
              <>
                {o.owner.full_name} ·{' '}
                <bdi dir="ltr" className="pt-num">
                  {o.owner.employee_code} · {o.owner.phone_masked}
                </bdi>
                <span className="block text-sm text-text-muted">
                  {o.owner.last_login_at
                    ? fmt(p03.ownerSignedIn, { time: formatDateTime(o.owner.last_login_at) })
                    : p03.ownerPending}
                </span>
              </>
            ) : (
              p03.noOwner
            )}
          </dd>
        </dl>
        {manage && o.owner?.temporary_password_reissuable && o.operator_status !== 'terminated' ? (
          <Button
            variant="secondary"
            compact
            iconStart={KeyRound}
            disabled={!online}
            onClick={() => {
              reissueCmd.reset();
              setReissue(true);
            }}
          >
            {p03.reissue}
          </Button>
        ) : null}
      </Card>

      <Section title={p03.venues}>
        {o.venues.length ? (
          <ul className="st-stack">
            {o.venues.map((v) => (
              <li key={v.id}>
                <span>
                  <bdi dir="ltr" className="pt-num">
                    {v.code}
                  </bdi>{' '}
                  · {v.name_ar}
                  {v.city ? ` · ${v.city}` : ''}
                </span>
                <SetupStatusChip status={v.status} />
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title={p03.noVenues} />
        )}
      </Section>

      <ContractsSection
        orgId={o.id}
        manage={manage && o.operator_status !== 'terminated'}
        online={online}
        onAdd={() => setAddingContract(true)}
        onEnd={setEnding}
      />
      <UsersSection orgId={o.id} />

      <Section title={p03.history}>
        {o.status_history.length ? (
          <ul className="st-stack">
            {o.status_history.map((h, i) => (
              <li key={`${h.action}-${h.occurred_at}-${i}`}>
                <span className="font-bold">
                  {fmt(p03.historyLine, {
                    action: (p03.historyAction as Record<string, string>)[h.action] ?? h.action,
                    time: formatDateTime(h.occurred_at),
                    actor: h.actor?.full_name ?? '—',
                  })}
                </span>
                {h.reason ? <span className="text-sm text-text-muted">{h.reason}</span> : null}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title={p03.noHistory} />
        )}
      </Section>

      {command ? (
        <ReasonDialog
          id={`operator-${command}`}
          open
          onOpenChange={(open) => (open ? undefined : setCommand(null))}
          title={p03.action[command]}
          body={fmt(p03.confirm[command], { name: o.name_ar })}
          confirmLabel={p03.action[command]}
          destructive={commandIsDestructive(command)}
          withReason={commandNeedsReason(command)}
          pending={transition.pending}
          error={transition.message}
          reasonError={transition.fields.reason ?? null}
          onConfirm={(reason) => transition.run({ command, reason })}
        />
      ) : null}
      <ReasonDialog
        id="operator-reissue"
        open={reissue}
        onOpenChange={setReissue}
        title={p03.reissue}
        body={p03.reissueBody}
        confirmLabel={p03.reissue}
        withReason={false}
        pending={reissueCmd.pending}
        error={reissueCmd.message}
        onConfirm={() => reissueCmd.run({})}
      />
      <OneTimePasswordDialog
        id="operator-password"
        open={password !== null}
        title={p03.reissue}
        password={password?.value ?? null}
        owner={o.owner}
        replayedText={p02.created.replayed}
        onClose={() => setPassword(null)}
      />
      {manage ? (
        <>
          <CreateContractSheet orgId={o.id} open={addingContract} onOpenChange={setAddingContract} />
          <EndContractSheet orgId={o.id} contract={ending} onClose={() => setEnding(null)} />
        </>
      ) : null}
    </div>
  );
}

const CONTRACT_TONE = { upcoming: 'info', current: 'success', ended: 'neutral' } as const;

function ContractsSection({
  orgId,
  manage,
  online,
  onAdd,
  onEnd,
}: {
  orgId: string;
  manage: boolean;
  online: boolean;
  onAdd: () => void;
  onEnd: (c: OperatorContract) => void;
}) {
  const list = useQuery({
    queryKey: platformKeys.contracts(orgId),
    queryFn: ({ signal }) => platformApi.contracts(orgId, signal),
  });
  return (
    <Section
      title={p03.contracts}
      actions={
        manage ? (
          <Button compact iconStart={FileSignature} disabled={!online} onClick={onAdd}>
            {p03.addContract}
          </Button>
        ) : null
      }
    >
      {list.isError && !list.data ? (
        <QueryError error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data && !list.data.length ? (
        <EmptyState title={p03.noContracts} />
      ) : (
        <DataTable
          layout="auto"
          loading={list.isPending}
          rows={list.data ?? []}
          rowKey={(c) => c.id}
          columns={[
            {
              key: 'period',
              label: p03.startsOn,
              render: (c) => (
                <bdi dir="ltr" className="pt-num">
                  {contractPeriod(c)}
                </bdi>
              ),
            },
            {
              key: 'state',
              label: p02.status,
              render: (c) => (
                <StateChip
                  label={p03.contractState[c.state]}
                  tone={CONTRACT_TONE[c.state]}
                  icon={FileSignature}
                />
              ),
            },
            {
              key: 'fee',
              label: p03.saasFee,
              render: (c) => `${formatHalalas(c.saas_fee_halalas_per_venue)} · ${p03.cycle[c.saas_cycle]}`,
            },
            {
              key: 'payout',
              label: p03.payout,
              render: (c) => formatHalalas(c.subscriber_visit_payout_halalas),
            },
            {
              key: 'commission',
              label: p03.commission,
              render: (c) => (
                <bdi dir="ltr" className="pt-num">
                  {bpToPercent(c.app_payment_commission_bp)}
                </bdi>
              ),
            },
            {
              key: 'end',
              label: p03.endContract,
              render: (c) =>
                manage && c.state !== 'ended' ? (
                  <Button
                    variant="secondary"
                    compact
                    iconStart={CalendarX}
                    disabled={!online}
                    onClick={() => onEnd(c)}
                  >
                    {p03.endContract}
                  </Button>
                ) : null,
            },
          ]}
        />
      )}
    </Section>
  );
}

function UsersSection({ orgId }: { orgId: string }) {
  const list = useQuery({
    queryKey: platformKeys.users(orgId),
    queryFn: ({ signal }) => platformApi.users(orgId, signal),
  });
  return (
    <Section title={p03.users}>
      {list.isError && !list.data ? (
        <QueryError error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data && !list.data.length ? (
        <EmptyState title={p03.noUsers} />
      ) : (
        <DataTable
          layout="auto"
          loading={list.isPending}
          rows={list.data ?? []}
          rowKey={(u) => u.id}
          columns={[
            {
              key: 'name',
              label: p02.name,
              render: (u) => (
                <span>
                  {u.full_name} ·{' '}
                  <bdi dir="ltr" className="pt-num">
                    {u.employee_code}
                  </bdi>
                </span>
              ),
            },
            { key: 'role', label: p03.role, render: (u) => staffRole[u.role] ?? u.role },
            {
              key: 'phone',
              label: p03.phone,
              render: (u) => (
                <bdi dir="ltr" className="pt-num">
                  {u.phone_masked}
                </bdi>
              ),
            },
            { key: 'status', label: p02.status, render: (u) => <UserStatusChip status={u.status} /> },
            {
              key: 'last',
              label: p03.lastLogin,
              render: (u) => (u.last_login_at ? formatDateTime(u.last_login_at) : p03.never),
            },
          ]}
        />
      )}
    </Section>
  );
}

const CONTRACT_ISSUE = {
  amount: p03.amountInvalid,
  percent: p03.percentInvalid,
  date: p03.dateInvalid,
  end_before_start: p03.endBeforeStart,
} as const;

const BLANK_CONTRACT: ContractForm = {
  saas_fee: '',
  saas_cycle: 'monthly',
  payout: '',
  commission: '',
  starts_on: '',
  ends_on: '',
};

function CreateContractSheet({
  orgId,
  open,
  onOpenChange,
}: {
  orgId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [form, setForm] = useState<ContractForm>(BLANK_CONTRACT);
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);
  useEffect(() => {
    if (open) {
      setForm(BLANK_CONTRACT);
      setErrors(NO_ERRORS);
    }
  }, [open]);
  const cmd = useStaffCommand(
    (body: Parameters<typeof platformApi.createContract>[1], key: string) =>
      platformApi.createContract(orgId, body, key),
    {
      invalidate: [platformKeys.contracts(orgId), platformKeys.operator(orgId), platformKeys.operators],
      onSuccess: () => onOpenChange(false),
    },
  );
  useEffect(() => {
    if (cmd.error) setErrors(toFormErrors(cmd.error));
  }, [cmd.error]);
  const set = (k: keyof ContractForm) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  const submit = async () => {
    const v = validateContractForm(form);
    if (!v.ok) {
      setErrors({
        form: null,
        requestId: null,
        fields: Object.fromEntries(Object.entries(v.issues).map(([k, i]) => [k, CONTRACT_ISSUE[i]])),
      });
      return;
    }
    setErrors(NO_ERRORS);
    await cmd.run(v.body);
  };
  return (
    <FormSheet
      id="contract-form"
      open={open}
      onOpenChange={onOpenChange}
      title={p03.addContract}
      submitLabel={p03.addContract}
      onSubmit={submit}
      pending={cmd.pending}
      errors={errors}
    >
      <TextField
        id="contract-fee"
        label={p03.saasFee}
        inputMode="decimal"
        dir="ltr"
        value={form.saas_fee}
        error={fieldError(errors, 'saas_fee_halalas_per_venue')}
        onChange={set('saas_fee')}
      />
      <Radio
        name="contract-cycle"
        legend={p03.cycleLabel}
        value={form.saas_cycle}
        onChange={(v) => setForm((f) => ({ ...f, saas_cycle: v as ContractForm['saas_cycle'] }))}
        options={[
          ['monthly', p03.cycle.monthly],
          ['yearly', p03.cycle.yearly],
        ]}
      />
      <TextField
        id="contract-payout"
        label={p03.payout}
        inputMode="decimal"
        dir="ltr"
        value={form.payout}
        error={fieldError(errors, 'subscriber_visit_payout_halalas')}
        onChange={set('payout')}
      />
      <TextField
        id="contract-commission"
        label={p03.commission}
        inputMode="decimal"
        dir="ltr"
        value={form.commission}
        error={fieldError(errors, 'app_payment_commission_bp')}
        onChange={set('commission')}
      />
      <TextField
        id="contract-starts"
        type="date"
        label={p03.startsOn}
        dir="ltr"
        value={form.starts_on}
        error={fieldError(errors, 'starts_on')}
        onChange={set('starts_on')}
      />
      <TextField
        id="contract-ends"
        type="date"
        label={p03.endsOn}
        dir="ltr"
        value={form.ends_on}
        error={fieldError(errors, 'ends_on')}
        onChange={set('ends_on')}
      />
    </FormSheet>
  );
}

function EndContractSheet({
  orgId,
  contract,
  onClose,
}: {
  orgId: string;
  contract: OperatorContract | null;
  onClose: () => void;
}) {
  const [endsOn, setEndsOn] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);
  useEffect(() => {
    setEndsOn('');
    setReason('');
    setErrors(NO_ERRORS);
  }, [contract?.id]);
  const cmd = useStaffCommand(
    (input: { id: string; ends_on: string; reason: string }, key: string) =>
      platformApi.endContract(orgId, input.id, { ends_on: input.ends_on, reason: input.reason || null }, key),
    {
      invalidate: [platformKeys.contracts(orgId), platformKeys.operator(orgId), platformKeys.operators],
      onSuccess: onClose,
    },
  );
  useEffect(() => {
    if (cmd.error) setErrors(toFormErrors(cmd.error));
  }, [cmd.error]);
  if (!contract) return null;
  return (
    <FormSheet
      id="contract-end"
      open
      onOpenChange={(o) => (o ? undefined : onClose())}
      title={p03.endContract}
      submitLabel={p03.endContract}
      pending={cmd.pending}
      errors={errors}
      onSubmit={async () => {
        if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(endsOn)) {
          setErrors({ form: null, requestId: null, fields: { ends_on: p03.dateInvalid } });
          return;
        }
        await cmd.run({ id: contract.id, ends_on: endsOn, reason: reason.trim() });
      }}
    >
      <p className="m-0 text-sm text-text-muted">{p03.endContractBody}</p>
      <p className="m-0">
        <bdi dir="ltr" className="pt-num">
          {contractPeriod(contract)}
        </bdi>
      </p>
      <TextField
        id="contract-end-date"
        type="date"
        label={p03.endsOnRequired}
        dir="ltr"
        value={endsOn}
        error={fieldError(errors, 'ends_on')}
        onChange={(e) => setEndsOn(e.target.value)}
      />
      <TextField
        id="contract-end-reason"
        label={p03.reasonOptional}
        value={reason}
        maxLength={500}
        onChange={(e) => setReason(e.target.value)}
      />
    </FormSheet>
  );
}
