import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { registry } from '../src/core/metrics/metrics.js';
import { ROOT, catalog } from './metric-catalog-doc.js';

const RULES = join(ROOT, 'infra/monitoring/prometheus-rules.yml');

interface Rule {
  alert: string;
  expr: string;
  severity: string | null;
}

/** The rules of the file (its layout is fixed: `- alert:` then `expr:` and `severity:` lines; no YAML dependency). */
function rules(): Rule[] {
  const out: Rule[] = [];
  let cur: Rule | null = null;
  for (const line of readFileSync(RULES, 'utf8').split('\n')) {
    const a = /^\s+- alert: (\S+)\s*$/.exec(line);
    if (a) {
      cur = { alert: a[1]!, expr: '', severity: null };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    const e = /^\s+expr: (.+)$/.exec(line);
    if (e) cur.expr = e[1]!.trim();
    const s = /^\s+severity: (\S+)\s*$/.exec(line);
    if (s) cur.severity = s[1]!;
  }
  return out;
}

/** Histogram buckets of the registry, by metric name. */
async function bucketsOf(name: string): Promise<number[]> {
  const m = registry.getSingleMetric(name) as unknown as { upperBounds?: readonly number[] } | undefined;
  return [...(m?.upperBounds ?? [])];
}

/**
 * The operator's alerting rules (A-metrics-9): 15 §12's «مراقبة» rows, 12 §13's thresholds, 10 §12.2's timer lag and
 * 05 §12.3's backup failure, written with catalog names only (15 §12, DEC-159), each able to fire.
 */
describe('infra/monitoring/prometheus-rules.yml', () => {
  const all = rules();
  const byName = new Map(all.map((r) => [r.alert, r]));

  it('every rule has an expression and a severity of warning or critical; names are unique', () => {
    expect(all.length).toBeGreaterThanOrEqual(25);
    expect(byName.size).toBe(all.length);
    for (const r of all) {
      expect(r.expr, r.alert).not.toBe('');
      expect(['warning', 'critical'], r.alert).toContain(r.severity);
    }
  });

  it('every metric a rule reads is a name of the 05 §12.2 catalog (15 §12: no other names)', () => {
    const names = new Set(catalog().map((m) => m.name));
    const unknown = all.flatMap((r) =>
      [...r.expr.matchAll(/\b(point_[a-z0-9_]+)/g)]
        .map((m) => m[1]!.replace(/_(bucket|count|sum)$/, ''))
        .filter((n) => !names.has(n))
        .map((n) => `${r.alert}: ${n}`),
    );
    expect(unknown).toEqual([]);
  });

  it('every quantile threshold is a bucket bound below the last one (a rule past the buckets never fires)', async () => {
    const problems: string[] = [];
    let checked = 0;
    for (const r of all) {
      const q = /histogram_quantile\([0-9.]+,.*?\b(point_[a-z0-9_]+)_bucket\b.*\)\s*>\s*([0-9.]+)\s*$/.exec(
        r.expr,
      );
      if (!q) continue;
      checked++;
      const bounds = await bucketsOf(q[1]!);
      const threshold = Number(q[2]);
      if (!bounds.includes(threshold) || Math.max(...bounds) <= threshold)
        problems.push(`${r.alert}: ${q[1]} > ${threshold} with buckets ${bounds.join(',')}`);
    }
    expect(checked).toBe(9); // timer lag, publish ×2, request save ×4, WhatsApp send and webhook
    expect(problems).toEqual([]);
  });

  it('covers the «مراقبة» rows of 15 §12, the thresholds of 12 §13, the timer lag of 10 §12.2 and the backup of 05 §12.3', () => {
    const required = {
      // 15 §12
      'ارتفاع عمر Outbox': ['PointOutboxLag'],
      'مهام ميتة': ['PointOutboxDead'],
      'توقف الـWebhooks': ['PointWebhooksSilent'],
      'نسبة أخطاء الإرسال': ['PointWaSendErrorRatio', 'PointWaSendErrorRatioCritical'],
      'غياب السائقين قبل الطلبات': ['PointNoDriverBeforeRequests'],
      'مهام معلقة (ضعف الحد)': ['PointTasksStuckCritical'],
      'تجاوز زمن الانتظار الكلي': ['PointRequestWaitLong', 'PointRequestWaitCritical'],
      'أداء حفظ الطلب': [
        'PointRequestSaveSlow',
        'PointRequestSaveCritical',
        'PointApiRequestSaveSlow',
        'PointApiRequestSaveCritical',
      ],
      'أداء نشر الإسناد': ['PointAssignmentPublishSlow', 'PointAssignmentPublishCritical'],
      'فشل النسخ الاحتياطي': ['PointBackupStale', 'PointBackupFailed', 'PointBackupMetricAbsent'],
      // 12 §13
      point_wa_send_duration_seconds: ['PointWaSendSlow'],
      point_wa_webhook_duration_seconds: ['PointWaWebhookSlow'],
      point_wa_inbound_backlog: ['PointWaInboundBacklog'],
      point_wa_status_orphan_total: ['PointWaStatusOrphans'],
      point_wa_channel_health: ['PointWaChannelDegraded', 'PointWaChannelDown'],
      point_wa_service_messages_month: ['PointWaServiceMessagesMonth'],
      // 10 §12.2
      point_timer_lag_seconds: ['PointTimerLag'],
    };
    const missing = Object.entries(required).flatMap(([row, alerts]) =>
      alerts.filter((a) => !byName.has(a)).map((a) => `${row}: ${a}`),
    );
    expect(missing).toEqual([]);
    // the thresholds the rows give
    expect(byName.get('PointBackupStale')!.expr).toContain('> 93600'); // 26 h
    expect(byName.get('PointBackupFailed')!.expr).toContain('> 172800'); // 48 h
    expect(byName.get('PointBackupFailed')!.severity).toBe('critical');
    expect(byName.get('PointRequestWaitLong')!.expr).toContain('> 600');
    expect(byName.get('PointRequestWaitCritical')!.expr).toContain('> 1200');
    expect(byName.get('PointWaServiceMessagesMonth')!.expr).toContain('>= 800');
  });
});
