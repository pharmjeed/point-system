/**
 * Every string-enum component of docs/07_openapi.yaml has a same-named `<Name>Schema` export in
 * @point/shared with the same values, so API types and shared types never diverge in name or value.
 */
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import * as shared from '../src/index.js';
import { readDoc } from './docs.js';

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
