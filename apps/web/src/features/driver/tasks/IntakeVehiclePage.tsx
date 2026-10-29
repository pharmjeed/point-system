import { useQueryClient } from '@tanstack/react-query';
import { MessageCircle, Ticket } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import { ApiError, displayMessage, isNetworkError } from '@/api/errors';
import { patchIntake, type IntakePatch } from '@/api/field';
import { queryKeys } from '@/api/queryClient';
import type { TicketDetail } from '@/api/types';
import { paths } from '@/app/paths';
import {
  Banner,
  Button,
  Checkbox,
  ColorChips,
  PhoneInput,
  PlateInput,
  Radio,
  SegmentedControl,
  Select,
  Stepper,
  TextField,
} from '@/components';
import { LoadError } from '@/features/common/QueryView';
import { useCommand } from '@/hooks/useCommand';
import { useBrand } from '@/hooks/useMe';
import { useCommandGate } from '@/realtime/hooks';
import { d01, d05, d13, ui, vehicleColor, vehicleMake } from '@/i18n/ar';
import { fmt } from '@/i18n/fmt';
import { withTicket } from '@/i18n/fmtNode';
import { normalizeSaudiMobile } from '@/lib/phone';
import { useUiStore } from '@/stores/ui';
import {
  colorComplete,
  driverPaths,
  makeComplete,
  MAKE_KEYS,
  PLATE_RAW_MAX,
  plateBody,
  plateComplete,
  plateForm,
  vehicleBody,
  vehicleForm,
  type PlateForm,
  type VehicleForm,
} from '../fieldModel';
import { step1Session, useIntakeDraft, useIntakeStore, type IntakeDraft } from '../intakeStore';
import { channelBody, channelForm, channelIssues, type ChannelForm, type IntakeChannel } from '../linkModel';
import type { LinkMethod } from '../linkStore';
import { useRefreshHome } from '../useDriverHome';
import { TaskScreen, TaskSkeleton, useStoreTicket } from './common';
import { useIntakeTicket } from './intakeDraft';
import { DiscardDraft } from './DiscardDraft';

/** Field keys a server error points at on D-05 (08 field / code mapping). */
type Field = 'plate' | 'make' | 'color' | 'paper_serial' | 'phone' | 'consent';

/**
 * 02 D-05 «الأخطاء» (and D-06's row sending the driver back here): the number refused or opted out → under
 * the phone («للعميل الموقف للرسائل: QR أو تذكرة ورقية» — the two other choices stay on the form); the consent
 * box highlighted; the stub number in use.
 */
const CODE_FIELD: Record<string, Field> = {
  PLATE_INVALID: 'plate',
  PAPER_SERIAL_IN_USE: 'paper_serial',
  PHONE_INVALID: 'phone',
  WA_CUSTOMER_OPTED_OUT: 'phone',
  CONSENT_REQUIRED: 'consent',
};

function fieldOf(path: string): Field | null {
  if (path.startsWith('plate')) return 'plate';
  if (path === 'vehicle.make' || path === 'vehicle_make') return 'make';
  if (path === 'vehicle.color' || path === 'vehicle_color') return 'color';
  if (path === 'paper_serial') return 'paper_serial';
  if (path === 'customer_phone') return 'phone';
  if (path === 'consent') return 'consent';
  return null;
}

type StepError =
  | (NonNullable<IntakeDraft['step1Error']> & { fields?: Array<{ field: string; message_ar?: string }> })
  | null;

/** Errors of a step-1 save → field messages + a form message (02 §1.9, 08). */
function errorsOf(error: StepError) {
  const fields: Partial<Record<Field, string>> = {};
  let form: string | null = null;
  if (!error) return { fields, form };
  const byCode = CODE_FIELD[error.code];
  if (byCode) fields[byCode] = error.message;
  else if (error.code === 'VALIDATION_FAILED' && error.fields?.length) {
    for (const f of error.fields) {
      const key = fieldOf(f.field);
      if (key) fields[key] = f.message_ar || error.message;
    }
    form = error.message;
  } else if (error.code === 'INTAKE_INCOMPLETE' && error.missing?.length) {
    // 02 D-06 «إبراز الحقول في details.missing والانتقال للخطوة التي تحتويها»
    for (const f of error.missing) {
      const key = fieldOf(f);
      if (key) fields[key] = error.message;
    }
    if (!Object.keys(fields).length) form = error.message;
  } else form = error.message;
  return { fields, form };
}

const SAUDI_STEPS = [{ label: d05.steps.vehicle }, { label: d05.steps.keyPhotos }];

const CHANNELS = [
  { value: 'whatsapp' as const, label: d05.channels.whatsapp, icon: MessageCircle },
  { value: 'paper' as const, label: d05.channels.paper, icon: Ticket },
];
const METHODS = [
  ['direct', d05.methods.direct],
  ['qr', d05.methods.qr],
] as const;

/**
 * D-05 — استلام مركبة (1): plate, make, model, colour and the customer's ticket (02 D-05 «قناة العميل»):
 * WhatsApp by the customer's number with the verbal consent (the server sends W-01 at «إتمام التسجيل»), WhatsApp
 * by a QR the customer scans (issued in D-06 right before the submit, shown in D-07), or the paper stub.
 * «التالي» saves with `PATCH /v1/tickets/{id}/intake`; without a reply the step is kept and resent from D-06.
 */
export function IntakeVehiclePage() {
  const { ticketId = '' } = useParams();
  const { ticket, hydrated } = useIntakeTicket(ticketId);
  if (ticket.data) {
    if (ticket.data.status === 'parking') return <Navigate to={driverPaths.intakeLink(ticketId)} replace />;
    if (ticket.data.status !== 'received') return <Navigate to={paths.driverHome} replace />;
    // the draft saved before a reload comes back first (PNT-071)
    return hydrated ? <VehicleStep ticket={ticket.data} /> : <TaskSkeleton />;
  }
  if (ticket.error)
    return <LoadError error={ticket.error} onRetry={() => void ticket.refetch()} backTo={paths.driverHome} />;
  return <TaskSkeleton />;
}

function VehicleStep({ ticket }: { ticket: TicketDetail }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const brand = useBrand();
  // 02 §1.6/§1.7: stale data → «التالي» waits for the resync (PNT-065); without a confirmed connection it
  // moves on locally and D-06 sends the same step later (02 D-05 «بلا اتصال … «التالي» ينقل محليًا»)
  const gate = useCommandGate();
  const online = !gate.unconfirmed;
  const refresh = useRefreshHome();
  const storeTicket = useStoreTicket();
  const pushToast = useUiStore((s) => s.pushToast);
  const draft = useIntakeDraft(ticket.id);
  const update = useIntakeStore((s) => s.update);
  const [plate, setPlate] = useState<PlateForm>(() => draft.plate ?? plateForm(ticket.plate));
  const [vehicle, setVehicle] = useState<VehicleForm>(
    () => draft.vehicle ?? vehicleForm(ticket.vehicle_detail),
  );
  const [link, setLink] = useState<ChannelForm>(() => channelForm(ticket, draft));
  const [checked, setChecked] = useState(false);
  const save = useCommand(
    (body: IntakePatch, key: string) => patchIntake(ticket.id, body, key),
    undefined,
    step1Session(ticket.id),
  );

  // keep what the driver typed for this ticket: memory now, IndexedDB 300 ms later (02 D-05, PNT-071); the
  // customer's number stays with this draft only and goes with it (05 §14)
  useEffect(() => {
    update(ticket.id, {
      plate,
      vehicle,
      channel: link.channel,
      method: link.method,
      phone: link.phone,
      consent: link.consent,
      paperSerial: link.paperSerial,
    });
  }, [ticket.id, plate, vehicle, link, update]);

  const e164 = normalizeSaudiMobile(link.phone);
  const issues = channelIssues(link, e164);
  const serverError: StepError =
    save.error instanceof ApiError
      ? { code: save.error.code, message: save.error.message_ar, fields: save.error.fields }
      : save.error
        ? { code: 'NETWORK', message: displayMessage(save.error) }
        : draft.step1Error;
  const errors = errorsOf(serverError);
  const local: Partial<Record<Field, string>> = checked
    ? {
        plate: plateComplete(plate) ? undefined : d05.plateIncomplete,
        make: makeComplete(vehicle) ? undefined : ui.validation,
        color: colorComplete(vehicle) ? undefined : ui.validation,
        paper_serial: issues.includes('paper_serial') ? ui.validation : undefined,
        phone: issues.includes('phone') ? d01.phoneInvalid : undefined,
        consent: issues.includes('consent') ? d05.consentRequired : undefined,
      }
    : {};
  const err = (f: Field) => local[f] ?? errors.fields[f];

  const onNext = async () => {
    if (gate.stale && online) return; // the button is disabled; Enter in a field must not send either
    setChecked(true);
    if (!plateComplete(plate) || !makeComplete(vehicle) || !colorComplete(vehicle) || issues.length) return;
    update(ticket.id, { step1Error: null });
    const body: IntakePatch = {
      expected_version: ticket.version,
      plate: plateBody(plate),
      vehicle: vehicleBody(vehicle),
      ...channelBody(link, e164),
    };
    if (!online) {
      // 02 D-05: offline «التالي» moves on locally; D-06 resends the same step with the same key
      update(ticket.id, { pendingSave: body });
      navigate(driverPaths.intakeKeyPhotos(ticket.id));
      return;
    }
    try {
      const saved = await save.run(body);
      storeTicket(saved);
      update(ticket.id, { pendingSave: null, step1Error: null });
      navigate(driverPaths.intakeKeyPhotos(ticket.id));
    } catch (error) {
      if (isNetworkError(error)) {
        update(ticket.id, { pendingSave: body });
        navigate(driverPaths.intakeKeyPhotos(ticket.id));
        return;
      }
      if (error instanceof ApiError) {
        if (error.is('VERSION_CONFLICT', 'INVALID_STATE_TRANSITION'))
          void qc.invalidateQueries({ queryKey: queryKeys.ticket(ticket.id) });
        if (error.is('NOT_TASK_ASSIGNEE', 'PERMISSION_DENIED', 'TICKET_NOT_FOUND')) {
          pushToast({ message: error.message_ar, tone: 'error' });
          void refresh();
          navigate(paths.driverHome, { replace: true });
        }
      }
    }
  };

  const edit =
    <T,>(setter: (v: T) => void) =>
    (v: T) => {
      setter(v);
      if (save.error) save.reset();
      if (draft.step1Error) update(ticket.id, { step1Error: null });
    };
  const setLinkPart = edit((patch: Partial<ChannelForm>) => setLink((l) => ({ ...l, ...patch })));
  // 02 D-05: switching to «رمز QR يمسحه العميل» empties the number and the consent of the draft
  const chooseMethod = (method: LinkMethod) =>
    setLinkPart(method === 'qr' ? { method, phone: '', consent: false } : { method });

  return (
    <TaskScreen
      title={withTicket(d05.title, ticket.display_number)}
      backTo={paths.driverHome}
      actions={<DiscardDraft ticket={ticket} disabled={save.pending || !gate.ready} />}
    >
      <Stepper current={0} steps={SAUDI_STEPS} />
      {ticket.event_name_ar ? <p className="m-0">{fmt(d05.event, { event: ticket.event_name_ar })}</p> : null}
      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void onNext();
        }}
      >
        <PlateInput
          id="plate"
          digits={plate.digits}
          letters={plate.letters}
          other={plate.other}
          raw={plate.raw}
          error={err('plate')}
          onDigitsChange={edit((digits: string) => setPlate((p) => ({ ...p, digits })))}
          onLettersChange={edit((letters: PlateForm['letters']) => setPlate((p) => ({ ...p, letters })))}
          onOtherChange={edit((other: boolean) => setPlate((p) => ({ ...p, other })))}
          onRawChange={edit((raw: string) => setPlate((p) => ({ ...p, raw: raw.slice(0, PLATE_RAW_MAX) })))}
        />
        <Select
          id="make"
          label={d05.make}
          placeholder="—"
          value={vehicle.make}
          options={MAKE_KEYS.map((k) => [k, vehicleMake[k]] as const)}
          error={vehicle.make === 'other' ? undefined : err('make')}
          onChange={(e) => edit((make: string) => setVehicle((v) => ({ ...v, make })))(e.target.value)}
        />
        {vehicle.make === 'other' ? (
          <TextField
            id="make-other"
            label={d05.makeOther}
            value={vehicle.makeOther}
            maxLength={40}
            error={err('make')}
            onChange={(e) =>
              edit((makeOther: string) => setVehicle((v) => ({ ...v, makeOther })))(e.target.value)
            }
          />
        ) : null}
        <TextField
          id="model"
          label={d05.model}
          value={vehicle.model}
          maxLength={40}
          onChange={(e) => edit((model: string) => setVehicle((v) => ({ ...v, model })))(e.target.value)}
        />
        <div className="flex flex-col gap-2">
          <span className="pt-field__label" id="color-label">
            {d05.color}
          </span>
          <ColorChips
            label={d05.color}
            value={(vehicle.color || undefined) as keyof typeof vehicleColor | undefined}
            error={vehicle.color === 'other' ? undefined : err('color')}
            onChange={(color) => edit((c: string) => setVehicle((v) => ({ ...v, color: c })))(color)}
          />
        </div>
        {vehicle.color === 'other' ? (
          <TextField
            id="color-other"
            label={d05.colorOther}
            value={vehicle.colorOther}
            maxLength={30}
            error={err('color')}
            onChange={(e) =>
              edit((colorOther: string) => setVehicle((v) => ({ ...v, colorOther })))(e.target.value)
            }
          />
        ) : null}

        <div className="flex flex-col gap-2" data-field="channel">
          <span className="pt-field__label" id="channel-label">
            {d05.channel}
          </span>
          <SegmentedControl<IntakeChannel>
            label={d05.channel}
            options={CHANNELS}
            value={link.channel}
            onChange={(channel) => setLinkPart({ channel })}
          />
        </div>
        {link.channel === 'whatsapp' ? (
          <>
            <Radio
              name="link-method"
              legend={d05.linkMethod}
              options={METHODS}
              value={link.method}
              onChange={(v) => chooseMethod(v as LinkMethod)}
            />
            {link.method === 'direct' ? (
              <>
                <PhoneInput
                  id="customer-phone"
                  label={d05.phone}
                  placeholder={d01.phonePlaceholder}
                  value={link.phone}
                  maxLength={16}
                  error={err('phone')}
                  onChange={(e) => setLinkPart({ phone: e.target.value })}
                />
                <Checkbox
                  id="consent"
                  label={d13.consent}
                  hint={fmt(d05.consentHint, { customer: brand.customerNameAr })}
                  checked={link.consent}
                  error={err('consent')}
                  onChange={(e) => setLinkPart({ consent: e.target.checked })}
                />
              </>
            ) : null}
          </>
        ) : (
          <TextField
            id="paper-serial"
            label={d05.paperSerial}
            hint={d05.paperHint}
            placeholder={d05.paperSerialPlaceholder}
            value={link.paperSerial}
            maxLength={20}
            autoComplete="off"
            dir="ltr"
            error={err('paper_serial')}
            onChange={(e) => setLinkPart({ paperSerial: e.target.value })}
          />
        )}
        {errors.form ? (
          <Banner
            kind="error"
            rounded
            message={errors.form}
            detail={
              save.error instanceof ApiError && save.error.requestId
                ? fmt(ui.requestId, { id: save.error.requestId })
                : undefined
            }
          />
        ) : null}
        <Button
          type="submit"
          size="lg"
          id="intake-next"
          loading={save.pending}
          disabled={gate.stale && online}
        >
          {d05.next}
        </Button>
      </form>
    </TaskScreen>
  );
}
