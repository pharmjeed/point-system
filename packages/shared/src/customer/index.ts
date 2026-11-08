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
