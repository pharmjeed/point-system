import { useQuery } from '@tanstack/react-query';
import { MapPin, Pencil, Plus, ShieldOff, UserCheck, UserX } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { CustodyItem, Me, Venue } from '@/api/types';
import type { CreatedStaff, StaffMember } from '@/api/types.staff';
import {
  Button,
  Checkbox,
  DataTable,
  Dialog,
  EmptyState,
  FieldError,
  FilterChips,
  ListItem,
  PhoneInput,
  Radio,
  SearchField,
  Sheet,
  TextField,
} from '@/components';
import { FormSheet } from '@/features/common/FormSheet';
import { fieldError, NO_ERRORS, toFormErrors, type FormErrors } from '@/features/common/formErrors';
import { UserStatusChip } from '@/features/common/StateChip';
import { commands, fetchStaffMembers, staffKeys } from '@/features/supervisor/staffApi';
import { useVenues } from '@/features/supervisor/selection';
import { QueryError, ReasonDialog } from '@/features/supervisor/ui';
import { useStaffCommand } from '@/features/supervisor/useStaffCommand';
import { CustodyItemList } from '@/features/venues/BlockingList';
import { useOnline } from '@/hooks/useOnline';
import { buttons, ui, userStatus } from '@/i18n/ar';
import { s03, s05, s06, s13, staff, staffRole } from '@/i18n/ar.staff';
import { errorMessagesAr } from '@/i18n/errors';
import { fmt } from '@/i18n/fmt';
import { formatDateTime } from '@/lib/format';
import { normalizeSaudiMobile } from '@/lib/phone';
import {
  creatableRoles,
  filterMembers,
  hasOrgScope,
  scopeChange,
  scopeText,
  staffActions,
  venueScopeIds,
  type StaffAction,
  type StaffFilters,
  type StaffRole,
} from './staffModel';

/**
 * S-13 «الموظفون» (GAP-3; 02 S-13 table and §2.2; 07 §2.6; canon §10 `staff.manage`): the supervisors and the
 * administration this account may manage (`GET /v1/staff` is already narrowed: the owner sees both, an admin the
 * supervisors), «إضافة موظف» (name, phone, role, «يسمح بالقيادة», scopes; the temporary password shown once),
 * edit, venue scopes (supervisors) or the org scope (the administration, owner only), disable / enable with a
 * reason, and «إعادة ضبط التحقق الثنائي» for the owner. Every command carries its Idempotency-Key and the
 * server's `message_ar` is shown on a refusal.
 */
export function StaffSection({ me }: { me: Me }) {
  const online = useOnline();
  const list = useQuery({
    queryKey: staffKeys.staffMembers(),
    queryFn: ({ signal }) => fetchStaffMembers(signal),
  });
  const venues = useVenues();
  const venueList = venues.data?.items ?? [];
  const roles = creatableRoles(me);
  const [filters, setFilters] = useState<StaffFilters>({ role: 'all', status: 'all', q: '' });
  const [adding, setAdding] = useState(false);
  const [created, setCreated] = useState<CreatedStaff | null>(null);
  const [selected, setSelected] = useState<StaffMember | null>(null);
  const [action, setAction] = useState<{ action: StaffAction; member: StaffMember } | null>(null);
  const rows = filterMembers(list.data ?? [], filters);
  const scopeLabels = { all: s13.staff.allVenues, none: s13.staff.noScope };
  const closeAction = () => setAction(null);

  return (
    <div className="st-section" data-testid="staff-section">
      {roles.length ? (
        <div className="st-row-actions">
          <Button compact iconStart={Plus} disabled={!online} onClick={() => setAdding(true)}>
            {s13.staff.add}
          </Button>
        </div>
      ) : null}
      <SearchField
        id="staff-search"
        value={filters.q}
        onChange={(q) => setFilters((f) => ({ ...f, q }))}
        placeholder={s13.staff.search}
        label={s13.staff.search}
      />
      {roles.length > 1 ? (
        <FilterChips
          label={s13.staff.role}
          value={[filters.role]}
          onChange={(next) =>
            setFilters((f) => ({
              ...f,
              role: (next.find((v) => v !== f.role) as StaffFilters['role'] | undefined) ?? 'all',
            }))
          }
          options={[
            { value: 'all', label: s13.staff.all },
            { value: 'admin', label: staffRole.admin },
            { value: 'supervisor', label: staffRole.supervisor },
          ]}
        />
      ) : null}
      <FilterChips
        label={staff.status}
        value={[filters.status]}
        onChange={(next) =>
          setFilters((f) => ({
            ...f,
            status: (next.find((v) => v !== f.status) as StaffFilters['status'] | undefined) ?? 'all',
          }))
        }
        options={[
          { value: 'all', label: s13.staff.all },
          { value: 'active', label: userStatus.active },
          { value: 'disabled', label: userStatus.disabled },
        ]}
      />
      {list.isError && !list.data ? (
        <QueryError error={list.error} onRetry={() => void list.refetch()} />
      ) : null}
      {list.data && !rows.length ? (
        <EmptyState title={s13.staff.empty} />
      ) : (
        <DataTable
          layout="auto"
          loading={list.isPending}
          rows={rows}
          rowKey={(m) => m.user.id}
          columns={[
            {
              key: 'name',
              label: s05.fullName,
              render: (m) => (
                <span>
                  {m.user.full_name} ·{' '}
                  <bdi dir="ltr" className="pt-num">
                    {m.user.employee_code}
                  </bdi>
                </span>
              ),
            },
            { key: 'role', label: s13.staff.role, render: (m) => staffRole[m.user.role] ?? m.user.role },
            { key: 'status', label: staff.status, render: (m) => <UserStatusChip status={m.user.status} /> },
            {
              key: 'scopes',
              label: s13.staff.scopes,
              render: (m) => scopeText(m.scopes, venueList, scopeLabels),
            },
            {
              key: 'can_drive',
              label: s13.staff.canDrive,
              render: (m) =>
                m.user.role === 'supervisor' ? (m.user.can_drive ? staff.yes : staff.no) : staff.none,
            },
            {
              key: 'mfa',
              label: s13.staff.mfa,
              render: (m) => (m.user.mfa_enabled ? s13.staff.mfaOn : s13.staff.mfaOff),
            },
            {
              key: 'last_login',
              label: s13.staff.lastLogin,
              render: (m) => (m.user.last_login_at ? formatDateTime(m.user.last_login_at) : s13.staff.never),
            },
            {
              key: 'actions',
              label: s03.actions,
              render: (m) =>
                staffActions(me, m).length ? (
                  <Button variant="secondary" compact disabled={!online} onClick={() => setSelected(m)}>
                    {s03.actions}
                  </Button>
                ) : null,
            },
          ]}
        />
      )}

      {selected ? (
        <MemberSheet
          me={me}
          member={selected}
          scopeLine={scopeText(selected.scopes, venueList, scopeLabels)}
          onClose={() => setSelected(null)}
          onAction={(a) => {
            setAction({ action: a, member: selected });
            setSelected(null);
          }}
        />
      ) : null}
      {action?.action === 'edit' ? <EditStaffSheet member={action.member} onClose={closeAction} /> : null}
      {action?.action === 'scopes' ? (
        <ScopesSheet member={action.member} venues={venueList} onClose={closeAction} />
      ) : null}
      {action?.action === 'disable' || action?.action === 'enable' ? (
        <StatusDialog member={action.member} disable={action.action === 'disable'} onClose={closeAction} />
      ) : null}
      {action?.action === 'resetMfa' ? <ResetMfaDialog member={action.member} onClose={closeAction} /> : null}
      {roles.length ? (
        <CreateStaffSheet
          open={adding}
          onOpenChange={setAdding}
          roles={roles}
          venues={venueList}
          onCreated={setCreated}
        />
      ) : null}
      <Dialog
        id="staff-temp-secret"
        open={created !== null}
        onOpenChange={(open) => {
          if (!open) setCreated(null);
        }}
        title={created?.user.full_name ?? ''}
        body={created ? fmt(s13.staff.tempSecret, { secret: created.temporary_secret }) : undefined}
        confirmLabel={buttons.gotIt}
        hideCancel
        onConfirm={() => setCreated(null)}
        onCancel={() => setCreated(null)}
      />
    </div>
  );
}

const ACTION_ICON = {
  edit: Pencil,
  scopes: MapPin,
  disable: UserX,
  enable: UserCheck,
  resetMfa: ShieldOff,
} as const;

const actionLabel = (a: StaffAction) =>
  a === 'edit'
    ? s06.edit
    : a === 'scopes'
      ? s13.staff.scopes
      : a === 'disable'
        ? s06.disable
        : a === 'enable'
          ? s06.enable
          : s13.staff.resetMfa;

function MemberSheet({
  me,
  member,
  scopeLine,
  onClose,
  onAction,
}: {
  me: Me;
  member: StaffMember;
  scopeLine: string;
  onClose: () => void;
  onAction: (a: StaffAction) => void;
}) {
  const u = member.user;
  return (
    <Sheet open onOpenChange={(o) => (o ? undefined : onClose())} title={u.full_name}>
      <dl className="pt-kv">
        <dt>{s13.staff.role}</dt>
        <dd>{staffRole[u.role] ?? u.role}</dd>
        <dt>{s06.employeeCode}</dt>
        <dd>
          <bdi dir="ltr" className="pt-num">
            {u.employee_code}
          </bdi>
        </dd>
        <dt>{s06.phone}</dt>
        <dd>
          <bdi dir="ltr" className="pt-num">
            {u.phone_e164 ?? u.phone_masked ?? staff.none}
          </bdi>
        </dd>
        <dt>{s13.staff.scopes}</dt>
        <dd>{scopeLine}</dd>
        <dt>{s13.staff.mfa}</dt>
        <dd>{u.mfa_enabled ? s13.staff.mfaOn : s13.staff.mfaOff}</dd>
        {u.status === 'disabled' && u.disabled_reason ? (
          <>
            <dt>{staff.reason}</dt>
            <dd>{u.disabled_reason}</dd>
          </>
        ) : null}
      </dl>
      <ul className="pt-list">
        {staffActions(me, member).map((a) => (
          <li key={a}>
            <ListItem icon={ACTION_ICON[a]} title={actionLabel(a)} onClick={() => onAction(a)} />
          </li>
        ))}
      </ul>
    </Sheet>
  );
}

/** «إضافة موظف»: `POST /v1/staff` once; the temporary password is shown once by the caller. */
function CreateStaffSheet({
  open,
  onOpenChange,
  roles,
  venues,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roles: StaffRole[];
  venues: Venue[];
  onCreated: (created: CreatedStaff) => void;
}) {
  const blank = { full_name: '', phone: '', role: roles[0] ?? 'supervisor', can_drive: false };
  const [form, setForm] = useState<{ full_name: string; phone: string; role: StaffRole; can_drive: boolean }>(
    blank,
  );
  const [venueIds, setVenueIds] = useState<string[]>([]);
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);
  useEffect(() => {
    if (open) {
      setForm(blank);
      setVenueIds([]);
      setErrors(NO_ERRORS);
    }
  }, [open]); // deliberately not on the roles prop
  const cmd = useStaffCommand(
    (body: Parameters<typeof commands.createStaff>[0], key: string) => commands.createStaff(body, key),
    {
      successMessage: null,
      invalidate: [staffKeys.staffMembers()],
      onSuccess: (result) => {
        onOpenChange(false);
        onCreated(result);
      },
    },
  );
  useEffect(() => {
    if (cmd.error) setErrors(toFormErrors(cmd.error, { PHONE_INVALID: 'phone' }));
  }, [cmd.error]);
  const supervisor = form.role === 'supervisor';
  const submit = async () => {
    const phone = normalizeSaudiMobile(form.phone);
    const local: Record<string, string> = {};
    if (!form.full_name.trim()) local.full_name = ui.validation;
    if (!phone) local.phone = errorMessagesAr.PHONE_INVALID;
    if (Object.keys(local).length || !phone) {
      setErrors({ form: null, requestId: null, fields: local });
      return;
    }
    setErrors(NO_ERRORS);
    await cmd.run({
      full_name: form.full_name.trim(),
      phone,
      role: form.role,
      ...(supervisor ? { can_drive: form.can_drive, venue_ids: venueIds } : {}),
    });
  };
  return (
    <FormSheet
      id="staff-form"
      open={open}
      onOpenChange={onOpenChange}
      title={s13.staff.add}
      submitLabel={s13.staff.add}
      onSubmit={submit}
      pending={cmd.pending}
      errors={errors}
    >
      <TextField
        id="staff-name"
        label={s05.fullName}
        value={form.full_name}
        maxLength={80}
        error={fieldError(errors, 'full_name')}
        onChange={(e) => setForm((f) => ({ ...f, full_name: e.target.value }))}
      />
      <PhoneInput
        id="staff-phone"
        label={s05.phone}
        value={form.phone}
        error={fieldError(errors, 'phone')}
        onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
      />
      {roles.length > 1 ? (
        <Radio
          name="staff-role"
          legend={s13.staff.role}
          options={roles.map((r) => [r, staffRole[r]] as const)}
          value={form.role}
          error={fieldError(errors, 'role')}
          onChange={(v) => setForm((f) => ({ ...f, role: v as StaffRole }))}
        />
      ) : (
        <p className="m-0">
          {s13.staff.role}: {staffRole[form.role]}
        </p>
      )}
      {supervisor ? (
        <>
          <Checkbox
            id="staff-can-drive"
            label={s13.staff.canDrive}
            hint={s13.staff.canDriveHint}
            checked={form.can_drive}
            error={fieldError(errors, 'can_drive')}
            onChange={(e) => setForm((f) => ({ ...f, can_drive: e.target.checked }))}
          />
          <VenueChecklist
            idPrefix="staff-venue"
            venues={venues}
            value={venueIds}
            onChange={setVenueIds}
            error={fieldError(errors, 'venue_ids')}
          />
        </>
      ) : (
        <p className="st-muted m-0">{s13.staff.orgScopeHint}</p>
      )}
    </FormSheet>
  );
}

function VenueChecklist({
  idPrefix,
  venues,
  value,
  onChange,
  error,
}: {
  idPrefix: string;
  venues: Venue[];
  value: string[];
  onChange: (ids: string[]) => void;
  error?: string;
}) {
  return (
    <fieldset className="st-form st-fieldset">
      <legend className="pt-section-title">{s13.staff.scopes}</legend>
      <p className="st-muted m-0">{s13.staff.venuesHint}</p>
      {venues.map((v) => (
        <Checkbox
          key={v.id}
          id={`${idPrefix}-${v.id}`}
          label={v.name_ar}
          checked={value.includes(v.id)}
          onChange={(e) => onChange(e.target.checked ? [...value, v.id] : value.filter((id) => id !== v.id))}
        />
      ))}
      {error ? <FieldError role="alert">{error}</FieldError> : null}
    </fieldset>
  );
}

/** «تعديل البيانات»: name, phone, «يسمح بالقيادة» (supervisors) — `PATCH /v1/staff/{userId}` with `expected_version`. */
function EditStaffSheet({ member, onClose }: { member: StaffMember; onClose: () => void }) {
  const u = member.user;
  const [form, setForm] = useState({
    full_name: u.full_name,
    phone: u.phone_e164 ?? '',
    can_drive: !!u.can_drive,
  });
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);
  const cmd = useStaffCommand(
    (body: Parameters<typeof commands.patchStaff>[1], key: string) => commands.patchStaff(u.id, body, key),
    {
      successMessage: ui.saved,
      invalidate: [staffKeys.staffMembers()],
      onSuccess: onClose,
      onPermissionDenied: onClose,
    },
  );
  useEffect(() => {
    if (cmd.error) setErrors(toFormErrors(cmd.error, { PHONE_INVALID: 'phone' }));
  }, [cmd.error]);
  const submit = async () => {
    const local: Record<string, string> = {};
    if (!form.full_name.trim()) local.full_name = ui.validation;
    const phone = form.phone.trim() ? normalizeSaudiMobile(form.phone) : null;
    if (form.phone.trim() && !phone) local.phone = errorMessagesAr.PHONE_INVALID;
    if (Object.keys(local).length) {
      setErrors({ form: null, requestId: null, fields: local });
      return;
    }
    setErrors(NO_ERRORS);
    const body: Parameters<typeof commands.patchStaff>[1] = { expected_version: u.version };
    if (form.full_name.trim() !== u.full_name) body.full_name = form.full_name.trim();
    if (phone && phone !== u.phone_e164) body.phone = phone;
    if (u.role === 'supervisor' && form.can_drive !== !!u.can_drive) body.can_drive = form.can_drive;
    await cmd.run(body);
  };
  return (
    <FormSheet
      id="staff-edit-form"
      open
      onOpenChange={(o) => (o ? undefined : onClose())}
      title={s06.edit}
      submitLabel={buttons.save}
      onSubmit={submit}
      pending={cmd.pending}
      errors={errors}
    >
      <TextField
        id="staff-edit-name"
        label={s05.fullName}
        value={form.full_name}
        maxLength={80}
        error={fieldError(errors, 'full_name')}
        onChange={(e) => setForm((f) => ({ ...f, full_name: e.target.value }))}
      />
      <PhoneInput
        id="staff-edit-phone"
        label={s05.phone}
        value={form.phone}
        error={fieldError(errors, 'phone')}
        onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
      />
      {u.role === 'supervisor' ? (
        <Checkbox
          id="staff-edit-can-drive"
          label={s13.staff.canDrive}
          hint={s13.staff.canDriveHint}
          checked={form.can_drive}
          error={fieldError(errors, 'can_drive')}
          onChange={(e) => setForm((f) => ({ ...f, can_drive: e.target.checked }))}
        />
      ) : null}
    </FormSheet>
  );
}

/**
 * «النطاقات»: venue scopes of a supervisor (grant/revoke the difference) or the org scope of an admin (the owner
 * only manages admins) — `POST /v1/staff/{userId}/scopes`, audited; a revoked venue leaves its rooms at once.
 */
function ScopesSheet({
  member,
  venues,
  onClose,
}: {
  member: StaffMember;
  venues: Venue[];
  onClose: () => void;
}) {
  const current = venueScopeIds(member.scopes);
  const admin = member.user.role === 'admin';
  const [ids, setIds] = useState<string[]>(current);
  const [org, setOrg] = useState(hasOrgScope(member.scopes));
  const cmd = useStaffCommand(
    (body: Parameters<typeof commands.updateStaffScopes>[1], key: string) =>
      commands.updateStaffScopes(member.user.id, body, key),
    { invalidate: [staffKeys.staffMembers()], onSuccess: onClose, onPermissionDenied: onClose },
  );
  const change = scopeChange(current, ids);
  const dirty = admin
    ? org !== hasOrgScope(member.scopes)
    : change.grant_venue_ids.length > 0 || change.revoke_venue_ids.length > 0;
  return (
    <Sheet
      open
      onOpenChange={(o) => (o ? undefined : onClose())}
      title={`${s13.staff.scopes} · ${member.user.full_name}`}
    >
      <div className="st-form">
        {admin ? (
          <>
            <Checkbox
              id="staff-org-scope"
              label={s13.staff.allVenues}
              checked={org}
              onChange={(e) => setOrg(e.target.checked)}
            />
            <p className="st-muted m-0">{s13.staff.orgScopeHint}</p>
          </>
        ) : (
          <VenueChecklist idPrefix="staff-scope" venues={venues} value={ids} onChange={setIds} />
        )}
        {cmd.message ? <FieldError role="alert">{cmd.message}</FieldError> : null}
        <Button
          fullWidth
          loading={cmd.pending}
          disabled={!dirty}
          onClick={() => void cmd.run(admin ? { org_scope: org } : change)}
        >
          {buttons.save}
        </Button>
      </div>
    </Sheet>
  );
}

/** «تعطيل الحساب» / «تفعيل الحساب» with a reason (the server asks one for any status change); CUSTODY_OPEN lists the items. */
function StatusDialog({
  member,
  disable,
  onClose,
}: {
  member: StaffMember;
  disable: boolean;
  onClose: () => void;
}) {
  const cmd = useStaffCommand(
    (reason: string, key: string) =>
      commands.patchStaff(
        member.user.id,
        { expected_version: member.user.version, status: disable ? 'disabled' : 'active', reason },
        key,
      ),
    {
      successMessage: ui.saved,
      invalidate: [staffKeys.staffMembers()],
      onSuccess: onClose,
      onPermissionDenied: onClose,
    },
  );
  const items =
    cmd.apiError?.code === 'CUSTODY_OPEN' && Array.isArray(cmd.apiError.details.items)
      ? (cmd.apiError.details.items as CustodyItem[])
      : [];
  return (
    <ReasonDialog
      open
      onOpenChange={(o) => (o ? undefined : onClose())}
      title={disable ? s06.disable : s06.enable}
      body={member.user.full_name}
      destructive={disable}
      confirmLabel={disable ? s06.disable : s06.enable}
      pending={cmd.pending}
      error={cmd.message}
      reasonError={cmd.fields.reason}
      onConfirm={(reason) => cmd.run(reason)}
      id={disable ? 'staff-disable' : 'staff-enable'}
    >
      {items.length ? <CustodyItemList items={items} /> : null}
    </ReasonDialog>
  );
}

/** «إعادة ضبط التحقق الثنائي» — the owner only (09 §9.1): clears MFA, ends the sessions (`admin`), reason required. */
function ResetMfaDialog({ member, onClose }: { member: StaffMember; onClose: () => void }) {
  const cmd = useStaffCommand(
    (reason: string, key: string) => commands.resetStaffMfa(member.user.id, { reason }, key),
    { invalidate: [staffKeys.staffMembers()], onSuccess: onClose, onPermissionDenied: onClose },
  );
  return (
    <ReasonDialog
      open
      onOpenChange={(o) => (o ? undefined : onClose())}
      title={s13.staff.resetMfa}
      body={fmt(s13.staff.resetMfaConfirm, { name: member.user.full_name })}
      destructive
      confirmLabel={s13.staff.resetMfa}
      pending={cmd.pending}
      error={cmd.message}
      reasonError={cmd.fields.reason}
      onConfirm={(reason) => cmd.run(reason)}
      id="staff-reset-mfa"
    />
  );
}
