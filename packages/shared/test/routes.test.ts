/**
 * ROUTES equals canon §9 row for row (methods split, permission, ✓), every operation of
 * docs/07_openapi.yaml (x-permission, x-idempotency), and the route tables of file 09 §4.
 */
import { describe, expect, it } from 'vitest';
import {
  HTTP_METHODS,
  IDEMPOTENT_ROUTES,
  PERMISSIONS,
  PLATFORM_ROUTES,
  ROUTES,
  findPlatformRoute,
  findRoute,
  fromExpressPath,
  routeKey,
  toExpressPath,
} from '../src/index.js';
import type { HttpMethod } from '../src/index.js';
import { CUSTOMER_ROUTES, findCustomerRoute } from '../src/customer/index.js';
import { backticks, readDoc, section, stripParens, tableRows } from './docs.js';

const canon = readDoc('00_Glossary_Canon.md');

interface CanonRoute {
  method: string;
  path: string;
  permission: string;
  idempotent: boolean;
  section: string;
}

function canonRoutes(): CanonRoute[] {
  const out: CanonRoute[] = [];
  for (const sec of ['9.1', '9.2', '9.3', '9.4', '9.5', '9.6', '9.7']) {
    for (const r of tableRows(section(canon, `### ${sec}`))) {
      const methods = (r[0] ?? '').split('/').map((m) => m.trim());
      const path = backticks(r[1] ?? '')[0] ?? '';
      const permCell = stripParens(r[2] ?? '');
      const perms = permCell.includes('عام') ? ['public'] : backticks(permCell);
      const idemCell = r[3] ?? '';
      const idemMethods = idemCell.startsWith('✓')
        ? (/\(([^)]*)\)/.exec(idemCell)?.[1]?.match(/GET|POST|PUT|PATCH|DELETE/g) ?? methods)
        : [];
      methods.forEach((method, i) => {
        out.push({
          method,
          path,
          permission: perms.length === methods.length ? (perms[i] ?? '') : (perms[0] ?? ''),
          idempotent: idemMethods.includes(method),
          section: sec,
        });
      });
    }
  }
  for (const r of tableRows(section(canon, '### 9.8'))) {
    const guard = (r[2] ?? '').includes('عام')
      ? 'public'
      : (r[2] ?? '').includes('شبكة داخلية')
        ? 'internal'
        : 'webhook';
    for (const path of backticks(r[1] ?? '')) {
      out.push({ method: r[0] ?? '', path, permission: guard, idempotent: false, section: '9.8' });
    }
  }
  return out;
}

interface OpenApiOp {
  method: string;
  path: string;
  permission?: string;
  idempotency?: string;
}

function openApiOps(): OpenApiOp[] {
  const ops: OpenApiOp[] = [];
  let path: string | null = null;
  let cur: OpenApiOp | null = null;
  for (const line of readDoc('07_openapi.yaml').split('\n')) {
    const p = /^ {2}(\/\S+):\s*$/.exec(line);
    if (p?.[1]) {
      path = p[1];
      cur = null;
      continue;
    }
    if (/^\S/.test(line)) path = null;
    const m = path ? /^ {4}(get|post|put|patch|delete):\s*$/.exec(line) : null;
    if (path && m?.[1]) {
      cur = { method: m[1].toUpperCase(), path };
      ops.push(cur);
      continue;
    }
    const perm = /^ {6}x-permission: (\S+)\s*$/.exec(line);
    if (cur && perm?.[1]) cur.permission = perm[1];
    const idem = /^ {6}x-idempotency: (\S+)\s*$/.exec(line);
    if (cur && idem?.[1]) cur.idempotency = idem[1];
  }
  return ops;
}

describe('ROUTES vs canon §9', () => {
  it('equals every canon row in order (method, path, permission, ✓, section)', () => {
    expect(
      ROUTES.map((r) => ({
        method: r.method,
        path: r.path,
        permission: r.permission,
        idempotent: r.idempotent,
        section: r.section,
      })),
    ).toEqual(canonRoutes());
  });

  it('GET /v1/tickets/{ticketId} gates extra fields with ticket.read_full', () => {
    expect(findRoute('GET', '/v1/tickets/{ticketId}')?.fieldPermission).toBe('ticket.read_full');
    expect(ROUTES.filter((r) => r.fieldPermission)).toHaveLength(1);
  });

  it('has unique method + path and only canon permissions', () => {
    const keys = ROUTES.map((r) => routeKey(r.method, r.path));
    expect(new Set(keys).size).toBe(keys.length);
    for (const r of ROUTES) {
      expect([...PERMISSIONS, 'public', 'webhook', 'internal']).toContain(r.permission);
      expect(HTTP_METHODS).toContain(r.method);
    }
  });

  it('unsafe /v1 commands are the only idempotent ones', () => {
    for (const r of IDEMPOTENT_ROUTES) expect(r.method).not.toBe('GET');
    expect(IDEMPOTENT_ROUTES.every((r) => r.path.startsWith('/v1/'))).toBe(true);
  });
});

describe('ROUTES vs docs/07_openapi.yaml', () => {
  const ops = openApiOps();

  it('covers exactly the OpenAPI operations (canon §9 + the V2 platform routes, DEC-462, + the customer routes, V2-010)', () => {
    expect(
      [...ROUTES, ...PLATFORM_ROUTES, ...Object.values(CUSTOMER_ROUTES)]
        .map((r) => routeKey(r.method as HttpMethod, r.path))
        .sort(),
    ).toEqual(ops.map((o) => routeKey(o.method as HttpMethod, o.path)).sort());
    expect(ROUTES).toHaveLength(131);
  });

  it('matches x-permission and x-idempotency of every operation', () => {
    for (const op of ops) {
      const c = findCustomerRoute(op.method, op.path);
      if (c) {
        // V2-010: `customer` (Bearer) or `public` (the sign-in calls), and the registry's Idempotency-Key rule
        expect(c.auth, `${op.method} ${op.path}`).toBe(op.permission);
        expect(c.idempotency, `${op.method} ${op.path}`).toBe(op.idempotency);
        continue;
      }
      const r =
        findRoute(op.method as HttpMethod, op.path) ?? findPlatformRoute(op.method as HttpMethod, op.path);
      const ours = r && ['public', 'webhook', 'internal'].includes(r.permission) ? 'public' : r?.permission;
      expect(ours, `${op.method} ${op.path}`).toBe(op.permission);
      expect(r?.idempotency, `${op.method} ${op.path}`).toBe(op.idempotency);
    }
  });

  it('has the 78 ✓ routes announced in 07 §1.4', () => {
    const announced = /\((\d+) مسارًا، `x-idempotency: required`\)/.exec(readDoc('07_API_Contract.md'))?.[1];
    expect(IDEMPOTENT_ROUTES).toHaveLength(Number(announced));
    expect(ops.filter((o) => o.idempotency === 'required')).toHaveLength(
      IDEMPOTENT_ROUTES.length +
        PLATFORM_ROUTES.filter((r) => r.idempotent).length +
        Object.values(CUSTOMER_ROUTES).filter((r) => r.idempotency === 'required').length,
    );
  });
});

describe('ROUTES vs file 09 §4', () => {
  it('every route of 09 §4.1–4.7 has the same permission', () => {
    const rows = tableRows(section(readDoc('09_RBAC_Permissions_Matrix.md'), '## 4.'));
    let checked = 0;
    for (const r of rows) {
      const route = /^`(GET|POST|PUT|PATCH|DELETE) (\/v1\/\S+)`$/.exec(r[0] ?? '');
      if (!route) continue;
      const permCell = stripParens(r[1] ?? '');
      const expected = permCell.includes('عام') ? 'public' : backticks(permCell)[0];
      expect(findRoute(route[1] as HttpMethod, route[2] ?? '')?.permission, r[0]).toBe(expected);
      checked++;
    }
    expect(checked).toBe(ROUTES.filter((r) => r.path.startsWith('/v1/')).length);
  });
});

describe('path helpers', () => {
  it('converts between canon and Express path templates', () => {
    expect(toExpressPath('/v1/tickets/{ticketId}/media')).toBe('/v1/tickets/:ticketId/media');
    expect(fromExpressPath('/v1/key-boards/:boardId/slots')).toBe('/v1/key-boards/{boardId}/slots');
    for (const r of ROUTES) expect(fromExpressPath(toExpressPath(r.path))).toBe(r.path);
  });
});
