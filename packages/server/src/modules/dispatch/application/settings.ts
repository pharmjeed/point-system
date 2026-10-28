import type { Tx } from '../../../core/db/tx.js';
import { venueSettingsFor } from '../../venues-events/index.js';

/** 10 §13.2 — read from venues.settings at the start of every pass/handler (no cache across transactions). */
export interface DispatchSettings {
  singleOfferReminderS: number;
  singleOfferTtlS: number;
  broadcastReminderS: number;
  unacceptedEscalationS: number;
  nextTaskWaitAlertS: number;
  idleDriverAlert: boolean;
  readyUncollectedAlertMin: number;
  /** dispatch.accept_grace_ms (DEC-47) */
  acceptGraceMs: number;
  offlineDriversLast: boolean;
}

export async function dispatchSettings(tx: Pick<Tx, 'query'>, venueId: string): Promise<DispatchSettings> {
  const s = await venueSettingsFor(tx, venueId);
  return {
    singleOfferReminderS: s.dispatch.single_offer_reminder_s,
    singleOfferTtlS: s.dispatch.single_offer_ttl_s,
    broadcastReminderS: s.dispatch.broadcast_reminder_s,
    unacceptedEscalationS: s.dispatch.unaccepted_escalation_s,
    nextTaskWaitAlertS: s.dispatch.next_task_wait_alert_s,
    idleDriverAlert: s.dispatch.idle_driver_alert,
    readyUncollectedAlertMin: s.ready.uncollected_alert_min,
    acceptGraceMs: s.dispatch.accept_grace_ms,
    offlineDriversLast: s.dispatch.offline_drivers_last,
  };
}

export const addMs = (d: Date, ms: number) => new Date(d.getTime() + ms);
