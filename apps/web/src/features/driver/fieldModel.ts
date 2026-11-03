import type {
  ClaimCodeState,
  DriverHome,
  DriverState,
  MediaKind,
  OfferCard,
  ParkingMode,
  Plate,
  PlateBody,
  TaskCard,
  VehicleInfo,
} from '@/api/types';
import { PLATE_LETTERS, type PlateLetter } from '@/components/LetterPad';
import type { PlateValue } from '@/components/PlateBadge';
import { d04, vehicleColor, vehicleMake } from '@/i18n/ar';
import { fmt } from '@/i18n/fmt';
import { onlyDigits } from '@/lib/digits';
import { formatSinceMinutes } from '@/lib/format';
import { VENUE_DEFAULTS } from '@/lib/venueDefaults';

/**
 * Pure rules of the driver's field screens (D-04 … D-11), unit-tested in test/fieldModel.test.ts.
 * Routes are 02 §9.1.
 */
export const driverPaths = {
  intakeVehicle: (ticketId: string) => `/d/intake/${ticketId}/vehicle`,
  intakeKeyPhotos: (ticketId: string) => `/d/intake/${ticketId}/key-photos`,
  intakeLink: (ticketId: string) => `/d/intake/${ticketId}/link`,
  park: (taskId: string) => `/d/tasks/${taskId}/park`,
  task: (taskId: string) => `/d/tasks/${taskId}`,
  handover: (ticketId: string) => `/d/tickets/${ticketId}/handover`,
} as const;

// ---------------------------------------------------------------- plates

/** 07 §1.8 writes «ه» where the letter pad shows the display form «هـ» (03 §3.7): the wire takes «ه». */
const WIRE_LETTER: Record<string, string> = { هـ: 'ه' };
const PAD_LETTER: Record<string, string> = { ه: 'هـ' };

export interface PlateForm {
  other: boolean;
  digits: string;
  letters: PlateLetter[];
  raw: string;
}

export const EMPTY_PLATE: PlateForm = { other: false, digits: '', letters: [], raw: '' };

/** Non-Saudi plates: 02 D-05 has no country field, so «أخرى» is sent as the user-assigned code `XX`. */
export const OTHER_PLATE_COUNTRY = 'XX';
export const PLATE_RAW_MAX = 12;

/** Local check of 02 D-05: three letters and 1–4 digits, or the free text of another plate. */
export function plateComplete(plate: PlateForm): boolean {
  if (plate.other) return plate.raw.trim().length > 0 && plate.raw.trim().length <= PLATE_RAW_MAX;
  return plate.letters.length === 3 && /^[0-9]{1,4}$/.test(plate.digits);
}

export function plateBody(plate: PlateForm): PlateBody {
  if (plate.other) return { country: OTHER_PLATE_COUNTRY, raw: plate.raw.trim() };
  return {
    country: 'SA',
    digits: onlyDigits(plate.digits).slice(0, 4),
    letters_ar: plate.letters.map(([ar]) => WIRE_LETTER[ar] ?? ar).join(' '),
    letters_en: plate.letters.map(([, en]) => en).join(' '),
  };
}

/** The server's plate back into the form (returning to D-05 from D-06). */
export function plateForm(plate: Plate | null | undefined): PlateForm {
  if (!plate) return EMPTY_PLATE;
  if (plate.country !== 'SA') return { ...EMPTY_PLATE, other: true, raw: plate.raw ?? '' };
  const letters = (plate.letters_ar ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((ar) => PLATE_LETTERS.find(([padAr]) => padAr === (PAD_LETTER[ar] ?? ar)))
    .filter((l): l is (typeof PLATE_LETTERS)[number] => !!l);
  return { ...EMPTY_PLATE, digits: plate.digits ?? '', letters };
}

export const hasPlate = (plate: Plate | null | undefined): boolean =>
  !!plate && (!!plate.raw || (!!plate.digits && !!plate.letters_ar));

/** PlateBadge props; a non-Saudi plate has no badge (its raw text is shown instead). */
export function plateValue(plate: Plate | null | undefined): PlateValue | undefined {
  if (!plate || plate.country !== 'SA' || !plate.digits || !plate.letters_ar) return undefined;
  const letters = plate.letters_ar.split(/\s+/).filter(Boolean);
  return {
    digits: plate.digits,
    letters: letters.map((ar) => PAD_LETTER[ar] ?? ar),
    lettersEn: plate.letters_en ? plate.letters_en.split(/\s+/).filter(Boolean) : undefined,
  };
}

// ---------------------------------------------------------------- vehicles

/** Stored as the 02 §8.4 keys (02 §9.3 item 16); free text for «أخرى». */
export const MAKE_KEYS = Object.keys(vehicleMake) as Array<keyof typeof vehicleMake>;
export const COLOR_KEYS = Object.keys(vehicleColor) as Array<keyof typeof vehicleColor>;

const label = (dict: Record<string, string>, value: string | null | undefined) =>
  value ? (dict[value] ?? value) : '';

/** «تويوتا كامري · أبيض» (02 D-04 TaskCard); keys are translated, free text kept. */
export function vehicleSummary(
  vehicle: VehicleInfo | { make?: string | null; color?: string | null } | undefined,
) {
  if (!vehicle) return '';
  const make = label(vehicleMake, vehicle.make);
  const model = 'model' in vehicle ? (vehicle.model ?? '') : '';
  const color = label(vehicleColor, vehicle.color);
  const name = [make, model].filter(Boolean).join(' ');
  return [name, color].filter(Boolean).join(' · ');
}

export interface VehicleForm {
  make: string;
  makeOther: string;
  model: string;
  color: string;
  colorOther: string;
}

export const EMPTY_VEHICLE: VehicleForm = { make: '', makeOther: '', model: '', color: '', colorOther: '' };

export function vehicleBody(form: VehicleForm): VehicleInfo {
  return {
    make: form.make === 'other' ? form.makeOther.trim() || null : form.make || null,
    model: form.model.trim() || null,
    color: form.color === 'other' ? form.colorOther.trim() || null : form.color || null,
  };
}

export function vehicleForm(vehicle: VehicleInfo | null | undefined): VehicleForm {
  if (!vehicle) return EMPTY_VEHICLE;
  const known = (keys: readonly string[], v: string | null | undefined) => !v || keys.includes(v);
  return {
    make: !vehicle.make ? '' : known(MAKE_KEYS, vehicle.make) ? vehicle.make : 'other',
    makeOther: vehicle.make && !known(MAKE_KEYS, vehicle.make) ? vehicle.make : '',
    model: vehicle.model ?? '',
    color: !vehicle.color ? '' : known(COLOR_KEYS, vehicle.color) ? vehicle.color : 'other',
    colorOther: vehicle.color && !known(COLOR_KEYS, vehicle.color) ? vehicle.color : '',
  };
}

export const makeComplete = (f: VehicleForm) => (f.make === 'other' ? !!f.makeOther.trim() : !!f.make);
export const colorComplete = (f: VehicleForm) => (f.color === 'other' ? !!f.colorOther.trim() : !!f.color);

// ---------------------------------------------------------------- intake errors (08 INTAKE_INCOMPLETE)

/** Fields of step 2 (D-06); everything else in `details.missing` is on step 1 (D-05). */
const STEP2_FIELDS = ['key_tag', 'notes', 'photo', 'media', 'inspection'];

export function stepOfField(field: string): 'vehicle' | 'key-photos' {
  return STEP2_FIELDS.some((f) => field === f || field.startsWith(f)) ? 'key-photos' : 'vehicle';
}

/** The first step holding one of the missing fields (02 D-06: «الانتقال للخطوة التي تحتويها»). */
export function stepOfMissing(missing: unknown): 'vehicle' | 'key-photos' {
  const list = Array.isArray(missing) ? missing.map(String) : [];
  return list.some((f) => stepOfField(f) === 'vehicle') ? 'vehicle' : 'key-photos';
}

/** Missing field names of a D-05 field group: `plate.digits` → plate, `vehicle.make` / `vehicle_make` → make. */
export function missingGroups(
  missing: unknown,
): Set<'plate' | 'make' | 'color' | 'paper_serial' | 'key_tag'> {
  const out = new Set<'plate' | 'make' | 'color' | 'paper_serial' | 'key_tag'>();
  for (const raw of Array.isArray(missing) ? missing.map(String) : []) {
    const f = raw.replace('vehicle_', 'vehicle.');
    if (f.startsWith('plate')) out.add('plate');
    else if (f === 'vehicle.make' || f === 'make') out.add('make');
    else if (f === 'vehicle.color' || f === 'color') out.add('color');
    else if (f === 'paper_serial') out.add('paper_serial');
    else if (f === 'key_tag') out.add('key_tag');
  }
  return out;
}

// ---------------------------------------------------------------- venue settings on driver screens

export interface FieldSettings {
  requiredPhotos: MediaKind[];
  maxExtraPhotos: number;
  parkingMode: ParkingMode;
  requireSlot: boolean;
  offerTtlS: number;
}

/**
 * A driver cannot read `GET /v1/venues/{id}/settings` (`venue.read`, canon §10): the screens use the values
 * the home snapshot carries (proposed `DriverHome.settings`) over the canon §12 defaults.
 */
export function fieldSettings(home: DriverHome | undefined): FieldSettings {
  const s = home?.settings ?? {};
  return {
    requiredPhotos: s.inspection?.required_photos ?? VENUE_DEFAULTS.inspection.required_photos,
    maxExtraPhotos: s.inspection?.max_extra_photos ?? VENUE_DEFAULTS.inspection.max_extra_photos,
    parkingMode: s.parking?.mode ?? VENUE_DEFAULTS.parking.mode,
    requireSlot: s.keys?.require_slot ?? VENUE_DEFAULTS.keys.require_slot,
    offerTtlS: s.dispatch?.single_offer_ttl_s ?? VENUE_DEFAULTS.dispatch.single_offer_ttl_s,
  };
}

// ---------------------------------------------------------------- photos (D-06)

export const EXTRA_KINDS: MediaKind[] = ['photo_extra', 'photo_damage'];

// ---------------------------------------------------------------- home (D-04)

/** «استلام مركبة» is enabled only when available (02 D-04); otherwise the reason line. */
export function intakeBlockedReason(state: DriverState): string | null {
  if (state === 'available' || state === 'off_duty') return null;
  return d04.disabled[state];
}

/**
 * The events a car can be taken in for: `GET /v1/me/home` lists `open` and `closing` events (retrievals
 * continue while an event closes), and only an `open` one accepts an intake (10 §7.1, EVENT_NOT_OPEN).
 */
export function intakeEvents(home: Pick<DriverHome, 'open_events'>): DriverHome['open_events'] {
  return home.open_events.filter((e) => e.status === 'open');
}

/** The row of the D-04 TaskCard table (also picks the stage icon). */
export type TaskStage = 'intake' | 'park' | 'repark' | 'key' | 'start' | 'retrieving' | 'ready';

export interface TaskCardView {
  stage: TaskStage;
  heading: string;
  line: string;
  action: string;
  to: string;
}

/** The D-04 TaskCard table: heading, stage line, button and destination for each task and state. */
export function taskCardView(card: TaskCard, now: number = Date.now()): TaskCardView {
  const { task, ticket } = card;
  if (task.type === 'park') {
    if (ticket.status === 'received') {
      const to = hasPlate(ticket.plate) ? driverPaths.intakeKeyPhotos : driverPaths.intakeVehicle;
      return { stage: 'intake', ...d04.task.intake, to: to(ticket.id) };
    }
    return { stage: 'park', ...d04.task.park, to: driverPaths.park(task.id) };
  }
  if (task.type === 'repark') return { stage: 'repark', ...d04.task.repark, to: driverPaths.park(task.id) };
  // retrieve
  if (task.status === 'accepted' && !task.key_picked_up_at) {
    const slot = card.key_slot?.label ?? '';
    return {
      stage: 'key',
      heading: d04.task.key.heading,
      line: fmt(d04.task.key.line, { slot }),
      action: d04.task.key.action,
      to: driverPaths.task(task.id),
    };
  }
  if (task.status === 'accepted') {
    const spot = card.parking?.spot_label ?? card.parking?.spot_note ?? '';
    return {
      stage: 'start',
      heading: d04.task.start.heading,
      line: fmt(d04.task.start.line, { spot }),
      action: d04.task.start.action,
      to: driverPaths.task(task.id),
    };
  }
  if (ticket.status === 'ready') {
    // «بانتظار العميل · منذ {مدة}»: since the car is ready — the code's issue time when there is one
    // (TaskCard has no `ready_at`, docs/progress/notes/pnt-035.md), else the request time.
    const from = card.claim_code?.issued_at ?? card.requested_at;
    const since = from ? now - Date.parse(from) : 0;
    return {
      stage: 'ready',
      heading: d04.task.ready.heading,
      line: formatSinceMinutes(since),
      action: d04.task.ready.action,
      to: driverPaths.handover(ticket.id),
    };
  }
  return { stage: 'retrieving', ...d04.task.retrieving, to: driverPaths.task(task.id) };
}

/** D-10 stepper position: 0 key · 1 retrieve · 2 ready · 3 handover. */
export function retrievalStep(card: TaskCard): 0 | 1 | 2 | 3 {
  if (card.task.status === 'accepted') return card.task.key_picked_up_at ? 1 : 0;
  return card.ticket.status === 'ready' ? 3 : 2;
}

/** OfferCard action from the server's `eligible_as` (03 §3.5): the server decides, the card follows. */
export function offerAction(offer: OfferCard): 'accept' | 'reserve_next' | 'none' {
  if (offer.eligible_as === 'accept' && offer.can_accept) return 'accept';
  if (offer.eligible_as === 'reserve_next' && offer.can_reserve_next) return 'reserve_next';
  return 'none';
}

/**
 * The next task became the current one between two snapshots (02 D-04: `task.updated` to `accepted` →
 * «بدأت مهمتك التالية»). Until the realtime channel (PNT-065) this compares polled homes.
 */
export function promotedTask(previous: DriverHome | undefined, current: DriverHome): TaskCard | null {
  const next = previous?.next_task;
  const now = current.current_task;
  if (!next || !now) return null;
  return next.task.id === now.task.id ? now : null;
}

/** The task card of a task id in the home snapshot (current first, then the reserved next task). */
export function findTask(home: DriverHome | undefined, taskId: string): TaskCard | null {
  if (!home) return null;
  if (home.current_task?.task.id === taskId) return home.current_task;
  if (home.next_task?.task.id === taskId) return home.next_task;
  return null;
}

export function findTicketTask(home: DriverHome | undefined, ticketId: string): TaskCard | null {
  if (!home) return null;
  if (home.current_task?.ticket.id === ticketId) return home.current_task;
  return null;
}

/** «ينتظر منذ 2:40» source: seconds since the request by server time. */
export function waitingSeconds(requestedAt: string | null | undefined, now: number): number {
  return requestedAt ? Math.max(0, (now - Date.parse(requestedAt)) / 1000) : 0;
}

/**
 * D-11: the newest handover-code state — the latest issued code wins (a resend's reply until the ticket's own
 * state catches up); on a tie the first one given (the ticket's, which follows `ticket.updated`: W-05
 * `sent_status`). Never the code itself (DEC-38).
 */
export function newestClaim(...states: Array<ClaimCodeState | null | undefined>): ClaimCodeState | null {
  let best: ClaimCodeState | null = null;
  for (const state of states)
    if (state && (!best || Date.parse(state.issued_at) > Date.parse(best.issued_at))) best = state;
  return best;
}
