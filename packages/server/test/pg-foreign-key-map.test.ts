import { describe, expect, it } from 'vitest';
import { mapPgError } from '../src/core/errors/pg-constraint-map.js';

const EVENT = '0f8e3b2a-6c1d-4e5f-9a7b-1c2d3e4f5a6b';
const fk = (detail?: string) => ({
  code: '23503',
  constraint: 'tickets_event_id_fkey',
  ...(detail === undefined ? {} : { detail }),
});
const missingEvent = fk(`Key (event_id)=(${EVENT}) is not present in table "events".`);

/** 08 §5.4: 23503 → RESOURCE_NOT_FOUND when the key came from the request's input, INTERNAL_ERROR otherwise. */
describe('foreign-key violations (08 §5.4)', () => {
  it('a key the request named (body, path, query; any depth, any case) is RESOURCE_NOT_FOUND with the table', () => {
    for (const input of [
      { params: {}, query: {}, body: { event_id: EVENT } },
      { params: { eventId: EVENT.toUpperCase() }, query: {}, body: null },
      { params: {}, query: { event: EVENT }, body: {} },
      { params: {}, query: {}, body: { items: [{ ref: { event_id: EVENT } }] } },
    ]) {
      const m = mapPgError(missingEvent, { operation: 'POST /v1/tickets', input });
      expect(m).toMatchObject({ unexpected: false });
      expect(m.error.code).toBe('RESOURCE_NOT_FOUND');
      expect(m.error.details).toEqual({ resource: 'events' });
    }
  });

  it('a key the server filled itself is a programming error: INTERNAL_ERROR, unexpected, the constraint kept', () => {
    const m = mapPgError(missingEvent, { operation: 'POST /v1/tickets', input: { body: { plate: '4821' } } });
    expect(m.error.code).toBe('INTERNAL_ERROR');
    expect(m.unexpected).toBe(true);
    expect(m.error.options.cause).toBe('tickets_event_id_fkey');
    // outside a request (a worker job) and without the detail nothing proves the key came from an input
    expect(mapPgError(missingEvent).error.code).toBe('INTERNAL_ERROR');
    expect(mapPgError(fk(), { input: { body: { event_id: EVENT } } }).error.code).toBe('INTERNAL_ERROR');
  });

  it('a composite key is from the input only when every value is', () => {
    const both = fk(`Key (org_id, venue_id)=(a1, b2) is not present in table "venues".`);
    expect(mapPgError(both, { input: { body: { org: 'a1', venue: 'b2' } } }).error.code).toBe(
      'RESOURCE_NOT_FOUND',
    );
    expect(mapPgError(both, { input: { body: { venue: 'b2' } } }).error.code).toBe('INTERNAL_ERROR');
  });
});
