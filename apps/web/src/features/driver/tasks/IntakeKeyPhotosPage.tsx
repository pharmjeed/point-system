import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import { ApiError, displayMessage, isApiError } from '@/api/errors';
import { patchIntake, submitIntake, type IntakePatch } from '@/api/field';
import { queryKeys } from '@/api/queryClient';
import type { MediaKind, TicketDetail } from '@/api/types';
import { paths } from '@/app/paths';
import { Banner, Button, Dialog, PhotoTile, PlateBadge, Stepper, TextArea, TextField } from '@/components';
import { LoadError } from '@/features/common/QueryView';
import { useCommand } from '@/hooks/useCommand';
import { useCommandGate } from '@/realtime/hooks';
import { components, d05, d06, mediaKind, ui } from '@/i18n/ar';
import { fmt } from '@/i18n/fmt';
import { withTicket } from '@/i18n/fmtNode';
import { useUiStore } from '@/stores/ui';
import {
  driverPaths,
  EXTRA_KINDS,
  fieldSettings,
  plateValue,
  stepOfMissing,
  vehicleSummary,
} from '../fieldModel';
import { intakeSession, step1Session, useIntakeDraft, useIntakeStore, type PhotoSlot } from '../intakeStore';
import { useCachedHome, useRefreshHome } from '../useDriverHome';
import { TaskScreen, TaskSkeleton, useStoreTicket } from './common';
import { useIntakeTicket } from './intakeDraft';
import { DiscardDraft } from './DiscardDraft';
import { startPhotoUpload } from './uploads';

const STEPS = [{ label: d05.steps.vehicle }, { label: d05.steps.keyPhotos }];

type SubmitBody = { expected_version: number; acknowledge_incomplete_inspection?: boolean };

/** Codes that send the driver back to D-05 with the field highlighted (02 D-06 table). */
const STEP1_CODES = [
  'CONSENT_REQUIRED',
  'PHONE_INVALID',
  'PLATE_INVALID',
  'WA_CUSTOMER_OPTED_OUT',
  'PAPER_SERIAL_IN_USE',
];

/**
 * D-06 — استلام مركبة (2): key tag, inspection photos (required angles from the venue settings, extras up to
 * `inspection.max_extra_photos`), damage notes, then «إتمام التسجيل»: `PATCH …/intake` (key_tag, notes)
 * and `POST …/submit-intake`; INSPECTION_INCOMPLETE asks to continue with an acknowledged incomplete
 * inspection (DEC-31).
 */
export function IntakeKeyPhotosPage() {
  const { ticketId = '' } = useParams();
  const { ticket, hydrated } = useIntakeTicket(ticketId);
  if (ticket.data) {
    if (ticket.data.status === 'parking') return <Navigate to={driverPaths.intakeLink(ticketId)} replace />;
    if (ticket.data.status !== 'received') return <Navigate to={paths.driverHome} replace />;
    // the draft and the pending photos saved before a reload come back first (PNT-071)
    return hydrated ? <KeyPhotosStep ticket={ticket.data} /> : <TaskSkeleton />;
  }
  if (ticket.error)
    return <LoadError error={ticket.error} onRetry={() => void ticket.refetch()} backTo={paths.driverHome} />;
  return <TaskSkeleton />;
}

interface Tile {
  slot: string;
  kind: MediaKind;
  photo?: PhotoSlot;
  /** Uploaded on the server (from TicketDetail.media) without a local copy. */
  remote?: boolean;
}

function KeyPhotosStep({ ticket }: { ticket: TicketDetail }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  // 02 §1.6/§1.7: offline or stale data → commands wait (PNT-065)
  const gate = useCommandGate();
  const online = !gate.offline;
  const refresh = useRefreshHome();
  const storeTicket = useStoreTicket();
  const pushToast = useUiStore((s) => s.pushToast);
  const home = useCachedHome();
  const settings = fieldSettings(home);
  const draft = useIntakeDraft(ticket.id);
  const update = useIntakeStore((s) => s.update);
  const clear = useIntakeStore((s) => s.clear);
  const [keyTag, setKeyTag] = useState(() => draft.keyTag ?? ticket.key_tag ?? '');
  const [notes, setNotes] = useState(() => draft.notes ?? ticket.notes ?? '');
  const [keyTagLocal, setKeyTagLocal] = useState<string | null>(null);
  const [inspection, setInspection] = useState<{ missing: number } | null>(null);

  const step1 = useCommand(
    (body: IntakePatch, key: string) => patchIntake(ticket.id, body, key),
    undefined,
    step1Session(ticket.id),
  );
  // their unfinished intents survive a reload: the resend is the same key (02 §1.8 item 1, TC-061)
  const save = useCommand(
    (body: IntakePatch, key: string) => patchIntake(ticket.id, body, key),
    undefined,
    intakeSession<IntakePatch>(ticket.id, 'save'),
  );
  const submit = useCommand(
    (body: SubmitBody, key: string) => submitIntake(ticket.id, body, key),
    undefined,
    intakeSession<SubmitBody>(ticket.id, 'submit'),
  );

  useEffect(() => {
    update(ticket.id, { keyTag, notes });
  }, [ticket.id, keyTag, notes, update]);

  // 02 D-05: the first step saved without a reply is resent (same key and body) until the server answers
  const pendingSave = draft.pendingSave;
  useEffect(() => {
    if (!pendingSave) return;
    let active = true;
    const attempt = () => {
      if (!navigator.onLine) return;
      step1.run(pendingSave).then(
        (saved) => {
          if (!active) return;
          storeTicket(saved);
          update(ticket.id, { pendingSave: null });
        },
        (error: unknown) => {
          if (!active || !(error instanceof ApiError)) return;
          update(ticket.id, {
            pendingSave: null,
            step1Error: { code: error.code, message: error.message_ar },
          });
          navigate(driverPaths.intakeVehicle(ticket.id), { replace: true });
        },
      );
    };
    attempt();
    const timer = setInterval(attempt, 5000);
    window.addEventListener('online', attempt);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener('online', attempt);
    };
    // deliberately keyed on the pending body only: the shared session dedupes concurrent sends
  }, [pendingSave, ticket.id]);

  // tiles: the required angles, then extras (local first, then the server's), then the two «+» tiles
  const media = (ticket.media ?? []).filter((m) => m.upload_status === 'uploaded');
  const required: Tile[] = settings.requiredPhotos.map((kind) => {
    const photo = draft.photos[kind];
    return { slot: kind, kind, photo, remote: !photo && media.some((m) => m.kind === kind) };
  });
  const localExtras = Object.values(draft.photos).filter((p) => EXTRA_KINDS.includes(p.kind));
  const remoteExtras = media.filter(
    (m) => EXTRA_KINDS.includes(m.kind) && !localExtras.some((p) => p.mediaId === m.id),
  );
  const extras: Tile[] = [
    ...localExtras.map((p) => ({ slot: p.slot, kind: p.kind, photo: p })),
    ...remoteExtras.map((m) => ({ slot: m.id, kind: m.kind, remote: true })),
  ];
  const tileState = (t: Tile) => (t.remote ? 'uploaded' : (t.photo?.state ?? 'empty'));
  const done = required.filter((t) => tileState(t) === 'uploaded').length;
  const uploading = [...required, ...extras].filter((t) => tileState(t) === 'uploading').length;
  const canAddExtra = extras.length < settings.maxExtraPhotos;
  const nextExtra = (kind: MediaKind) => `${kind}:${Date.now()}`;

  const vehicleText = draft.pendingSave
    ? vehicleSummary(draft.pendingSave.vehicle)
    : vehicleSummary(ticket.vehicle_detail ?? ticket.vehicle);
  const plate = plateValue(
    draft.pendingSave?.plate ? { ...draft.pendingSave.plate, display: '' } : ticket.plate,
  );

  const runSubmit = async (acknowledge: boolean) => {
    setInspection(null);
    const tag = keyTag.trim();
    if (!tag) {
      setKeyTagLocal(ui.validation);
      return;
    }
    setKeyTagLocal(null);
    let version = ticket.version;
    try {
      const noteText = notes.trim() || null;
      if (tag !== (ticket.key_tag ?? '') || noteText !== (ticket.notes ?? null)) {
        const saved = await save.run({ expected_version: version, key_tag: tag, notes: noteText });
        storeTicket(saved);
        version = saved.version;
      }
      const submitted = await submit.run({
        expected_version: version,
        ...(acknowledge ? { acknowledge_incomplete_inspection: true } : {}),
      });
      storeTicket(submitted);
      clear(ticket.id);
      void refresh();
      navigate(driverPaths.intakeLink(ticket.id), { replace: true });
    } catch (error) {
      if (!(error instanceof ApiError)) return;
      if (error.is('INSPECTION_INCOMPLETE')) {
        const missing = Array.isArray(error.details.missing)
          ? error.details.missing.length
          : settings.requiredPhotos.length - done;
        setInspection({ missing });
        return;
      }
      if (error.is('INTAKE_INCOMPLETE') && stepOfMissing(error.details.missing) === 'vehicle') {
        update(ticket.id, { step1Error: { code: error.code, message: error.message_ar } });
        navigate(driverPaths.intakeVehicle(ticket.id));
        return;
      }
      if (error.is(...STEP1_CODES)) {
        update(ticket.id, { step1Error: { code: error.code, message: error.message_ar } });
        navigate(driverPaths.intakeVehicle(ticket.id));
        return;
      }
      if (error.is('VERSION_CONFLICT', 'INVALID_STATE_TRANSITION'))
        void qc.invalidateQueries({ queryKey: queryKeys.ticket(ticket.id) });
      if (error.is('NOT_TASK_ASSIGNEE', 'PERMISSION_DENIED', 'TICKET_NOT_FOUND')) {
        pushToast({ message: error.message_ar, tone: 'error' });
        void refresh();
        navigate(paths.driverHome, { replace: true });
      }
    }
  };

  const keyTagServer =
    isApiError(save.error, 'KEY_TAG_IN_USE') || isApiError(submit.error, 'KEY_TAG_IN_USE')
      ? displayMessage(save.error ?? submit.error)
      : isApiError(submit.error, 'INTAKE_INCOMPLETE')
        ? displayMessage(submit.error)
        : undefined;
  const formError = [save.error, submit.error].find(
    (e) => e && !isApiError(e, 'KEY_TAG_IN_USE', 'INSPECTION_INCOMPLETE', 'INTAKE_INCOMPLETE'),
  );
  const pending = save.pending || submit.pending;
  const blocked = !gate.ready || !!draft.pendingSave;

  return (
    <TaskScreen
      title={withTicket(d05.title, ticket.display_number)}
      backTo={driverPaths.intakeVehicle(ticket.id)}
      actions={<DiscardDraft ticket={ticket} disabled={pending} />}
    >
      <Stepper current={1} steps={STEPS} />
      {draft.pendingSave ? <Banner kind="stale" rounded message={d05.notSaved} /> : null}
      <div className="flex flex-wrap items-center gap-3">
        {plate ? <PlateBadge {...plate} /> : null}
        {vehicleText ? <span>{vehicleText}</span> : null}
      </div>
      <TextField
        id="key-tag"
        label={d06.keyTag}
        value={keyTag}
        inputMode="numeric"
        autoComplete="off"
        dir="ltr"
        maxLength={20}
        error={keyTagLocal ?? keyTagServer}
        onChange={(e) => {
          setKeyTag(e.target.value);
          setKeyTagLocal(null);
          if (save.error) save.reset();
          if (submit.error) submit.reset();
        }}
      />

      <section className="flex flex-col gap-2" aria-labelledby="photos-title">
        <h2 className="pt-section-title" id="photos-title">
          {fmt(d06.photos, { n: done, total: settings.requiredPhotos.length })}
        </h2>
        <div className="pt-photogrid">
          {[...required, ...extras].map((t) => (
            <PhotoTile
              key={t.slot}
              angle={mediaKind[t.kind]}
              state={tileState(t)}
              progress={t.photo?.progress}
              src={t.photo?.src}
              disabled={t.remote && EXTRA_KINDS.includes(t.kind)}
              onFile={(file) => startPhotoUpload(ticket.id, t.slot, t.kind, file)}
            />
          ))}
          {canAddExtra ? (
            <>
              <PhotoTile
                angle={components.photo.extra}
                extra
                onFile={(file) => startPhotoUpload(ticket.id, nextExtra('photo_extra'), 'photo_extra', file)}
              />
              <PhotoTile
                angle={d06.damagePhoto}
                extra
                onFile={(file) =>
                  startPhotoUpload(ticket.id, nextExtra('photo_damage'), 'photo_damage', file)
                }
              />
            </>
          ) : null}
        </div>
        {[...required, ...extras]
          .filter((t) => t.photo?.state === 'failed' && t.photo.error)
          .map((t) => (
            <p key={t.slot} className="m-0 text-sm text-danger-text" role="alert">
              {mediaKind[t.kind]}: {t.photo?.error}
            </p>
          ))}
      </section>

      <TextArea
        id="notes"
        label={d06.notes}
        value={notes}
        rows={2}
        maxLength={500}
        onChange={(e) => setNotes(e.target.value)}
      />
      {done < settings.requiredPhotos.length ? (
        <Banner
          kind="warning"
          rounded
          message={fmt(d06.incomplete, { n: done, total: settings.requiredPhotos.length })}
        />
      ) : null}
      {formError ? <Banner kind="error" rounded message={displayMessage(formError)} /> : null}
      {!online ? <Banner kind="offline" rounded message={d06.needsConnection} /> : null}

      <Button
        size="lg"
        id="intake-submit"
        loading={pending}
        disabled={blocked || uploading > 0}
        onClick={() => runSubmit(false)}
      >
        {uploading > 0 ? fmt(d06.submitWaiting, { n: uploading }) : d06.submit}
      </Button>
      {uploading > 0 && !blocked ? (
        <button
          type="button"
          className="pt-link self-center"
          disabled={pending}
          onClick={() => void runSubmit(false)}
        >
          {d06.continueWithout}
        </button>
      ) : null}

      <Dialog
        open={inspection !== null}
        onOpenChange={(open) => {
          if (!open) setInspection(null);
        }}
        title={fmt(d06.inspectionTitle, {
          n: settings.requiredPhotos.length - (inspection?.missing ?? 0),
          total: settings.requiredPhotos.length,
        })}
        confirmLabel={d06.continueAndNotify}
        cancelLabel={d06.completePhotos}
        loading={pending}
        onConfirm={() => runSubmit(true)}
        onCancel={() => setInspection(null)}
      />
    </TaskScreen>
  );
}
