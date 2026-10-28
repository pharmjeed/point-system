import { describe, expect, it } from 'vitest';
import type { Reconciliation, Settlement } from '@/api/types';
import {
  cashDrivers,
  cashOutstandingHalalas,
  openBlockers,
  riyalsToHalalas,
  withBlockers,
} from '@/features/supervisor/closeModel';
import { ticketSummary } from './fixtures';

describe('S-10 close and cash (13 §10–§12)', () => {
  const rec: Reconciliation = {
    event_id: 'e-1',
    can_close: true,
    blockers: {
      open_tickets: [],
      keys_not_in_slots: [],
      open_requests: [],
      open_tasks: [],
      unsettled_payments: [],
      cash_outstanding: [],
      payment_integrity: [],
    },
    warnings: { open_incidents: [], failed_messages: [], cash_discrepancies: [] },
  };

  it('takes the blockers of EVENT_CLOSE_BLOCKED over the last reconciliation', () => {
    const blocked = withBlockers(rec, {
      blockers: {
        open_tickets: [ticketSummary({ display_number: 51 })],
        cash_outstanding: [{ driver: { id: 'd-1', full_name: 'خالد' }, amount_halalas: 7500 }],
      },
    });
    expect(blocked.can_close).toBe(false);
    expect(openBlockers(blocked.blockers)).toEqual(['open_tickets', 'cash_outstanding']);
    expect(cashOutstandingHalalas(blocked.blockers)).toBe(7500);
    expect(withBlockers(rec, {})).toBe(rec);
    expect(withBlockers(rec, { blockers: 'x' })).toBe(rec);
  });

  it('reads a typed amount in riyals as integer halalas', () => {
    expect(riyalsToHalalas('150')).toBe(15000);
    expect(riyalsToHalalas('150.5')).toBe(15050);
    expect(riyalsToHalalas('٢٥٫٧٥')).toBe(2575);
    expect(riyalsToHalalas('0')).toBe(0);
    expect(riyalsToHalalas('1.234')).toBeNull();
    expect(riyalsToHalalas('-5')).toBeNull();
    expect(riyalsToHalalas('')).toBeNull();
  });

  it('lists only the drivers with cash activity', () => {
    const line = (id: string, count: number, outstanding: number) => ({
      driver: { id, full_name: id },
      cash: {
        count,
        collected_halalas: count * 2500,
        handed_over_halalas: 0,
        outstanding_halalas: outstanding,
        difference_adjusted_halalas: 0,
      },
      pos: { count: 1, halalas: 2500 },
    });
    const settlement = { drivers: [line('a', 2, 5000), line('b', 0, 0)] } as unknown as Settlement;
    expect(cashDrivers(settlement).map((d) => d.driver.id)).toEqual(['a']);
  });
});
