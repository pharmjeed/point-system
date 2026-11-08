import { JOB_TYPES } from '@point/shared';
import { describe, expect, it } from 'vitest';
import { allHandlers } from '../src/handlers.js';

/** The worker registers each canon job (canon §7.2) exactly once; the dispatcher refuses duplicates. */
describe('worker handlers', () => {
  it('one handler per job type, every type from the canon, job.export_generate included (PNT-089)', () => {
    const types = allHandlers().map((h) => h.type);
    expect(new Set(types).size).toBe(types.length);
    expect(types.filter((x) => !(JOB_TYPES as readonly string[]).includes(x))).toEqual([]);
    expect(types).toContain('job.export_generate');
    expect(allHandlers().find((h) => h.type === 'job.export_generate')?.mode).toBe('external');
  });

  it('no canon job is left without a handler (server sweep: canon §7.2)', () => {
    const types = new Set(allHandlers().map((h) => h.type));
    expect(JOB_TYPES.filter((t) => !types.has(t))).toEqual([]);
    // + job.customer_otp_send (V2-010), the 3 payment jobs (V2-021), the saved-card token deletion (V2-023)
    expect(JOB_TYPES).toHaveLength(18 + 1 + 3 + 1);
  });

  it('the network jobs run outside a transaction (mode external, 04 §6.4)', () => {
    const mode = new Map(allHandlers().map((h) => [h.type, h.mode]));
    for (const t of [
      'job.wa_send',
      'job.wa_process_inbound',
      'job.push_send',
      'job.export_generate',
      'job.customer_otp_send',
      'job.payment_webhook_process',
      'job.payment_refund_send',
      'job.payments_reconcile',
      'job.payment_method_token_delete',
    ])
      expect(mode.get(t as (typeof JOB_TYPES)[number]), t).toBe('external');
  });
});
