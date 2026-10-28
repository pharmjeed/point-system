import { describe, expect, it } from 'vitest';
import type { DriverHome, OfferCard, TaskCard } from '@/api/types';
import { PLATE_LETTERS } from '@/components/LetterPad';
import {
  driverPaths,
  EMPTY_PLATE,
  EMPTY_VEHICLE,
  fieldSettings,
  findTask,
  intakeBlockedReason,
  missingGroups,
  offerAction,
  plateBody,
  plateComplete,
  plateForm,
  plateValue,
  promotedTask,
  retrievalStep,
  stepOfMissing,
  taskCardView,
  vehicleBody,
  vehicleForm,
  vehicleSummary,
} from '@/features/driver/fieldModel';
import { d04 } from '@/i18n/ar';
import { VENUE_DEFAULTS } from '@/lib/venueDefaults';

/** Pure rules of the driver's field screens (02 D-04 … D-11). */
const letter = (ar: string) => PLATE_LETTERS.find(([a]) => a === ar) as (typeof PLATE_LETTERS)[number];

function card(over: {
  type?: 'park' | 'retrieve' | 'repark';
  status?: TaskCard['task']['status'];
  ticket?: TaskCard['ticket']['status'];
  keyPicked?: boolean;
  plate?: boolean;
}): TaskCard {
  return {
    task: {
      id: 'task-1',
      ticket_id: 'ticket-1',
      type: over.type ?? 'retrieve',
      status: over.status ?? 'accepted',
      priority_at: '2026-10-28T18:00:00.000Z',
      seq: 1,
      key_picked_up_at: over.keyPicked ? '2026-10-28T18:01:00.000Z' : null,
      version: 3,
    },
    ticket: {
      id: 'ticket-1',
      display_number: 125,
      status: over.ticket ?? 'assigned',
      version: 9,
      plate: over.plate
        ? { country: 'SA', digits: '1234', letters_ar: 'ب ح د', letters_en: 'B J D', display: '1234 ب ح د' }
        : { country: 'SA', display: '' },
    },
    parking: { spot_label: 'A-03', zone_name: 'A', spot_note: null },
    key_slot: { id: 'slot-12', board_name: 'لوحة 1', label: '12' },
    requested_at: '2026-10-28T18:00:00.000Z',
  };
}

describe('plates (02 D-05, 07 §1.8)', () => {
  it('a Saudi plate needs three letters and 1–4 digits', () => {
    expect(plateComplete(EMPTY_PLATE)).toBe(false);
    const letters = [letter('ب'), letter('ح'), letter('د')];
    expect(plateComplete({ ...EMPTY_PLATE, letters, digits: '1234' })).toBe(true);
    expect(plateComplete({ ...EMPTY_PLATE, letters: letters.slice(0, 2), digits: '1234' })).toBe(false);
    expect(plateComplete({ ...EMPTY_PLATE, letters, digits: '' })).toBe(false);
    expect(plateComplete({ ...EMPTY_PLATE, other: true, raw: 'ABC 123' })).toBe(true);
    expect(plateComplete({ ...EMPTY_PLATE, other: true, raw: '   ' })).toBe(false);
  });

  it('sends «ه» for the pad letter «هـ» and the Latin pair in the same order', () => {
    const body = plateBody({
      ...EMPTY_PLATE,
      letters: [letter('هـ'), letter('ب'), letter('ى')],
      digits: '٧٨',
    });
    expect(body).toEqual({ country: 'SA', digits: '78', letters_ar: 'ه ب ى', letters_en: 'H B V' });
  });

  it('another plate is the free text with the unknown-country code', () => {
    expect(plateBody({ ...EMPTY_PLATE, other: true, raw: ' KSA-9 ' })).toEqual({
      country: 'XX',
      raw: 'KSA-9',
    });
  });

  it('reads the server plate back into the form and the badge (display form «هـ»)', () => {
    const plate = { country: 'SA', digits: '910', letters_ar: 'ط ه ق', letters_en: 'T H G', display: '' };
    expect(plateForm(plate).letters.map(([ar]) => ar)).toEqual(['ط', 'هـ', 'ق']);
    expect(plateValue(plate)).toEqual({
      digits: '910',
      letters: ['ط', 'هـ', 'ق'],
      lettersEn: ['T', 'H', 'G'],
    });
    expect(plateValue({ country: 'XX', raw: 'AB 1', display: 'AB 1' })).toBeUndefined();
    expect(plateForm({ country: 'XX', raw: 'AB 1', display: 'AB 1' })).toMatchObject({
      other: true,
      raw: 'AB 1',
    });
  });
});

describe('vehicle (02 §8.4: keys on the wire, free text for «أخرى»)', () => {
  it('sends the key, or the typed text for «أخرى»', () => {
    expect(vehicleBody({ ...EMPTY_VEHICLE, make: 'toyota', model: ' كامري ', color: 'white' })).toEqual({
      make: 'toyota',
      model: 'كامري',
      color: 'white',
    });
    expect(
      vehicleBody({ ...EMPTY_VEHICLE, make: 'other', makeOther: 'تسلا', color: 'other', colorOther: 'خمري' }),
    ).toEqual({ make: 'تسلا', model: null, color: 'خمري' });
  });

  it('a free-text value comes back as «أخرى» with its text', () => {
    expect(vehicleForm({ make: 'تسلا', model: null, color: 'white' })).toMatchObject({
      make: 'other',
      makeOther: 'تسلا',
      color: 'white',
    });
  });

  it('summary «تويوتا كامري · أبيض» translates keys and keeps free text', () => {
    expect(vehicleSummary({ make: 'toyota', model: 'كامري', color: 'white' })).toBe('تويوتا كامري · أبيض');
    expect(vehicleSummary({ make: 'تويوتا', color: 'بيضاء' })).toBe('تويوتا · بيضاء');
    expect(vehicleSummary(undefined)).toBe('');
  });
});

describe('INTAKE_INCOMPLETE → the step that holds the field (02 D-06)', () => {
  it('vehicle fields send the driver back to D-05, the key tag stays on D-06', () => {
    expect(stepOfMissing(['key_tag'])).toBe('key-photos');
    expect(stepOfMissing(['vehicle.color', 'key_tag'])).toBe('vehicle');
    expect(stepOfMissing(['plate'])).toBe('vehicle');
    expect([...missingGroups(['plate.digits', 'vehicle_make', 'paper_serial'])]).toEqual([
      'plate',
      'make',
      'paper_serial',
    ]);
  });
});

describe('D-04', () => {
  it('«استلام مركبة» is enabled only when available, with the 02 reason otherwise', () => {
    expect(intakeBlockedReason('available')).toBeNull();
    expect(intakeBlockedReason('intake_parking')).toBe(d04.disabled.intake_parking);
    expect(intakeBlockedReason('retrieving')).toBe('لديك مهمة إحضار جارية');
    expect(intakeBlockedReason('busy_with_next')).toBe('لديك مهمة إحضار جارية');
    expect(intakeBlockedReason('on_break')).toBe('أنت في استراحة');
  });

  it('TaskCard rows follow the D-04 table', () => {
    const now = Date.parse('2026-10-28T18:03:30.000Z');
    expect(taskCardView(card({ type: 'park', status: 'in_progress', ticket: 'received' }))).toMatchObject({
      stage: 'intake',
      heading: 'تسجيل مركبة',
      action: 'متابعة التسجيل',
      to: driverPaths.intakeVehicle('ticket-1'),
    });
    expect(
      taskCardView(card({ type: 'park', status: 'in_progress', ticket: 'received', plate: true })).to,
    ).toBe(driverPaths.intakeKeyPhotos('ticket-1'));
    expect(taskCardView(card({ type: 'park', status: 'in_progress', ticket: 'parking' }))).toMatchObject({
      stage: 'park',
      action: 'إتمام الصف',
      to: driverPaths.park('task-1'),
    });
    expect(taskCardView(card({ type: 'repark', status: 'in_progress', ticket: 'reparking' }))).toMatchObject({
      heading: 'إعادة صف',
      action: 'إتمام إعادة الصف',
    });
    expect(taskCardView(card({}))).toMatchObject({ stage: 'key', line: 'استلم المفتاح من الخانة 12' });
    expect(taskCardView(card({ keyPicked: true }))).toMatchObject({
      stage: 'start',
      line: 'ابدأ الإحضار من الموقف A-03',
    });
    expect(taskCardView(card({ status: 'in_progress', ticket: 'retrieving' }))).toMatchObject({
      heading: 'جارٍ الإحضار',
      to: driverPaths.task('task-1'),
    });
    expect(taskCardView(card({ status: 'in_progress', ticket: 'ready' }), now)).toMatchObject({
      heading: 'بانتظار العميل',
      line: 'منذ 3 د',
      action: 'التسليم',
      to: driverPaths.handover('ticket-1'),
    });
  });

  it('D-10 stepper position from the task and the ticket', () => {
    expect(retrievalStep(card({}))).toBe(0);
    expect(retrievalStep(card({ keyPicked: true }))).toBe(1);
    expect(retrievalStep(card({ status: 'in_progress', ticket: 'retrieving' }))).toBe(2);
    expect(retrievalStep(card({ status: 'in_progress', ticket: 'ready' }))).toBe(3);
  });

  it('the offer button follows eligible_as and the can_* flags', () => {
    const offer = (eligible: OfferCard['eligible_as'], accept = false, reserve = false) =>
      ({ eligible_as: eligible, can_accept: accept, can_reserve_next: reserve }) as OfferCard;
    expect(offerAction(offer('accept', true))).toBe('accept');
    expect(offerAction(offer('reserve_next', false, true))).toBe('reserve_next');
    expect(offerAction(offer('view_only'))).toBe('none');
    expect(offerAction(offer('accept', false))).toBe('none');
  });

  it('a promotion is the previous next task becoming the current one', () => {
    const next = card({ status: 'assigned_waiting', ticket: 'assigned_waiting' });
    const before = {
      next_task: next,
      current_task: card({ type: 'park', status: 'in_progress', ticket: 'parking' }),
    };
    const after = { next_task: null, current_task: { ...next, task: { ...next.task, status: 'accepted' } } };
    expect(promotedTask(before as DriverHome, after as DriverHome)?.task.id).toBe('task-1');
    expect(promotedTask(undefined, after as DriverHome)).toBeNull();
    expect(promotedTask(after as DriverHome, after as DriverHome)).toBeNull();
    expect(findTask(after as DriverHome, 'task-1')?.task.status).toBe('accepted');
    expect(findTask(after as DriverHome, 'other')).toBeNull();
  });

  it('venue settings on driver screens: the home snapshot over the canon §12 defaults', () => {
    expect(fieldSettings(undefined)).toEqual({
      requiredPhotos: VENUE_DEFAULTS.inspection.required_photos,
      maxExtraPhotos: VENUE_DEFAULTS.inspection.max_extra_photos,
      parkingMode: 'mixed',
      requireSlot: true,
      offerTtlS: 30,
    });
    const home = {
      settings: { parking: { mode: 'free_text' }, keys: { require_slot: false } },
    } as DriverHome;
    expect(fieldSettings(home)).toMatchObject({ parkingMode: 'free_text', requireSlot: false });
  });
});
