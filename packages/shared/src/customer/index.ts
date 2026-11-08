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
export { maskPhone, normalizeSaudiMobile, SAUDI_MOBILE_E164_RE } from '../phone.js';
export {
  normalizeSaudiPlate,
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
export { successEnvelopeSchema, successMetaSchema, type SuccessMeta } from '../envelopes.js';
