/**
 * Every string-enum component of docs/07_openapi.yaml has a same-named `<Name>Schema` export in
 * @point/shared with the same values, so API types and shared types never diverge in name or value.
 */
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import * as shared from '../src/index.js';
import { ERROR_CATALOG, type ErrorCode } from '../src/index.js';
import { readDoc } from './docs.js';
import { openApiOperations } from './openapi-doc.js';

function openApiStringEnums(): { name: string; values: string[] }[] {
  const lines = readDoc('07_openapi.yaml').split('\n');
  const start = lines.indexOf('  schemas:');
  const out: { name: string; values: string[] }[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const name = /^ {4}([A-Za-z0-9]+):\s*$/.exec(lines[i] ?? '')?.[1];
    if (!name) continue;
    const block: string[] = [];
    for (let j = i + 1; j < lines.length && !/^ {2,4}\S/.test(lines[j] ?? ''); j++)
      block.push(lines[j] ?? '');
    const text = block.join('\n');
    if (!/^ {6}type: string\s*$/m.test(text)) continue;
    const list = /^ {6}enum: \[([\s\S]*?)\]/m.exec(text)?.[1];
    if (!list) continue;
    out.push({ name, values: list.split(',').map((v) => v.trim()) });
  }
  return out;
}

const enums = openApiStringEnums();

describe('OpenAPI string enums ↔ @point/shared', () => {
  it('finds the OpenAPI enum components', () => {
    expect(enums.length).toBeGreaterThanOrEqual(60);
  });

  it.each(enums.map((e) => [e.name, e.values] as const))(
    '%sSchema has the OpenAPI values',
    (name, values) => {
      const schema = (shared as Record<string, unknown>)[`${name}Schema`] as z.ZodEnum | undefined;
      expect(schema, `@point/shared must export ${name}Schema`).toBeDefined();
      const options = [...(schema?.options ?? [])];
      // OpenAPI sorts ErrorCode alphabetically; the shared list keeps canon §8 order.
      if (name === 'ErrorCode') expect(options.sort()).toEqual([...values].sort());
      else expect(options).toEqual(values);
    },
  );
});

/**
 * Server sweep: the error codes each operation documents (`x-error-codes` and the response descriptions) are canon
 * §8 codes, each under the HTTP status the catalog gives it, and every `x-error-codes` entry has its response. The
 * served side (a route answering only documented codes) is apps/api/test/openapi-errors.int.test.ts.
 */
describe('OpenAPI error codes ↔ the canon catalog', () => {
  const ops = openApiOperations(readDoc('07_openapi.yaml'));

  it('reads every operation with its responses', () => {
    expect(ops).toHaveLength(131 + 7); // canon §9 + the V2 platform routes (V2-002)
    expect(ops.filter((o) => o.responses.size > 0).length).toBeGreaterThanOrEqual(127);
    expect(ops.filter((o) => o.requestBody)).toHaveLength(81 + 4);
  });

  it('every operation but a GET documents 413 PAYLOAD_TOO_LARGE and 422 VALIDATION_FAILED (08 §4.15, DEC-130)', () => {
    // the body parsers run before any route: one without a requestBody still reads a body sent to it
    const writes = ops.filter((o) => o.method !== 'GET');
    expect(writes).toHaveLength(90 + 6);
    const missing = writes
      .filter(
        (o) =>
          !o.responses.get(413)?.includes('PAYLOAD_TOO_LARGE') ||
          !o.responses.get(422)?.includes('VALIDATION_FAILED'),
      )
      .map((o) => `${o.method} ${o.path}`);
    expect(missing).toEqual([]);
  });

  it('every documented code is a canon code listed under its own HTTP status', () => {
    const problems: string[] = [];
    for (const op of ops) {
      for (const [status, codes] of op.responses)
        for (const code of codes) {
          const def = ERROR_CATALOG[code as ErrorCode];
          if (!def) problems.push(`${op.method} ${op.path}: ${code} is not a canon code`);
          else if (def.http !== status)
            problems.push(`${op.method} ${op.path}: ${code} under ${status}, canon ${def.http}`);
        }
      for (const code of op.xErrorCodes) {
        const def = ERROR_CATALOG[code as ErrorCode];
        if (!def) problems.push(`${op.method} ${op.path}: x-error-codes ${code} is not a canon code`);
        else if (!op.responses.get(def.http)?.includes(code))
          problems.push(`${op.method} ${op.path}: x-error-codes ${code} has no ${def.http} response`);
      }
    }
    expect(problems).toEqual([]);
  });
});
