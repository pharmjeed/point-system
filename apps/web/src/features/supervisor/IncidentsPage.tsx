import { useQuery } from '@tanstack/react-query';
import { FilePlusCorner, FileExclamationPoint } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import type { Incident, IncidentSeverity, IncidentStatus, IncidentType, Me } from '@/api/types';
import { paths } from '@/app/paths';
import {
  Button,
  Card,
  EmptyState,
  FieldError,
  FilterChips,
  Header,
  ListItem,
  Radio,
  Select,
  TextArea,
} from '@/components';
import { useStaffMe } from '@/features/ops/StaffLayout';
import { useOnline } from '@/hooks/useOnline';
import { buttons, incidentSeverity, incidentStatus, incidentType } from '@/i18n/ar';
import { s12, staff } from '@/i18n/ar.staff';
import { fmt } from '@/i18n/fmt';
import { formatDateTime } from '@/lib/format';
import {
  editFrom,
  incidentEditError,
  incidentPatch,
  INCIDENT_NEXT,
  needsResolution,
  type IncidentEdit,
} from './incidentModel';
import { can } from './permissions';
import { useOpsSelection } from './selection';
import { commands, fetchIncident, fetchIncidents, LIVE_REFETCH_MS, staffKeys } from './staffApi';
import { staffPaths } from './staffPaths';
import { IncidentDialog } from './TicketActions';
import { Fact, ForbiddenPage, PageSkeleton, ReadError, Section } from './ui';
import { useStaffCommand } from './useStaffCommand';
import './staff.css';

const STATUSES: IncidentStatus[] = ['open', 'in_review', 'resolved', 'closed'];
const SEVERITIES: IncidentSeverity[] = ['high', 'medium', 'low'];

/**
 * S-12 — الوقائع (02 §4 S-12, PNT-083): list with status / type / severity filters (`GET /v1/incidents`;
 * severity is filtered here — the API has no severity parameter), «فتح واقعة» (`POST /v1/incidents`), and the
 * detail at `/incidents/:incidentId`. `?ticket=` / `?event=` narrow the list (from S-03 / S-10); `?create=1`
 * opens the form.
 */
export function IncidentsPage() {
  const me = useStaffMe();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const ticketId = params.get('ticket') ?? undefined;
  const eventId = params.get('event') ?? undefined;
  const sel = useOpsSelection(can(me, 'venue.read'));
  const [statuses, setStatuses] = useState<IncidentStatus[]>(['open', 'in_review']);
  const [severities, setSeverities] = useState<IncidentSeverity[]>([]);
  const [type, setType] = useState<IncidentType | ''>('');
  const [creating, setCreating] = useState(params.get('create') === '1');
  const filters = {
    venue_id: ticketId || eventId ? undefined : (sel.venueId ?? undefined),
    ticket_id: ticketId,
    event_id: eventId,
    status: statuses.length ? statuses : undefined,
    type: type || undefined,
  };
  const list = useQuery({
    queryKey: staffKeys.incidents(filters),
    queryFn: ({ signal }) => fetchIncidents(filters, signal),
    enabled: can(me, 'incident.read'),
    refetchInterval: LIVE_REFETCH_MS,
  });

  useEffect(() => {
    if (params.get('create') !== '1') return;
    const next = new URLSearchParams(params);
    next.delete('create');
    setParams(next, { replace: true });
  }, [params, setParams]);

  if (!can(me, 'incident.read')) return <ForbiddenPage title={s12.title} />;
  const items = (list.data?.items ?? []).filter((i) => !severities.length || severities.includes(i.severity));
  return (
    <div className="st-page">
      <Header
        title={s12.title}
        onBack={() => navigate(paths.ops)}
        actions={
          can(me, 'incident.create') ? (
            <Button variant="secondary" compact iconStart={FilePlusCorner} onClick={() => setCreating(true)}>
              {s12.create}
            </Button>
          ) : undefined
        }
      />
      {sel.venueList.length > 1 && !ticketId && !eventId ? (
        <Select
          id="incidents-venue"
          label={staff.venue}
          value={sel.venueId ?? ''}
          options={sel.venueList.map((v) => [v.id, v.name_ar] as const)}
          onChange={(e) => sel.setVenue(e.target.value)}
        />
      ) : null}
      <div className="st-section">
        <FilterChips
          label={staff.status}
          options={STATUSES.map((s) => ({ value: s, label: incidentStatus[s] }))}
          value={statuses}
          onChange={(v) => setStatuses(v as IncidentStatus[])}
        />
        <FilterChips
          label={staff.severity}
          options={SEVERITIES.map((s) => ({ value: s, label: incidentSeverity[s] }))}
          value={severities}
          onChange={(v) => setSeverities(v as IncidentSeverity[])}
        />
        <Select
          id="incidents-type"
          label={staff.type}
          value={type}
          placeholder={staff.allTypes}
          options={(Object.keys(incidentType) as IncidentType[]).map((t) => [t, incidentType[t]] as const)}
          onChange={(e) => setType(e.target.value as IncidentType | '')}
        />
      </div>
      {list.isPending ? (
        <PageSkeleton />
      ) : list.isError && !list.data ? (
        <ReadError error={list.error} onRetry={() => void list.refetch()} />
      ) : items.length ? (
        <ul className="pt-list">
          {items.map((i) => (
            <li key={i.id}>
              <ListItem
                icon={FileExclamationPoint}
                title={incidentType[i.type] ?? i.type}
                meta={`${incidentStatus[i.status]} · ${incidentSeverity[i.severity]} · ${formatDateTime(i.created_at)}`}
                to={staffPaths.incident(i.id)}
              />
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState icon={FileExclamationPoint} title={s12.empty} />
      )}
      {creating ? (
        <IncidentDialog
          venueId={sel.venueId ?? undefined}
          eventId={eventId ?? null}
          onClose={() => setCreating(false)}
          onCreated={(id) => navigate(staffPaths.incident(id))}
        />
      ) : null}
    </div>
  );
}

/** S-12 detail: النوع، الشدة، التذكرة، الوصف، المسؤول، سجل التحديثات، الحل (02 S-12) + `PATCH`. */
export function IncidentPage() {
  const me = useStaffMe();
  const { incidentId = '' } = useParams();
  const navigate = useNavigate();
  const incident = useQuery({
    queryKey: staffKeys.incident(incidentId),
    queryFn: ({ signal }) => fetchIncident(incidentId, signal),
    enabled: can(me, 'incident.read'),
  });
  if (!can(me, 'incident.read')) return <ForbiddenPage title={s12.title} />;
  return (
    <div className="st-page">
      <Header title={s12.title} onBack={() => navigate(paths.incidents)} />
      {incident.isPending ? (
        <PageSkeleton />
      ) : !incident.data ? (
        <ReadError error={incident.error} onRetry={() => void incident.refetch()} backTo={paths.incidents} />
      ) : (
        <IncidentDetail me={me} incident={incident.data} />
      )}
    </div>
  );
}

function IncidentDetail({ me, incident }: { me: Me; incident: Incident }) {
  const online = useOnline();
  const navigate = useNavigate();
  const [edit, setEdit] = useState<IncidentEdit>(() => editFrom(incident));
  const [touched, setTouched] = useState(false);
  // a refreshed incident (after save or VERSION_CONFLICT) replaces the form unless the user is editing
  useEffect(() => {
    if (!touched) setEdit(editFrom(incident));
  }, [incident, touched]);
  const save = useStaffCommand(
    (body: Parameters<typeof commands.updateIncident>[1], key: string) =>
      commands.updateIncident(incident.id, body, key),
    {
      invalidate: [staffKeys.incident(incident.id), staffKeys.incidents()],
      onSuccess: () => setTouched(false),
    },
  );
  const manage = can(me, 'incident.manage') && incident.status !== 'closed';
  const set = (patch: Partial<IncidentEdit>) => {
    setTouched(true);
    setEdit((e) => ({ ...e, ...patch }));
  };
  const localError = incidentEditError(edit);
  const { body, changed } = incidentPatch(incident, edit);
  const statusOptions = [incident.status, ...INCIDENT_NEXT[incident.status]].map(
    (s) => [s, incidentStatus[s]] as const,
  );
  const resolutionError =
    save.fields.resolution ?? (touched && localError === 'resolution' ? s12.resolutionRequired : undefined);
  return (
    <>
      <Card as="section" aria-label={incidentType[incident.type]}>
        <h2 className="pt-card__title">{incidentType[incident.type] ?? incident.type}</h2>
        <dl className="st-facts">
          <div className="st-facts__row">
            <Fact label={staff.status}>{incidentStatus[incident.status]}</Fact>
            <Fact label={staff.severity}>{incidentSeverity[incident.severity]}</Fact>
            <Fact label={s12.owner}>{incident.owner?.full_name ?? s12.unassigned}</Fact>
          </div>
          {incident.ticket_id ? (
            <div className="st-facts__row">
              <Fact label={staff.ticket}>
                <Button
                  variant="ghost"
                  compact
                  onClick={() => navigate(staffPaths.ticket(incident.ticket_id as string))}
                >
                  {buttons.open}
                </Button>
              </Fact>
            </div>
          ) : null}
          <div className="st-facts__row">
            <Fact label={s12.description}>{incident.description}</Fact>
          </div>
          {incident.resolution ? (
            <div className="st-facts__row">
              <Fact label={s12.resolution}>{incident.resolution}</Fact>
            </div>
          ) : null}
        </dl>
        <Section title={s12.history}>
          <ul className="st-checklist">
            <li className="st-muted">
              {fmt(s12.opened, {
                time: formatDateTime(incident.created_at),
                name: incident.opened_by.full_name,
              })}
            </li>
            {incident.updated_at && incident.updated_at !== incident.created_at ? (
              <li className="st-muted">{fmt(s12.updated, { time: formatDateTime(incident.updated_at) })}</li>
            ) : null}
            {incident.resolved_at ? (
              <li className="st-muted">
                {fmt(s12.resolvedAt, {
                  time: formatDateTime(incident.resolved_at),
                  name: incident.resolved_by?.full_name ?? staff.system,
                })}
              </li>
            ) : null}
            {incident.closed_at ? (
              <li className="st-muted">{fmt(s12.closedAt, { time: formatDateTime(incident.closed_at) })}</li>
            ) : null}
          </ul>
        </Section>
      </Card>
      {manage ? (
        <Card>
          <div className="st-form">
            <Select
              id="incident-status"
              label={s12.moveTo}
              value={edit.status}
              options={statusOptions}
              error={save.fields.status}
              onChange={(e) => set({ status: e.target.value as IncidentStatus })}
            />
            <Radio
              name="incident-severity"
              legend={staff.severity}
              options={SEVERITIES.map((s) => [s, incidentSeverity[s]] as const)}
              value={edit.severity}
              onChange={(v) => set({ severity: v as IncidentSeverity })}
            />
            <div className="st-row-actions">
              {edit.ownerId !== me.user.id ? (
                <Button variant="secondary" compact onClick={() => set({ ownerId: me.user.id })}>
                  {s12.assignMe}
                </Button>
              ) : (
                <Button variant="ghost" compact onClick={() => set({ ownerId: null })}>
                  {s12.unassigned}
                </Button>
              )}
            </div>
            <TextArea
              id="incident-description"
              label={s12.description}
              rows={3}
              maxLength={2000}
              value={edit.description}
              error={save.fields.description}
              onChange={(e) => set({ description: e.target.value })}
            />
            <TextArea
              id="incident-resolution"
              label={s12.resolution}
              rows={3}
              maxLength={2000}
              value={edit.resolution}
              error={resolutionError}
              hint={needsResolution(edit.status) ? s12.resolutionRequired : undefined}
              onChange={(e) => set({ resolution: e.target.value })}
            />
            {save.message && !Object.keys(save.fields).length ? (
              <FieldError role="alert">{save.message}</FieldError>
            ) : null}
            <Button
              fullWidth
              loading={save.pending}
              disabled={!online || !changed || !!localError}
              onClick={() => {
                setTouched(true);
                void save.run(body as Parameters<typeof commands.updateIncident>[1]);
              }}
            >
              {buttons.save}
            </Button>
          </div>
        </Card>
      ) : null}
    </>
  );
}
