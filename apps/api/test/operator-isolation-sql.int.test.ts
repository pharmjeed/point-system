import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createTestDatabase } from '@point/db/testing';
import pg from 'pg';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * V2-007 static guard (docs/v2/02 §1, 09 §1 rule 4: «كل استعلام يقيّد org_id»). Every SQL statement written in
 * packages/server/src that reads or writes an org-scoped table (a table of the migrated schema with an `org_id`
 * column) is classified, in the style of the incident-writer structure test:
 *
 * - `org`: the statement — with the fragments it interpolates (`${where}`, `${INCIDENT_SELECT}` …) — filters,
 *   joins or writes on `org_id`;
 * - `keyed`: it reaches its rows through a key bound as a parameter (`id = $1`, `ticket_id = ANY($2)`,
 *   `venue_id = $1`, `token_hash = $1` …): the row is one the caller already resolved, and whether the caller may
 *   resolve it is what the route sweep of operator-isolation.int.test.ts proves for every route;
 * - otherwise it scans rows of every operator: it must be in {@link GLOBAL} below with the reason it is global.
 *
 * A new unscoped statement fails here until it filters by org_id, is keyed, or is added to GLOBAL with its reason.
 */

const SRC = join(import.meta.dirname, '../../../packages/server/src');

/** The statements that are global on purpose: system work over every operator, or lookups before any operator. */
const GLOBAL: { file: string; sql: string; why: string }[] = [
  {
    file: 'core/outbox/dispatcher.ts',
    sql: "UPDATE outbox_events SET status = 'pending', locked_by = NULL",
    why: 'the worker releases expired leases of every operator (04 §6.3)',
  },
  {
    file: 'modules/audit-monitoring/application/analytics-projector.ts',
    sql: "properties->>'source_event_id' = $3",
    why: 'deduplication by the source event id, globally unique (15 §3)',
  },
  {
    file: 'modules/audit-monitoring/jobs/retention-purge.ts',
    sql: 'SELECT 1 FROM outbox_events WHERE type = $1',
    why: 'the purge job checks for a pending twin of itself (one job for every operator)',
  },
  {
    file: 'modules/payments-online/application/reconciliation.ts',
    sql: 'SELECT 1 FROM outbox_events WHERE type = $1',
    why: 'the platform reconciliation checks for a pending twin of itself (one job for the whole platform, DEC-514)',
  },
  {
    file: 'modules/audit-monitoring/jobs/system-monitor.ts',
    sql: "type = 'task_stuck'",
    why: 'the system monitor sweeps live alerts of every operator; each alert carries its own org_id',
  },
  {
    file: 'modules/audit-monitoring/jobs/system-monitor.ts',
    sql: "type = 'wa_send_failed'",
    why: 'the system monitor sweeps live alerts of every operator; each alert carries its own org_id',
  },
  {
    file: 'modules/audit-monitoring/jobs/system-monitor.ts',
    sql: 'SELECT type, count(*) FILTER',
    why: 'process gauges of the outbox backlog (no operator data leaves the process)',
  },
  {
    file: 'modules/audit-monitoring/jobs/system-monitor.ts',
    sql: 'SELECT p.id AS pool',
    why: 'per-pool dispatch gauges over every operator (ids and counts only)',
  },
  {
    file: 'modules/audit-monitoring/jobs/system-monitor.ts',
    sql: 'SELECT venue_id AS venue, count(*)::int AS on_duty',
    why: 'per-venue duty gauges over every operator (ids and counts only)',
  },
  {
    file: 'modules/audit-monitoring/jobs/system-monitor.ts',
    sql: 'SELECT DISTINCT e.venue_id AS venue',
    why: 'the venues with an open event and shift, to watch their webhooks (every operator)',
  },
  {
    file: 'modules/audit-monitoring/jobs/system-monitor.ts',
    sql: "FROM whatsapp_inbound_events WHERE status = 'pending'",
    why: 'inbound backlog gauge over every operator (counts only)',
  },
  {
    file: 'modules/whatsapp/application/inbound-processor.ts',
    sql: "FROM whatsapp_inbound_events WHERE status = 'pending'",
    why: 'inbound backlog gauge over every operator (counts only)',
  },
  {
    file: 'modules/dispatch/application/heartbeat.ts',
    sql: 'SELECT dedupe_key FROM alerts WHERE type = $1',
    why: 'the heartbeat sweep (every operator) finds the duty sessions with a live alert; keys carry session ids',
  },
  {
    file: 'modules/dispatch/application/offers.ts',
    sql: "dedupe_key = 'dispatch_sweep'",
    why: 'the dispatch sweep is one job for every operator',
  },
  {
    file: 'modules/identity-access/application/auth-service.ts',
    sql: 'SELECT * FROM users WHERE phone_e164 = $1',
    why: 'login, before any operator: the phone identifies the account across the deployment (DEC-476)',
  },
  {
    file: 'modules/identity-access/application/owner-bootstrap.ts',
    sql: 'SELECT 1 FROM users WHERE phone_e164 = $1 LIMIT 1',
    why: 'a new operator owner phone must be free at every operator: login finds it across them (DEC-476, DEC-485)',
  },
  {
    file: 'modules/platform/application/operators-service.ts',
    sql: 'SELECT (SELECT jsonb_object_agg(s.operator_status, s.n)',
    why: 'P-01 platform overview: counts over every operator, platform accounts only (V2-003, no row leaves)',
  },
  {
    file: 'modules/identity-access/application/me-service.ts',
    sql: 'WHERE push_endpoint = $1 AND id <> $2',
    why: 'a browser push endpoint is globally unique (uq_devices_push_endpoint): it moves to the new device',
  },
  {
    file: 'modules/whatsapp/application/inbound-processor.ts',
    sql: "payload->>'notification_id' = $1",
    why: 'keyed by the notification id inside the job payload (globally unique)',
  },
  {
    file: 'modules/whatsapp/infra/channel.ts',
    sql: 'SELECT * FROM whatsapp_channel WHERE is_active ORDER BY created_at, id',
    why: 'the webhook verifies a delivery against every active channel, then stores it for the one it names (DEC-475)',
  },
];

const VERB = /\b(SELECT|INSERT\s+INTO|UPDATE\s+[a-z_]+\s|DELETE\s+FROM)\b/;
const TABLE = /\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-z_]+)/g;
const KEYED =
  /\b(?:[a-z_]+\.)?(?:id|[a-z_]+_id|[a-z_]+_by|token_hash|dedupe_key|storage_key|body_sha256|code|key)\s*(?:=|IN)\s*(?:ANY\s*)?\(?\s*\$+(?:\d+|\{)/;

interface Statement {
  file: string;
  line: number;
  sql: string;
  tables: string[];
  rule: 'org' | 'keyed' | 'unscoped';
}

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
  });

/** Exported SQL fragments (`export const TASK_SELECT = \`SELECT …\``) by name, across the sources. */
function fragments(sources: Map<string, ts.SourceFile>): Map<string, string> {
  const out = new Map<string, string>();
  for (const sf of sources.values()) {
    const walk = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && /^[A-Z][A-Z0-9_]*$/.test(n.name.text))
        if (n.initializer)
          out.set(n.name.text, (out.get(n.name.text) ?? '') + '\n' + n.initializer.getText(sf));
      ts.forEachChild(n, walk);
    };
    walk(sf);
  }
  return out;
}

function statements(sources: Map<string, ts.SourceFile>, orgTables: Set<string>): Statement[] {
  const shared = fragments(sources);
  const out: Statement[] = [];
  for (const [file, sf] of sources) {
    // what a local identifier may hold: its initializers, the `x.push(…)` and `x += …` that build it
    const local = new Map<string, string[]>();
    const add = (k: string, v: string) => local.set(k, [...(local.get(k) ?? []), v]);
    const index = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer)
        add(n.name.text, n.initializer.getText(sf));
      if (ts.isFunctionDeclaration(n) && n.name) add(n.name.text, n.getText(sf));
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken &&
        ts.isIdentifier(n.left)
      )
        add(n.left.text, n.getText(sf));
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === 'push' &&
        ts.isIdentifier(n.expression.expression)
      )
        add(n.expression.expression.text, n.getText(sf));
      ts.forEachChild(n, index);
    };
    index(sf);
    const resolve = (expr: ts.Expression): string => {
      let text = expr.getText(sf);
      const ids: string[] = [];
      const collect = (n: ts.Node) => {
        if (ts.isIdentifier(n)) ids.push(n.text);
        ts.forEachChild(n, collect);
      };
      collect(expr);
      for (const id of ids) text += '\n' + [...(local.get(id) ?? []), shared.get(id) ?? ''].join('\n');
      return text;
    };
    /** A literal that only builds part of a statement (a shared constant, a pushed or appended condition). */
    const isFragment = (n: ts.Node) => {
      let p = n.parent;
      while (
        p &&
        (ts.isTemplateSpan(p) ||
          ts.isParenthesizedExpression(p) ||
          (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.PlusToken))
      )
        p = p.parent;
      if (!p) return false;
      if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) && /^[A-Z][A-Z0-9_]*$/.test(p.name.text))
        return true;
      if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken) return true;
      return (
        ts.isCallExpression(p) &&
        ts.isPropertyAccessExpression(p.expression) &&
        p.expression.name.text === 'push'
      );
    };
    const visit = (n: ts.Node) => {
      let own: string | null = null;
      let full = '';
      if (ts.isNoSubstitutionTemplateLiteral(n) || ts.isStringLiteral(n)) {
        own = full = n.text;
      } else if (ts.isTemplateExpression(n)) {
        // shared fragments are inlined (a statement may be `${TASK_SELECT} WHERE k.id = $1`)
        const span = (s: ts.TemplateSpan) =>
          ts.isIdentifier(s.expression) && shared.has(s.expression.text)
            ? shared.get(s.expression.text)!
            : '${}';
        own = n.head.text + n.templateSpans.map((s) => span(s) + s.literal.text).join('');
        full = own + '\n' + n.templateSpans.map((s) => resolve(s.expression)).join('\n');
      }
      if (own !== null && VERB.test(own)) {
        if (isFragment(n)) return;
        const tables = [...new Set([...full.matchAll(TABLE)].map((m) => m[1]!))].filter((t) =>
          orgTables.has(t),
        );
        if (tables.length) {
          out.push({
            file,
            line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
            sql: own.replace(/\s+/g, ' ').trim(),
            tables,
            rule: /\borg_id\b/.test(full) ? 'org' : KEYED.test(full) ? 'keyed' : 'unscoped',
          });
        }
        return; // nested literals belong to this statement
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

describe('V2-007 static guard: every SQL statement on an org-scoped table is scoped by org_id', () => {
  let orgTables: Set<string>;
  let found: Statement[];

  beforeAll(async () => {
    const tdb = await createTestDatabase();
    const c = new pg.Client({ connectionString: tdb.url });
    await c.connect();
    try {
      const r = await c.query<{ t: string }>(
        `SELECT c.table_name AS t FROM information_schema.columns c
           JOIN information_schema.tables t USING (table_schema, table_name)
          WHERE c.table_schema = 'public' AND c.column_name = 'org_id' AND t.table_type = 'BASE TABLE'`,
      );
      orgTables = new Set(r.rows.map((x) => x.t));
    } finally {
      await c.end();
      await tdb.drop();
    }
    const sources = new Map<string, ts.SourceFile>();
    for (const f of files(SRC))
      sources.set(
        relative(SRC, f),
        ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true),
      );
    found = statements(sources, orgTables);
  });
  afterAll(() => undefined);

  it('finds the statements (the scanner sees the schema and the sources)', () => {
    expect(orgTables.has('tickets') && orgTables.has('audit_log')).toBe(true);
    expect(orgTables.has('organizations')).toBe(false);
    expect(found.length).toBeGreaterThan(600);
    expect(found.filter((s) => s.rule === 'org').length).toBeGreaterThan(150);
  });

  it('every unscoped statement is a documented global one', () => {
    const unscoped = found.filter((s) => s.rule === 'unscoped');
    const undocumented = unscoped
      .filter((s) => !GLOBAL.some((g) => g.file === s.file && s.sql.includes(g.sql)))
      .map((s) => `${s.file}:${s.line} [${s.tables.join(',')}] ${s.sql.slice(0, 240)}`);
    expect(undocumented).toEqual([]);
    const stale = GLOBAL.filter((g) => !unscoped.some((s) => g.file === s.file && s.sql.includes(g.sql))).map(
      (g) => `${g.file}: ${g.sql}`,
    );
    expect(stale).toEqual([]);
  });
});
