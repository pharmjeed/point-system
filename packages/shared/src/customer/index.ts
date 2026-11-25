/**
 * `@point/shared/customer` — V2 wire contracts of the customer API `/v1/customer/*` (docs/v2/05_API_Integrations.md
 * §1), shared by the customer app (`apps/customer`, V2-011) and the server (V2-010). A separate entry point so the
 * app bundles only these schemas, not the whole staff canon; deliberately not re-exported from the package root.
 */
export * from './errors.js';
export * from './account.js';
export * from './auth.js';
export * from './vehicles.js';
export * from './locations.js';
export * from './home.js';
export * from './deletion.js';
export * from './routes.js';
// V2-013: the entry pass (C-11 / O-01)
export * from './pass.js';
export * from './pass-contract.js';
// V2-015 / V2-016: the visits (C-12, C-16, C-13), push and the customer realtime namespace
export * from './visits.js';
export * from './notifications.js';
// V2-022 / V2-023: paying a visit in the app (C-10/C-12) and the saved cards (C-18)
export * from './payments.js';
// V2-032: the subscriptions (C-09, C-10, C-14)
export * from './subscriptions.js';
// V2-040: C-17 invoices and credit notes
export * from './invoices.js';
// V2-037: C-21 / C-22 complaints with a reference number
export * from './complaints.js';
export {
  COMPLAINT_CATEGORIES,
  COMPLAINT_LIMITS,
  COMPLAINT_STATUSES,
  complaintReference,
  type ComplaintCategory,
  type ComplaintStatus,
} from '../canon/complaints.js';
// V2-036: the counted-day arithmetic the freeze sheet previews (the server decides)
export {
  addDays,
  countServiceDays,
  daysBetween,
  freezeRequestCheck,
  isServiceDay,
  maskOfWeekdays,
  nextServiceDayOnOrAfter,
  nthServiceDay,
  remainingServiceDays,
  resumedTermEnd,
  riyadhDate,
  serviceTerm,
  SERVICE_DAY_RULES,
  weekdayOf,
  type FreezeRequestIssue,
  type IsoDate,
} from '../canon/service-days.js';
export { maskPhone, normalizeSaudiMobile, SAUDI_MOBILE_E164_RE } from '../phone.js';
export {
  normalizeSaudiPlate,
  plateLettersFromTyping,
  saudiPlateDisplay,
  SAUDI_PLATE_LETTERS,
  VEHICLE_COLOR_LABELS_AR,
  VEHICLE_MAKE_LABELS_AR,
  type SaudiPlate,
  type SaudiPlateIssue,
  type SaudiPlateResult,
  type VehicleColorKey,
  type VehicleMakeKey,
} from '../vehicle.js';
export * from '../vehicle-art.js';
export { successEnvelopeSchema, successMetaSchema, type SuccessMeta } from '../envelopes.js';
