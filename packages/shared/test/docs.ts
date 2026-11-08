/**
 * Helpers that read the specification in docs/ and extract the binding values, so the exported
 * lists are compared with the documents themselves (PNT-005 AC1).
 */
import { readFileSync } from 'node:fs';

const DOCS = new URL('../../../docs/', import.meta.url);
const ROOT = new URL('../../../', import.meta.url);

export function readDoc(name: string): string {
  return readFileSync(new URL(name, DOCS), 'utf8');
}

export function repoPath(relative: string): URL {
  return new URL(relative, ROOT);
}

/** Lines from the heading that starts with `start` up to (excluding) the next heading of level ≤ its level. */
export function section(text: string, start: string): string[] {
  const lines = text.split(/\r?\n/);
  const from = lines.findIndex((l) => l.startsWith(start));
  if (from < 0) throw new Error(`Heading not found: ${start}`);
  const level = /^(#+)/.exec(start)?.[1]?.length ?? 2;
  const out: string[] = [];
  for (const line of lines.slice(from + 1)) {
    const h = /^(#+)\s/.exec(line);
    if (h?.[1] && h[1].length <= level) break;
    out.push(line);
  }
  return out;
}

/** Backtick-quoted values in order. */
export function backticks(s: string): string[] {
  return [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? '');
}

/** Removes parenthesised comments, innermost first. */
export function stripParens(s: string): string {
  let prev = '';
  let cur = s;
  while (cur !== prev) {
    prev = cur;
    cur = cur.replace(/\([^()]*\)/g, '');
  }
  return cur;
}

/** Cells of the markdown table rows in `lines` (header and separator rows excluded). */
export function tableRows(lines: readonly string[]): string[][] {
  const rows: string[][] = [];
  let header = true;
  for (const line of lines) {
    if (!line.startsWith('|')) {
      header = true;
      continue;
    }
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    if (header) {
      header = false;
      continue;
    }
    rows.push(cells);
  }
  return rows;
}

/** Index of the first `:` that is not inside backticks, or -1. */
function colonOutsideBackticks(s: string): number {
  let inside = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '`') inside = !inside;
    else if (ch === ':' && !inside) return i;
  }
  return -1;
}

export interface LabeledList {
  label: string;
  values: string[];
}

/**
 * Extracts `label: \`a\` · \`b\`` lists from bullet/paragraph lines (canon §4, §5, §7).
 * Comments in parentheses are dropped first; ` — ` separates several lists on one line; the label
 * is the last backtick value before the colon (or the plain text); `label: \`field\` = \`a\` · \`b\``
 * yields `label#field`. Table rows are ignored.
 */
export function labeledLists(lines: readonly string[]): LabeledList[] {
  const out: LabeledList[] = [];
  for (const raw of lines) {
    if (raw.startsWith('|') || raw.startsWith('#')) continue;
    for (const segment of stripParens(raw).split(' — ')) {
      const idx = colonOutsideBackticks(segment);
      if (idx < 0) continue;
      const labelPart = segment.slice(0, idx);
      let valuesPart = segment.slice(idx + 1);
      const labelTicks = backticks(labelPart);
      let label = labelTicks.length
        ? (labelTicks[labelTicks.length - 1] ?? '')
        : labelPart.replace(/^\s*-\s*/, '').trim();
      const field = /^\s*`([\w.]+)`\s*=\s*(.*)$/.exec(valuesPart);
      if (field) {
        label = `${label}#${field[1]}`;
        valuesPart = field[2] ?? '';
      }
      const values = backticks(valuesPart);
      if (values.length) out.push({ label, values });
    }
  }
  return out;
}
