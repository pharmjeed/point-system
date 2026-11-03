import { describe, expect, it } from 'vitest';
import {
  custodyRepublishesTaskCard,
  custodyTouchesTaskCard,
} from '../src/modules/tickets-custody/application/task-card.js';

/**
 * RT-2 (int-server review leftover): which official custody transfers bump the task (`custodyTouchesTaskCard`, in
 * the transfer) and which ones the dispatch planner republishes the assignee's TaskCard for
 * (`custodyRepublishesTaskCard`): also the key leaving / reaching a driver, whose pickup reset is bumped in the
 * transfer itself.
 */
describe('custody transfers that change the TaskCard', () => {
  it('a spot or a key slot on either side touches the card', () => {
    expect(custodyTouchesTaskCard('key', 'key_slot', 'key_slot')).toBe(true);
    expect(custodyTouchesTaskCard('key', 'driver', 'key_slot')).toBe(true);
    expect(custodyTouchesTaskCard('vehicle', 'spot', 'unknown')).toBe(true);
    expect(custodyTouchesTaskCard('vehicle', 'key_slot', 'supervisor')).toBe(false);
    expect(custodyTouchesTaskCard('key', 'driver', 'supervisor')).toBe(false);
  });

  it('the key of an accepted retrieval leaving its assignee for a supervisor or unknown is republished', () => {
    expect(custodyRepublishesTaskCard('key', 'driver', 'supervisor')).toBe(true);
    expect(custodyRepublishesTaskCard('key', 'driver', 'unknown')).toBe(true);
    expect(custodyRepublishesTaskCard('key', 'unknown', 'driver')).toBe(true);
    expect(custodyRepublishesTaskCard('key', 'key_slot', 'key_slot')).toBe(true);
  });

  it('a key between supervisors / unknown, or a vehicle with a driver, is not', () => {
    expect(custodyRepublishesTaskCard('key', 'supervisor', 'unknown')).toBe(false);
    expect(custodyRepublishesTaskCard('vehicle', 'driver', 'supervisor')).toBe(false);
  });
});
