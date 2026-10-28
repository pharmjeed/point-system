/**
 * venues-events module (PNT-018 … PNT-020): venues and their settings, dispatch pools, parking zones/spots, key
 * boards/slots, the event lifecycle (draft → open, reopen, cancel) and shifts (open/close with automatic duty end).
 *
 * Other modules use only what is exported here. Shift close releases each auto-ended driver through the core
 * `releaseDriverWork` seam (core/hooks/driver-release.ts) that the dispatch module implements.
 */
export { VenuesEventsHttpModule } from './http/venues-events.module.js';
export { venueSettingsFor } from './application/venues.service.js';
export {
  findDefaultDispatchPool,
  findOpenShiftForPool,
  listVenueEventsByStatus,
  type VenueOpenEvent,
} from './application/read-api.js';
