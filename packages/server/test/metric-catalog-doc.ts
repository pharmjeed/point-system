import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** The metric names (and labels) of the binding catalog, 05 §12.2. */
export function catalog(): { name: string; labels: string[] }[] {
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
