/**
 * venues-events module (PNT-018): venues and their settings, dispatch pools, parking zones/spots and key
 * boards/slots.
 *
 * Other modules use only what is exported here.
 */
export { VenuesEventsHttpModule } from './http/venues-events.module.js';
export { venueSettingsFor } from './application/venues.service.js';
export { findDefaultDispatchPool } from './application/read-api.js';
