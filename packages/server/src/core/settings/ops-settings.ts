import { orgSettingsSchema } from '@point/shared';

const OPS_SECTION = orgSettingsSchema.shape.ops;
const DEFAULT_LAG_THRESHOLD_S = OPS_SECTION.parse({}).outbox_lag_alert_s;

/**
 * `ops.outbox_lag_alert_s` of an organization's settings, read on its own (14 §8 `outbox_lag`; the readiness probe's
 * `degraded`). Nothing stops over settings: a section that does not parse falls back to the canon §12 default (30 s).
 */
export function outboxLagThresholdS(settings: unknown): number {
  const ops =
    settings && typeof settings === 'object' ? (settings as Record<string, unknown>).ops : undefined;
  const r = OPS_SECTION.safeParse(ops ?? {});
  return r.success ? r.data.outbox_lag_alert_s : DEFAULT_LAG_THRESHOLD_S;
}
