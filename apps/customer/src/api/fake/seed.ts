/**
 * Sample listed locations for the fake backend (development and tests only). Fictional venues and operators in
 * Riyadh; prices in halalas, VAT included. Opening hours in the venue's local time (Asia/Riyadh).
 */
import type { CustomerLocationDetail, CustomerLocationPlan } from '@point/shared/customer';

/** V2-036: the subscription terms version the purchase consent names (server: CUSTOMER_SUBSCRIPTION_TERMS_VERSION). */
export const FAKE_SUBSCRIPTION_TERMS_VERSION = '2026-11-17';

/** A VAT-inclusive price's net, VAT and total (the server's `vatOfInclusive`, 15%). */
export function fakeBreakdown(total: number | null) {
  if (total === null) return null;
  const net = Math.round((total * 10_000) / 11_500);
  return { net_halalas: net, vat_halalas: total - net, total_halalas: total, vat_rate_bp: 1500 };
}

const CALENDAR_POLICY: CustomerLocationPlan['policy'] = {
  term_kind: 'calendar',
  service_days: null,
  service_weekdays: null,
  renewal_mode: 'auto',
  refund_policy: 'prorated_on_termination',
  closure_policy: 'freeze',
  daily_visit_limit: null,
  freeze_max_times: 0,
  freeze_max_days: null,
  eligibility: 'none',
  vehicle_change: 'once_per_period',
};

/** A V4 plan of the seed (calendar term, renewed automatically): the policies the server gives it by default. */
function plan(p: {
  plan_id: string;
  name_ar: string;
  vehicles_included: number;
  monthly_price_halalas: number | null;
  yearly_price_halalas: number | null;
}): CustomerLocationPlan {
  return {
    ...p,
    policy: CALENDAR_POLICY,
    audience_ar: null,
    monthly_breakdown: fakeBreakdown(p.monthly_price_halalas),
    yearly_breakdown: fakeBreakdown(p.yearly_price_halalas),
    sold_out: false,
    terms_version: FAKE_SUBSCRIPTION_TERMS_VERSION,
    privacy_version: '2026-11-01',
    term_preview: null,
  };
}

/** The student plan of a fictional university (V2-036): 22 counted days Sunday … Thursday, 150 SAR + VAT. */
export const FAKE_STUDENT_PLAN_ID = '0a7e9a52-1f0b-4a51-9c3e-2b6d8f1a0c08';
export const FAKE_UNIVERSITY_ID = '6f1c2a10-3b4d-4e5f-8a9b-0c1d2e3f4a07';

const weekdays = (open: string, close: string) => ({
  sun: [{ open, close }],
  mon: [{ open, close }],
  tue: [{ open, close }],
  wed: [{ open, close }],
  thu: [{ open, close }],
});

export const FAKE_LOCATIONS: readonly CustomerLocationDetail[] = [
  {
    venue_id: '6f1c2a10-3b4d-4e5f-8a9b-0c1d2e3f4a01',
    name_ar: 'برج الأعمال — العليا',
    name_en: 'Business Tower — Olaya',
    category: 'office',
    operator_name_ar: 'ركن لخدمات الصف',
    operator_name_en: 'Rukn Valet',
    city: 'الرياض',
    lat: 24.6936,
    lng: 46.6853,
    distance_m: null,
    open_now: null,
    subscriptions_enabled: true,
    pay_per_visit_halalas: 2500,
    monthly_from_halalas: 34500,
    address: 'طريق العليا العام، حي العليا',
    timezone: 'Asia/Riyadh',
    opening_hours: { always_open: false, days: weekdays('07:00', '20:00') },
    photo_urls: [],
    plans: [
      plan({
        plan_id: '0a7e9a52-1f0b-4a51-9c3e-2b6d8f1a0c01',
        name_ar: 'اشتراك سيارة واحدة',
        vehicles_included: 1,
        monthly_price_halalas: 34500,
        yearly_price_halalas: 345000,
      }),
    ],
    closures: [],
  },
  {
    venue_id: '6f1c2a10-3b4d-4e5f-8a9b-0c1d2e3f4a02',
    name_ar: 'مجمع الواحة التجاري',
    name_en: 'Al Waha Mall',
    category: 'mall',
    operator_name_ar: 'ركن لخدمات الصف',
    operator_name_en: 'Rukn Valet',
    city: 'الرياض',
    lat: 24.7743,
    lng: 46.7386,
    distance_m: null,
    open_now: null,
    subscriptions_enabled: true,
    pay_per_visit_halalas: 2000,
    monthly_from_halalas: 23000,
    address: 'طريق الملك عبدالله، حي الواحة',
    timezone: 'Asia/Riyadh',
    opening_hours: {
      always_open: false,
      days: {
        sun: [{ open: '10:00', close: '01:00' }],
        mon: [{ open: '10:00', close: '01:00' }],
        tue: [{ open: '10:00', close: '01:00' }],
        wed: [{ open: '10:00', close: '01:00' }],
        thu: [{ open: '10:00', close: '01:00' }],
        fri: [{ open: '16:00', close: '01:00' }],
        sat: [{ open: '10:00', close: '01:00' }],
      },
    },
    photo_urls: [],
    plans: [
      plan({
        plan_id: '0a7e9a52-1f0b-4a51-9c3e-2b6d8f1a0c02',
        name_ar: 'اشتراك سيارة واحدة',
        vehicles_included: 1,
        monthly_price_halalas: 23000,
        yearly_price_halalas: 230000,
      }),
    ],
    closures: [],
  },
  {
    venue_id: '6f1c2a10-3b4d-4e5f-8a9b-0c1d2e3f4a03',
    name_ar: 'مستشفى النخيل التخصصي',
    name_en: 'Al Nakheel Specialist Hospital',
    category: 'hospital',
    operator_name_ar: 'صف المدينة',
    operator_name_en: 'City Valet',
    city: 'الرياض',
    lat: 24.7451,
    lng: 46.6573,
    distance_m: null,
    open_now: null,
    subscriptions_enabled: true,
    pay_per_visit_halalas: 1500,
    monthly_from_halalas: 17500,
    address: 'طريق الأمير تركي، حي النخيل',
    timezone: 'Asia/Riyadh',
    opening_hours: { always_open: true, days: {} },
    photo_urls: [],
    plans: [
      plan({
        plan_id: '0a7e9a52-1f0b-4a51-9c3e-2b6d8f1a0c03',
        name_ar: 'اشتراك سيارة واحدة',
        vehicles_included: 1,
        monthly_price_halalas: 17500,
        yearly_price_halalas: null,
      }),
    ],
    closures: [],
  },
  {
    venue_id: '6f1c2a10-3b4d-4e5f-8a9b-0c1d2e3f4a04',
    name_ar: 'فندق الياسمين',
    name_en: 'Al Yasmin Hotel',
    category: 'hotel',
    operator_name_ar: 'صف المدينة',
    operator_name_en: 'City Valet',
    city: 'الرياض',
    lat: 24.8232,
    lng: 46.6411,
    distance_m: null,
    open_now: null,
    subscriptions_enabled: false,
    pay_per_visit_halalas: 3000,
    monthly_from_halalas: null,
    address: 'طريق أنس بن مالك، حي الياسمين',
    timezone: 'Asia/Riyadh',
    opening_hours: { always_open: true, days: {} },
    photo_urls: [],
    plans: [],
    closures: [],
  },
  {
    venue_id: '6f1c2a10-3b4d-4e5f-8a9b-0c1d2e3f4a05',
    name_ar: 'قاعة الريم للاحتفالات',
    name_en: 'Al Reem Hall',
    category: 'hall',
    operator_name_ar: 'ركن لخدمات الصف',
    operator_name_en: 'Rukn Valet',
    city: 'الرياض',
    lat: 24.7136,
    lng: 46.7753,
    distance_m: null,
    open_now: null,
    subscriptions_enabled: false,
    pay_per_visit_halalas: null,
    monthly_from_halalas: null,
    address: 'طريق خريص، حي الروضة',
    timezone: 'Asia/Riyadh',
    opening_hours: {
      always_open: false,
      days: { wed: [{ open: '19:00', close: '02:00' }], thu: [{ open: '19:00', close: '02:00' }] },
    },
    photo_urls: [],
    plans: [],
    closures: [],
  },
  {
    venue_id: '6f1c2a10-3b4d-4e5f-8a9b-0c1d2e3f4a06',
    name_ar: 'نادي الشاطئ الرياضي',
    name_en: 'Shore Sports Club',
    category: 'club',
    operator_name_ar: 'صف المدينة',
    operator_name_en: 'City Valet',
    city: 'الرياض',
    lat: 24.6573,
    lng: 46.7111,
    distance_m: null,
    open_now: null,
    subscriptions_enabled: true,
    pay_per_visit_halalas: 1800,
    monthly_from_halalas: 20000,
    address: 'طريق الملك فهد، حي الملز',
    timezone: 'Asia/Riyadh',
    opening_hours: { always_open: false, days: weekdays('06:00', '23:00') },
    photo_urls: [],
    plans: [
      plan({
        plan_id: '0a7e9a52-1f0b-4a51-9c3e-2b6d8f1a0c06',
        name_ar: 'اشتراك سيارة واحدة',
        vehicles_included: 1,
        monthly_price_halalas: 20000,
        yearly_price_halalas: 200000,
      }),
      plan({
        plan_id: '0a7e9a52-1f0b-4a51-9c3e-2b6d8f1a0c07',
        name_ar: 'اشتراك سيارتين',
        vehicles_included: 2,
        monthly_price_halalas: 36000,
        yearly_price_halalas: 360000,
      }),
    ],
    closures: [],
  },
  {
    venue_id: FAKE_UNIVERSITY_ID,
    name_ar: 'جامعة الأفق — الحرم الرئيسي',
    name_en: 'Al Ufuq University — Main Campus',
    category: 'other',
    operator_name_ar: 'ركن لخدمات الصف',
    operator_name_en: 'Rukn Valet',
    city: 'الرياض',
    lat: 24.7255,
    lng: 46.6231,
    distance_m: null,
    open_now: null,
    subscriptions_enabled: true,
    pay_per_visit_halalas: 2500,
    monthly_from_halalas: 17250,
    address: 'طريق الجامعة، حي الأفق',
    timezone: 'Asia/Riyadh',
    opening_hours: { always_open: false, days: weekdays('07:00', '17:00') },
    photo_urls: [],
    plans: [
      {
        ...plan({
          plan_id: FAKE_STUDENT_PLAN_ID,
          name_ar: 'باقة الطالب الشهرية',
          vehicles_included: 1,
          monthly_price_halalas: 17250,
          yearly_price_halalas: null,
        }),
        policy: {
          term_kind: 'service_days',
          service_days: 22,
          service_weekdays: [0, 1, 2, 3, 4],
          renewal_mode: 'manual',
          refund_policy: 'non_refundable',
          closure_policy: 'continue',
          daily_visit_limit: 1,
          freeze_max_times: 1,
          freeze_max_days: 5,
          eligibility: 'student_id_review',
          vehicle_change: 'any_time',
        },
        audience_ar: 'طلاب وطالبات الجامعة',
      },
    ],
    closures: [
      {
        closure_id: '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e01',
        kind: 'holiday',
        starts_on: '2026-12-27',
        ends_on: '2027-01-07',
        reason_ar: 'إجازة منتصف العام الدراسي',
      },
    ],
  },
];

/** The versions of the texts in force (settings on the server). */
export const FAKE_CONSENT_VERSIONS = {
  terms: '2026-11-01',
  privacy: '2026-11-01',
  marketing: '2026-11-01',
} as const;

/** V2-022 / V2-023: the «save the card» consent version (server: CUSTOMER_CARD_ON_FILE_VERSION). */
export const FAKE_CARD_ON_FILE_VERSION = '2026-11-01';
/** The demo visit's fee, VAT included (the server's ticket fee, 13 §4). */
export const FAKE_VISIT_FEE_HALALAS = 2000;
