import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Images } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ApiError, displayMessage, fallbackMessageAr } from '@/api/errors';
import { getMediaUrl, keyPickup, markReady, startRetrieval } from '@/api/field';
import { queryKeys } from '@/api/queryClient';
import type { DriverHome, Media, TaskCard as TaskCardData, TicketDetail } from '@/api/types';
import { paths } from '@/app/paths';
import { Banner, Button, Card, Dialog, PlateBadge, Sheet, Skeleton, Stepper } from '@/components';
import { LoadError } from '@/features/common/QueryView';
import { useCommand } from '@/hooks/useCommand';
import { useServerNow } from '@/hooks/useNow';
import { useCommandGate } from '@/realtime/hooks';
import { buttons, components, d04, d10, mediaKind } from '@/i18n/ar';
import { fmt } from '@/i18n/fmt';
import { fmtNode, Ltr, withTicket } from '@/i18n/fmtNode';
import { formatClock, formatTime } from '@/lib/format';
import { useUiStore } from '@/stores/ui';
import {
  driverPaths,
  findTask,
  plateValue,
  retrievalStep,
  vehicleSummary,
  waitingSeconds,
} from '../fieldModel';
import { useDriverHome, useRefreshHome } from '../useDriverHome';
import { ReportSheet } from '../vehicles/actions';
import { TaskGone, TaskScreen, TaskSkeleton, useTicket } from './common';

/**
 * D-10 — المهمة الحالية (الإحضار): the four steps «المفتاح ← الإحضار ← جاهزة ← التسليم» with one button on
 * the current step — `key-pickup`, `start-retrieval`, `ready`, then D-11 (02 D-10). Key slot, spot, damage
 * notes and photos are the assignee's full projection; photos open through ≤ 300 s signed URLs. «إبلاغ عن
 * مشكلة» opens the report Sheet (`POST /v1/incidents` with the ticket, DEC-237); a W-05 the provider refused
 * shows «تعذر إرسال الرسالة للعميل. أُبلغ المشرف.» (the driver sees W-01 and W-05 only, 09 §5.1). Withdrawal
 * and repark are the frame's notices (14 §5.1).
 */
export function RetrievalPage() {
  const { taskId = '' } = useParams();
  const home = useDriverHome();
  if (home.data) {
    const card = findTask(home.data, taskId);
    if (!card || card.task.type !== 'retrieve') return <TaskGone />;
    if (home.data.next_task?.task.id === taskId) return <ReservedTask card={card} />;
    return <Retrieval card={card} />;
  }
  if (home.error)
    return <LoadError error={home.error} onRetry={() => void home.refetch()} backTo={paths.driverHome} />;
  return <TaskSkeleton />;
}

/** The reserved next task: nothing to do until it is promoted (02 D-04 «لا تبدأ الحركة قبل ذلك»). */
function ReservedTask({ card }: { card: TaskCardData }) {
  return (
    <TaskScreen title={withTicket(d10.title, card.ticket.display_number)} backTo={paths.driverHome}>
      <Banner kind="info" rounded message={d04.nextLine} />
    </TaskScreen>
  );
}

type Step = 'pickup' | 'start' | 'ready';

function Retrieval({ card }: { card: TaskCardData }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  // 02 §1.6/§1.7, 03 §4.4: no confirmed connection or stale data → commands wait (PNT-065)
  const gate = useCommandGate();
  const online = !gate.unconfirmed;
  const refresh = useRefreshHome();
  const pushToast = useUiStore((s) => s.pushToast);
  const now = useServerNow(1000);
  const ticket = useTicket(card.ticket.id);
  const [photosOpen, setPhotosOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [custodyIssue, setCustodyIssue] = useState<string | null>(null);
  const step = retrievalStep(card);

  /** The reply is the new TaskCard: show it at once, then re-read the snapshot. */
  const apply = (next: TaskCardData) => {
    qc.setQueryData<DriverHome>(queryKeys.home, (h) => (h ? { ...h, current_task: next } : h));
    void qc.invalidateQueries({ queryKey: queryKeys.ticket(card.ticket.id) });
    void refresh();
  };
  const command = useCommand(async (input: { step: Step; version: number; slotId?: string }, key: string) => {
    if (input.step === 'pickup') {
      if (!input.slotId) throw new ApiError({ status: 409, code: 'CUSTODY_HOLDER_MISMATCH' });
      return keyPickup(card.task.id, { key_slot_id: input.slotId, expected_version: input.version }, key);
    }
    if (input.step === 'start') return startRetrieval(card.task.id, { expected_version: input.version }, key);
    return markReady(card.task.id, { expected_version: input.version }, key);
  });

  /** 08 CUSTODY_HOLDER_MISMATCH (DEC-352): re-read the custody and stop on a dialog. */
  const custodyMismatch = (message: string) => {
    setCustodyIssue(message);
    command.reset();
    void qc.invalidateQueries({ queryKey: queryKeys.ticket(card.ticket.id) });
    void refresh();
  };

  const run = async (s: Step) => {
    const slotId = card.key_slot?.id ?? ticket.data?.current_key_slot?.id;
    // contract:F3: the key is in no slot (holder unknown, the supervisor, a driver) — the strict body takes a
    // slot uuid only, so a "" would be a 422 VALIDATION_FAILED; the pickup cannot match a slot holder anyway
    // (DEC-187 → CUSTODY_HOLDER_MISMATCH), so the custody dialog and a re-read come at once, nothing is sent
    if (s === 'pickup' && !slotId) {
      custodyMismatch(fallbackMessageAr('CUSTODY_HOLDER_MISMATCH'));
      return;
    }
    try {
      apply(await command.run({ step: s, version: card.task.version, slotId }));
    } catch (error) {
      if (!(error instanceof ApiError)) return;
      if (error.is('NOT_TASK_ASSIGNEE')) {
        pushToast({ message: error.message_ar, tone: 'error' });
        void refresh();
        navigate(paths.driverHome, { replace: true });
        return;
      }
      if (error.is('CUSTODY_HOLDER_MISMATCH')) {
        // 08: re-read the custody and stop on a dialog — the key or the car is not where the system has it
        custodyMismatch(error.message_ar);
        return;
      }
      if (error.is('VERSION_CONFLICT', 'INVALID_STATE_TRANSITION', 'TASK_NOT_STARTABLE', 'KEY_NOT_PICKED_UP'))
        void refresh();
    }
  };

  const detail = ticket.data;
  const keySlot = card.key_slot ?? detail?.current_key_slot ?? null;
  const spotLabel = card.parking?.spot_label ?? detail?.current_spot?.label ?? null;
  const zoneName = card.parking?.zone_name ?? detail?.current_spot?.zone_name ?? '';
  const spotNote = card.parking?.spot_note ?? detail?.current_spot_note ?? null;
  const plate = plateValue(card.ticket.plate);
  const offlineDisabled = !gate.ready;
  // 02 D-10 «فشل رسالة العميل»: W-05 refused or skipped (the detail follows `ticket.updated` `message`)
  const sent = (detail?.claim_code ?? card.claim_code)?.sent_status;
  const messageFailed = step === 3 && (sent === 'failed' || sent === 'skipped');
  const error = command.error ? displayMessage(command.error) : undefined;

  const keyLine = keySlot
    ? fmtNode(d10.keySlot, { board: keySlot.board_name, slot: <Ltr>{keySlot.label}</Ltr> })
    : null;
  const spotLine = spotLabel ? fmtNode(d10.spot, { spot: <Ltr>{spotLabel}</Ltr>, zone: zoneName }) : spotNote;

  const actions: Record<0 | 1 | 2 | 3, { label: string; onAction: () => Promise<unknown> | void }> = {
    0: { label: d10.pickedUp, onAction: () => run('pickup') },
    1: { label: d10.startRetrieval, onAction: () => run('start') },
    2: { label: d10.ready, onAction: () => run('ready') },
    3: { label: d10.handover, onAction: () => navigate(driverPaths.handover(card.ticket.id)) },
  };
  const details: Record<0 | 1 | 2 | 3, ReactNode> = {
    0: keyLine ? <span>{keyLine}</span> : null,
    1: (
      <div className="flex flex-col gap-1">
        {spotLine ? <span>{spotLine}</span> : null}
        <span className="text-sm text-text-muted">{d10.startHint}</span>
      </div>
    ),
    2: (
      <div className="flex flex-col gap-1">
        <span>{d10.stopAtHandover}</span>
        <span className="text-sm text-text-muted">{d10.readyHint}</span>
      </div>
    ),
    3: null,
  };
  const time = (iso: string | null | undefined) => (iso ? formatTime(iso) : undefined);
  const steps = [
    { label: components.stepper.key, time: time(card.task.key_picked_up_at) },
    { label: components.stepper.retrieve, time: time(card.task.started_at) },
    { label: components.stepper.ready, time: time(card.claim_code?.issued_at) },
    { label: components.stepper.handover },
  ];

  return (
    <TaskScreen title={withTicket(d10.title, card.ticket.display_number)} backTo={paths.driverHome}>
      {card.requested_at ? (
        <p className="m-0 text-text-muted">
          {fmtNode(d10.waiting, { time: <Ltr>{formatClock(waitingSeconds(card.requested_at, now))}</Ltr> })}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        {plate ? <PlateBadge {...plate} /> : null}
        <span>{vehicleSummary(card.ticket.vehicle)}</span>
      </div>
      <Stepper
        current={step}
        steps={steps}
        detail={details[step]}
        actionLabel={actions[step].label}
        onAction={actions[step].onAction}
        loading={command.pending}
        disabled={offlineDisabled && step !== 3}
        error={error}
      />
      {!online ? <Banner kind="offline" rounded message={d10.needsConnection} /> : null}
      {messageFailed ? <Banner kind="error" rounded message={d10.messageFailed} /> : null}
      <Card>
        <div className="flex flex-col gap-2">
          {keyLine ? <p className="m-0">{keyLine}</p> : null}
          {spotLine ? <p className="m-0">{spotLine}</p> : null}
          {detail?.notes ? <p className="m-0">{fmt(d10.damageNotes, { notes: detail.notes })}</p> : null}
          {ticket.isPending ? <Skeleton variant="line" width="40%" /> : null}
          {detail?.media?.some((m) => m.upload_status === 'uploaded') ? (
            <Button variant="secondary" iconStart={Images} onClick={() => setPhotosOpen(true)}>
              {d10.photos}
            </Button>
          ) : null}
        </div>
      </Card>
      <button
        type="button"
        className="pt-link self-center"
        id="report-problem"
        disabled={!detail}
        onClick={() => setReportOpen(true)}
      >
        {d10.report}
      </button>
      {detail ? <PhotosSheet ticket={detail} open={photosOpen} onOpenChange={setPhotosOpen} /> : null}
      {detail ? (
        <ReportSheet ticket={detail} title={d10.report} open={reportOpen} onOpenChange={setReportOpen} />
      ) : null}
      <Dialog
        open={custodyIssue !== null}
        onOpenChange={(open) => {
          if (!open) setCustodyIssue(null);
        }}
        title={custodyIssue ?? ''}
        confirmLabel={buttons.gotIt}
        hideCancel
        onConfirm={() => setCustodyIssue(null)}
      />
    </TaskScreen>
  );
}

function PhotosSheet({
  ticket,
  open,
  onOpenChange,
}: {
  ticket: TicketDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const photos = (ticket.media ?? []).filter((m) => m.upload_status === 'uploaded');
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={d10.photos}>
      <div className="pt-photogrid">
        {open ? photos.map((m) => <SignedPhoto key={m.id} media={m} />) : null}
      </div>
    </Sheet>
  );
}

/** A signed URL lives in memory for its 5 minutes only (02 §1.11); never cached on disk by the app. */
function SignedPhoto({ media }: { media: Media }) {
  const url = useQuery({
    queryKey: queryKeys.mediaUrl(media.id),
    queryFn: ({ signal }) => getMediaUrl(media.id, signal),
    staleTime: 240_000,
    gcTime: 240_000,
  });
  const angle = mediaKind[media.kind];
  if (!url.data) return <Skeleton />;
  return (
    <figure className="m-0 flex flex-col gap-1">
      <img
        src={url.data.url}
        alt={fmt(components.photo.photoOf, { angle })}
        className="block aspect-[4/3] w-full rounded-md border border-border object-cover"
      />
      <figcaption className="text-sm text-text-muted">{angle}</figcaption>
    </figure>
  );
}
