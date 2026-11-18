/**
 * The enums match docs/06_schema.sql literally: every `CHECK (column IN (...))`, the
 * partial-index status lists, the payment-method array check, the driver-state view and the tables.
 */
import { describe, expect, it } from 'vitest';
import {
  ACTIVE_MOVEMENT_TASK_STATUSES,
  DRIVER_STATES,
  PAYMENT_METHODS,
  QUEUED_TASK_STATUSES,
  SCHEMA_COLUMN_ENUMS,
  TABLE_NAMES,
  TERMINAL_TASK_STATUSES,
  TERMINAL_TICKET_STATUSES,
} from '../src/index.js';
import { readFileSync } from 'node:fs';
import { readDoc, repoPath } from './docs.js';

const sql = readDoc('06_schema.sql').replace(/--[^\n]*/g, '');
const quoted = (list: string): string[] => [...list.matchAll(/'([^']*)'/g)].map((m) => m[1] ?? '');

/**
 * V2 migrations that widen a CHECK list of 06_schema.sql (06 ERD §9.2 rule 3) replace the list by the one they
 * declare: `0010_customer_pass_and_app_intake.sql` re-creates the ticket channel check with `app` (DEC-501).
 */
const WIDENED: Record<string, { file: string; constraint: string }> = {
  'tickets.channel': { file: '0010_customer_pass_and_app_intake.sql', constraint: 'ck_tickets_channel' },
  // V2-015 (DEC-516): the request from the customer app
  'retrieval_cycles.request_source': {
    file: '0013_customer_visits_push.sql',
    constraint: 'ck_cycles_request_source',
  },
  'tickets.pending_retrieval_source': {
    file: '0013_customer_visits_push.sql',
    constraint: 'ck_tickets_pending_retrieval_source',
  },
};

function checkEnums(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [, table, body] of sql.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\n\);/g)) {
    const flat = (body ?? '').replace(/\s+/g, ' ');
    for (const [, column, list] of flat.matchAll(/CHECK \((\w+) IN \(([^)]*)\)\)/g)) {
      out[`${table}.${column}`] = quoted(list ?? '');
    }
  }
  for (const [column, w] of Object.entries(WIDENED)) {
    const migration = readFileSync(repoPath(`packages/db/migrations/${w.file}`), 'utf8');
    const list = new RegExp(`CONSTRAINT ${w.constraint}\\s+CHECK \\(\\w+ IN \\(([^)]*)\\)\\)`).exec(
      migration,
    )?.[1];
    expect(list, `${w.file} declares ${w.constraint}`).toBeTruthy();
    const widened = quoted(list ?? '');
    // a widening keeps every V1 value (06 ERD §9.2 rule 1: never narrowed)
    expect(widened.slice(0, out[column]?.length), column).toEqual(out[column]);
    out[column] = widened;
  }
  return out;
}

function indexStatuses(name: string): string[] {
  const def = new RegExp(`CREATE UNIQUE INDEX ${name}[^;]*?status (?:NOT )?IN \\(([^)]*)\\)`).exec(sql)?.[1];
  return quoted(def ?? '');
}

describe('docs/06_schema.sql', () => {
  it('SCHEMA_COLUMN_ENUMS has exactly the CHECK (column IN …) lists of the schema', () => {
    const fromSchema = checkEnums();
    expect(Object.keys(SCHEMA_COLUMN_ENUMS).sort()).toEqual(Object.keys(fromSchema).sort());
    for (const [column, values] of Object.entries(fromSchema)) {
      expect([...SCHEMA_COLUMN_ENUMS[column as keyof typeof SCHEMA_COLUMN_ENUMS]], column).toEqual(values);
    }
  });

  it('events.allowed_payment_methods is checked against PAYMENT_METHODS', () => {
    const list =
      /CONSTRAINT ck_events_payment_methods CHECK \(allowed_payment_methods <@ ARRAY\[([^\]]*)\]/.exec(
        sql,
      )?.[1];
    expect(quoted(list ?? '')).toEqual([...PAYMENT_METHODS]);
  });

  it('partial unique indexes use the exported status subsets', () => {
    expect(indexStatuses('uq_tasks_active_movement_driver')).toEqual([...ACTIVE_MOVEMENT_TASK_STATUSES]);
    expect(indexStatuses('uq_tasks_open_per_ticket')).toEqual([...TERMINAL_TASK_STATUSES]);
    expect(indexStatuses('uq_tickets_key_tag_open')).toEqual([...TERMINAL_TICKET_STATUSES]);
    const queue = /CREATE INDEX ix_tasks_pool_queue [^;]*status IN \(([^)]*)\)/.exec(sql)?.[1];
    expect(quoted(queue ?? '')).toEqual([...QUEUED_TASK_STATUSES]);
  });

  it('v_driver_state yields DRIVER_STATES except off_duty (no open session)', () => {
    const view = /CREATE VIEW v_driver_state AS([\s\S]*?);/.exec(sql)?.[1] ?? '';
    const states = [...view.matchAll(/THEN '(\w+)'|ELSE '(\w+)'/g)].map((m) => m[1] ?? m[2]);
    expect(new Set(states)).toEqual(new Set(DRIVER_STATES.filter((s) => s !== 'off_duty')));
  });

  it('TABLE_NAMES are the tables of the schema', () => {
    const tables = [...sql.matchAll(/CREATE TABLE (\w+) \(/g)].map((m) => m[1]);
    expect([...TABLE_NAMES].sort()).toEqual(tables.sort());
  });
});
