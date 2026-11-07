/**
 * PNT-096: the rate-limit class of every route (ROUTES.rateLimitClass) equals `x-rate-limit-class` of its
 * operation in docs/07_openapi.yaml, and the classes are exactly the rows of 07 §1.9.
 */
import { describe, expect, it } from 'vitest';
import { PLATFORM_ROUTES, RATE_LIMIT_CLASSES, ROUTES, routeKey } from '../src/index.js';
import { backticks, readDoc, section, tableRows } from './docs.js';

function openApiClasses(): Map<string, string> {
  const out = new Map<string, string>();
  let path: string | null = null;
  let op: string | null = null;
  for (const line of readDoc('07_openapi.yaml').split('\n')) {
    const p = /^ {2}(\/\S+):\s*$/.exec(line);
    if (p?.[1]) {
      path = p[1];
      op = null;
      continue;
    }
    if (/^\S/.test(line)) path = null;
    const m = path ? /^ {4}(get|post|put|patch|delete):\s*$/.exec(line) : null;
    if (path && m?.[1]) {
      op = `${m[1].toUpperCase()} ${path}`;
      continue;
    }
    const c = /^ {6}x-rate-limit-class: (\S+)\s*$/.exec(line);
    if (op && c?.[1]) out.set(op, c[1]);
  }
  return out;
}

describe('rate-limit classes (07 §1.9, x-rate-limit-class)', () => {
  const fromOpenApi = openApiClasses();

  it('every OpenAPI operation declares a class', () => {
    expect(fromOpenApi.size).toBe(ROUTES.length + PLATFORM_ROUTES.length);
  });

  it('ROUTES.rateLimitClass equals x-rate-limit-class for all canon routes and the platform routes', () => {
    const diff = [...ROUTES, ...PLATFORM_ROUTES]
      .filter((r) => fromOpenApi.get(routeKey(r.method, r.path)) !== r.rateLimitClass)
      .map(
        (r) =>
          `${routeKey(r.method, r.path)}: ours ${r.rateLimitClass}, openapi ${fromOpenApi.get(routeKey(r.method, r.path))}`,
      );
    expect(diff).toEqual([]);
  });

  it('the classes are exactly the rows of the 07 §1.9 table', () => {
    const rows = tableRows(section(readDoc('07_API_Contract.md'), '### 1.9'));
    const classes = rows.map((r) => backticks(r[0] ?? '')[0]).filter(Boolean);
    expect([...classes].sort()).toEqual([...RATE_LIMIT_CLASSES].sort());
    expect(new Set(fromOpenApi.values())).toEqual(new Set(RATE_LIMIT_CLASSES));
  });
});
