import { useQuery } from '@tanstack/react-query';
import { Building2, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { ApiError } from '@/api/errors';
import { platformApi, platformKeys, type CreatedOperator } from '@/api/platform';
import { platformOperatorPath } from '@/app/paths';
import { Button, DataTable, EmptyState, PhoneInput, Radio, TextField } from '@/components';
import { FormSheet } from '@/features/common/FormSheet';
import { fieldError, NO_ERRORS, toFormErrors, type FormErrors } from '@/features/common/formErrors';
import { QueryError } from '@/features/supervisor/ui';
import { useStaffCommand } from '@/features/supervisor/useStaffCommand';
import { useOnline } from '@/hooks/useOnline';
import { errorMessagesAr } from '@/i18n/errors';
import { p02, p03 } from '@/i18n/ar.staff';
import { usePlatformAccount } from './PlatformLayout';
import { OperatorStatusChip, OneTimePasswordDialog, contractLine } from './platformUi';
import { BLANK_OPERATOR, platformCan, validateOperatorForm, type OperatorForm } from './platformModel';

/**
 * P-02 «المشغلون» (V2-003, docs/v2/02 §2): every operator with its status, venues, staff and current contract;
 * «إضافة مشغل» (owner/admin, `platform.operator_manage`) creates the organization and its first owner and shows the
 * owner's temporary password once, with a copy button — never stored in the browser (props only).
 */
export function PlatformOperatorsPage() {
  const me = usePlatformAccount();
  const online = useOnline();
  const navigate = useNavigate();
  const list = useQuery({
    queryKey: platformKeys.operators,
    queryFn: ({ signal }) => platformApi.operators(signal),
    enabled: platformCan(me, 'platform.operator_read'),
  });
  const [adding, setAdding] = useState(false);
  const [created, setCreated] = useState<CreatedOperator | null>(null);
  const manage = platformCan(me, 'platform.operator_manage');

  if (!platformCan(me, 'platform.operator_read'))
    return <EmptyState icon={Building2} title={errorMessagesAr.PERMISSION_DENIED} />;

  return (
    <div className="st-page" data-testid="platform-operators">
      <div className="st-head">
        <h1 className="pt-page-title">{p02.title}</h1>
        {manage ? (
          <div className="st-head__actions">
            <Button compact iconStart={Plus} disabled={!online} onClick={() => setAdding(true)}>
              {p02.add}
            </Button>
          </div>
        ) : null}
      </div>
      {list.isError && !list.data ? (
        <QueryError error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data && !list.data.length ? (
        <EmptyState icon={Building2} title={p02.empty} />
      ) : (
        <DataTable
          layout="auto"
          loading={list.isPending}
          rows={list.data ?? []}
          rowKey={(o) => o.id}
          columns={[
            {
              key: 'name',
              label: p02.name,
              render: (o) => (
                <span>
                  <span className="font-bold">{o.name_ar}</span>
                  {o.legal_name ? (
                    <span className="block text-sm text-text-muted">{o.legal_name}</span>
                  ) : null}
                </span>
              ),
            },
            {
              key: 'status',
              label: p02.status,
              render: (o) => <OperatorStatusChip status={o.operator_status} />,
            },
            {
              key: 'venues',
              label: p02.venues,
              render: (o) => (
                <bdi dir="ltr" className="pt-num">
                  {o.active_venues_count}/{o.venues_count}
                </bdi>
              ),
            },
            {
              key: 'staff',
              label: p02.staff,
              render: (o) => (
                <bdi dir="ltr" className="pt-num">
                  {o.staff_count}
                </bdi>
              ),
            },
            {
              key: 'contract',
              label: p02.contract,
              render: (o) => (o.current_contract ? contractLine(o.current_contract) : p02.noContract),
            },
            {
              key: 'open',
              label: p02.open,
              render: (o) => (
                <Button variant="secondary" compact onClick={() => navigate(platformOperatorPath(o.id))}>
                  {p02.open}
                </Button>
              ),
            },
          ]}
        />
      )}
      {manage ? <CreateOperatorSheet open={adding} onOpenChange={setAdding} onCreated={setCreated} /> : null}
      <OneTimePasswordDialog
        id="operator-created"
        open={created !== null}
        title={created ? p02.created.title.replace('{name}', created.operator.name_ar) : ''}
        password={created?.temporary_password ?? null}
        owner={created?.owner ?? null}
        replayedText={p02.created.replayed}
        actionLabel={p02.created.openOperator}
        onAction={() => {
          const id = created?.operator.id;
          setCreated(null);
          if (id) navigate(platformOperatorPath(id));
        }}
        onClose={() => setCreated(null)}
      />
    </div>
  );
}

const ISSUE_TEXT = {
  required: p02.form.required,
  cr_invalid: p02.form.crInvalid,
  vat_invalid: p02.form.vatInvalid,
  phone_invalid: errorMessagesAr.PHONE_INVALID,
} as const;

/** «إضافة مشغل»: `POST /v1/platform/operators` once (Idempotency-Key per intent); the password goes to the dialog. */
function CreateOperatorSheet({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (created: CreatedOperator) => void;
}) {
  const [form, setForm] = useState<OperatorForm>(BLANK_OPERATOR);
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);
  useEffect(() => {
    if (open) {
      setForm(BLANK_OPERATOR);
      setErrors(NO_ERRORS);
    }
  }, [open]);
  const cmd = useStaffCommand(
    (body: Parameters<typeof platformApi.createOperator>[0], key: string) =>
      platformApi.createOperator(body, key),
    {
      successMessage: null,
      invalidate: [platformKeys.operators, platformKeys.overview],
      onSuccess: (result) => {
        onOpenChange(false);
        onCreated(result);
      },
    },
  );
  useEffect(() => {
    if (!cmd.error) return;
    const e = toFormErrors(cmd.error, { PHONE_INVALID: 'owner.phone' });
    // DEC-476 / DEC-485: a phone of another operator's staff — say why, not only «invalid»
    if (
      cmd.error instanceof ApiError &&
      cmd.error.fields.some((f) => f.field === 'owner.phone' && f.issue === 'in_use_by_another_operator')
    )
      e.fields['owner.phone'] = p02.form.phoneInUse;
    setErrors(e);
  }, [cmd.error]);
  const set = (k: keyof OperatorForm) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  const submit = async () => {
    const v = validateOperatorForm(form);
    if (!v.ok) {
      setErrors({
        form: null,
        requestId: null,
        fields: Object.fromEntries(Object.entries(v.issues).map(([k, i]) => [k, ISSUE_TEXT[i]])),
      });
      return;
    }
    setErrors(NO_ERRORS);
    await cmd.run(v.body);
  };
  return (
    <FormSheet
      id="operator-form"
      open={open}
      onOpenChange={onOpenChange}
      title={p02.add}
      submitLabel={p02.add}
      onSubmit={submit}
      pending={cmd.pending}
      errors={errors}
    >
      <TextField
        id="operator-name-ar"
        label={p02.form.nameAr}
        value={form.name_ar}
        maxLength={120}
        error={fieldError(errors, 'name_ar')}
        onChange={set('name_ar')}
      />
      <TextField
        id="operator-name-en"
        label={p02.form.nameEn}
        dir="ltr"
        value={form.name_en}
        maxLength={120}
        error={fieldError(errors, 'name_en')}
        onChange={set('name_en')}
      />
      <TextField
        id="operator-legal-name"
        label={p02.form.legalName}
        value={form.legal_name}
        maxLength={200}
        error={fieldError(errors, 'legal_name')}
        onChange={set('legal_name')}
      />
      <TextField
        id="operator-cr"
        label={p02.form.crNumber}
        inputMode="numeric"
        dir="ltr"
        value={form.cr_number}
        maxLength={10}
        error={fieldError(errors, 'cr_number')}
        onChange={set('cr_number')}
      />
      <TextField
        id="operator-vat"
        label={p02.form.vatNumber}
        inputMode="numeric"
        dir="ltr"
        value={form.vat_number}
        maxLength={15}
        error={fieldError(errors, 'vat_number')}
        onChange={set('vat_number')}
      />
      <Radio
        name="operator-status"
        legend={p02.form.status}
        value={form.operator_status}
        onChange={(v) => setForm((f) => ({ ...f, operator_status: v as OperatorForm['operator_status'] }))}
        options={[
          ['trial', p02.form.statusTrial],
          ['active', p02.form.statusActive],
        ]}
      />
      <h2 className="pt-section-title">{p02.form.ownerSection}</h2>
      <TextField
        id="operator-owner-name"
        label={p02.form.ownerName}
        value={form.owner_name}
        maxLength={80}
        error={fieldError(errors, 'owner.full_name')}
        onChange={set('owner_name')}
      />
      <PhoneInput
        id="operator-owner-phone"
        label={p02.form.ownerPhone}
        value={form.owner_phone}
        error={fieldError(errors, 'owner.phone')}
        onChange={set('owner_phone')}
      />
      <p className="m-0 text-sm text-text-muted">{p03.reissueBody}</p>
    </FormSheet>
  );
}
