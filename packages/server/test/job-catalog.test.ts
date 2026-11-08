import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JOB_TYPES } from '@point/shared';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function sources(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) {
      if (f !== 'node_modules' && f !== 'dist') sources(p, out);
    } else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Server sweep (canon §7.2): every `job.*` type has a producer in the server code — a durable timer
 * (`schedule(tx, type, at, …)`), an outbox row (`enqueue(tx, { type, … })`) or a notification job descriptor
 * (`job: { type, … }`, enqueued with its notification by the planners). Their handlers are checked by
 * apps/worker/test/handlers.test.ts; each job's behaviour by its module's integration tests.
 */
describe('job catalog (canon §7.2)', () => {
  const code = sources(join(ROOT, 'packages/server/src'))
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');
  /** `export const READY_UNCOLLECTED_JOB = 'job.ready_uncollected_check'` and the like */
  const constants = new Map<string, string[]>();
  for (const m of code.matchAll(/const ([A-Z][A-Z0-9_]*) = '(job\.[a-z_]+)'/g))
    constants.set(m[2]!, [...(constants.get(m[2]!) ?? []), m[1]!]);

  it.each([...JOB_TYPES])('%s has a producer', (type) => {
    const names = [`'${esc(type)}'`, ...(constants.get(type) ?? []).map(esc)].join('|');
    const forms = [
      new RegExp(`schedule\\(\\s*tx,\\s*(?:${names})\\s*,`),
      new RegExp(`enqueue\\(\\s*tx,\\s*\\{\\s*type:\\s*(?:${names})\\s*,`),
      new RegExp(`job:\\s*\\{\\s*type:\\s*(?:${names})\\s*,`),
    ];
    expect(
      forms.some((f) => f.test(code)),
      `nothing schedules or enqueues ${type}`,
    ).toBe(true);
  });
});
