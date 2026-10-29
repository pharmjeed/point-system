import { readdirSync, readFileSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { metrics, registry, startMetricsServer } from '../src/core/metrics/metrics.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** The metric names (and labels) of the binding catalog, 05 §12.2. */
function catalog(): { name: string; labels: string[] }[] {
  const text = readFileSync(join(ROOT, 'docs/05_Tech_Stack_Environment.md'), 'utf8');
  const from = text.indexOf('### 12.2');
  const to = text.indexOf('### 12.3', from);
  const out: { name: string; labels: string[] }[] = [];
  for (const line of text.slice(from, to).split('\n')) {
    if (!line.startsWith('| `point_')) continue;
    const first = line.split('|')[1] ?? '';
    for (const m of first.matchAll(/`(point_[a-z0-9_]+)(?:\{([a-z_,]+)\})?`/g))
      out.push({ name: m[1]!, labels: m[2] ? m[2].split(',').sort() : [] });
  }
  return out;
}

/** Metrics of 05 §12.2 that no long-running process exports (DEC-303: a node_exporter textfile of backup.sh). */
const EXTERNAL = new Set(['point_backup_last_success_timestamp_seconds']);

function sources(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) {
      if (f !== 'node_modules' && f !== 'dist') sources(p, out);
    } else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

describe('metric catalog (05 §12.2)', () => {
  const docs = catalog();

  it('reads the catalog', () => {
    expect(docs).toHaveLength(44);
    expect(Object.keys(metrics)).toHaveLength(43); // every catalog metric but the backup textfile one
    expect(docs.map((d) => d.name)).toContain('point_wa_service_messages_month');
  });

  it('every catalog metric is registered with its labels, except the backup textfile one', () => {
    for (const d of docs) {
      const m = registry.getSingleMetric(d.name) as { labelNames?: string[] } | undefined;
      if (EXTERNAL.has(d.name)) {
        expect(m, `${d.name} is written by backup.sh, not by a process`).toBeUndefined();
        continue;
      }
      expect(m, `${d.name} is not registered`).toBeDefined();
      expect([...(m?.labelNames ?? [])].sort(), d.name).toEqual(d.labels);
    }
  });

  it('nothing outside the catalog is registered (besides the default process metrics)', async () => {
    const names = (await registry.getMetricsAsJSON()).map((m) => m.name);
    const known = new Set(docs.map((d) => d.name));
    expect(names.filter((n) => !n.startsWith('point_process_') && !known.has(n))).toEqual([]);
  });

  it('GET /metrics on the internal metrics server (canon §9.8) answers the registry; any other path is 404', async () => {
    const server = startMetricsServer(0, '127.0.0.1');
    try {
      await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())));
      const port = (server.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/plain');
      const body = await res.text();
      expect(body).toContain('# TYPE point_http_request_duration_seconds histogram');
      expect(body).toContain('# TYPE point_wa_service_messages_month gauge');
      expect(body).not.toContain('point_backup_last_success_timestamp_seconds');
      expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(404);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('every registered metric is populated somewhere in the api, worker or server code', () => {
    const files = [
      ...sources(join(ROOT, 'packages/server/src')),
      ...sources(join(ROOT, 'apps/api/src')),
      ...sources(join(ROOT, 'apps/worker/src')),
    ].filter((f) => !f.endsWith(join('core', 'metrics', 'metrics.ts')));
    const code = files.map((f) => readFileSync(f, 'utf8')).join('\n');
    const unused = Object.keys(metrics).filter(
      (k) => !new RegExp(`metrics\\.${k}\\.(?:inc|dec|set|observe|reset|startTimer)\\(`).test(code),
    );
    expect(unused).toEqual([]);
  });
});
