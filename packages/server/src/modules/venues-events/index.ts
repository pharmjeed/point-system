/**
 * venues-events module (PNT-018, PNT-019): venues and their settings, dispatch pools, parking zones/spots, key
 * boards/slots and the event lifecycle (draft → open, reopen, cancel).
 *
 * Other modules use only what is exported here.
 */
export { VenuesEventsHttpModule } from './http/venues-events.module.js';
export { venueSettingsFor } from './application/venues.service.js';
export {
  findDefaultDispatchPool,
  listVenueEventsByStatus,
  type VenueOpenEvent,
} from './application/read-api.js';
