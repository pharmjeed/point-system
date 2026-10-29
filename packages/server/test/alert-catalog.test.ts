import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALERT_TYPES } from '@point/shared';
import { describe, expect, it } from 'vitest';
import { ALERT_SEVERITY, MULTI_VENUE_ALERTS } from '../src/core/alerts/alerts.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

interface Row {
  type: string;
  severity: string;
  dedupe: string;
}

/** 14 §8: one row per `alerts.type` — severity, dedupe key pattern. */
function catalog(): Row[] {
  const text = readFileSync(join(ROOT, 'docs/14_Notification_Matrix_Templates.md'), 'utf8');
  const from = text.indexOf('## 8. ');
  const to = text.indexOf('\n## 9. ', from);
  const rows: Row[] = [];
  for (const line of text.slice(from, to).split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    const type = /^`([a-z_]+)`$/.exec(cells[1] ?? '')?.[1];
    if (!type || type === 'alerts') continue;
    rows.push({ type, severity: cells[2] ?? '', dedupe: /`([^`]+)`/.exec(cells[4] ?? '')?.[1] ?? '' });
  }
  return rows;
}

function sources(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) {
      if (f !== 'node_modules' && f !== 'dist') sources(p, out);
    } else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

/**
 * Server sweep: every `alerts.type` of canon §5.7 / 14 §8 has its 14 §8 severity, a raising path and a
 * resolution path in the server code (the behaviour of each is tested by its producer's integration tests).
 */
describe('alert catalog (canon §5.7, 14 §8)', () => {
  const rows = catalog();
  const files = sources(join(ROOT, 'packages/server/src')).map((f) => ({
    f,
    code: readFileSync(f, 'utf8'),
  }));

  it('14 §8 lists exactly the canon types, with the severity the alert writer uses', () => {
    expect(rows.map((r) => r.type).sort()).toEqual([...ALERT_TYPES].sort());
    for (const r of rows)
      expect(ALERT_SEVERITY[r.type as keyof typeof ALERT_SEVERITY], r.type).toBe(r.severity);
  });

  it('the multi-venue types are the four of 14 §8 (DEC-46)', () => {
    expect([...MULTI_VENUE_ALERTS].sort()).toEqual(
      ['outbox_lag', 'transfer_blocked', 'wa_channel_down', 'wa_webhook_silent'].sort(),
    );
  });

  it.each(rows.map((r) => [r.type, r.dedupe] as const))(
    '%s is raised with its dedupe key and resolved somewhere',
    (type, dedupe) => {
      const prefix = dedupe.split(':')[0];
      expect(prefix).toBe(type);
      const raising = files.filter((x) => x.code.includes(`type: '${type}'`));
      expect(
        raising.map((x) => x.f),
        `no raiseAlert({ type: '${type}' })`,
      ).not.toEqual([]);
      // a resolution: a file that builds the type's dedupe keys and resolves alerts with them
      const resolving = files.filter(
        (x) =>
          (x.code.includes(`\`${type}:\${`) ||
            x.code.includes(`'${type}:'`) ||
            x.code.includes(`${type}:\${`)) &&
          (x.code.includes('autoResolveAlerts(') || /status = 'resolved'/.test(x.code)),
      );
      expect(
        resolving.map((x) => x.f),
        `nothing resolves ${type}`,
      ).not.toEqual([]);
    },
  );
});
