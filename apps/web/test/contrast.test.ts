import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contrastRatio } from '@/lib/contrast';
import { CONTRAST_PAIRS } from '@/styles/contrastPairs';

/**
 * PNT-021 acceptance 3: automated contrast check of the token pairs in use, in both themes, computed from
 * brand/tokens/tokens.json (the source of truth). A second test proves tokens.css (what the app imports)
 * carries the same values as tokens.json.
 */
type Json = Record<string, unknown>;
const tokens = JSON.parse(
  readFileSync(new URL('../../../brand/tokens/tokens.json', import.meta.url), 'utf8'),
) as Json;
const css = readFileSync(new URL('../../../brand/tokens/tokens.css', import.meta.url), 'utf8');

function valueOf(node: unknown): string {
  if (typeof node === 'string') return node;
  if (node && typeof node === 'object' && '$value' in node)
    return String((node as { $value: unknown }).$value);
  throw new Error(`not a token: ${JSON.stringify(node)}`);
}

function resolve(raw: string): string {
  const ref = /^\{([^}]+)\}$/.exec(raw);
  if (!ref?.[1]) return raw.toUpperCase();
  let node: unknown = tokens;
  for (const part of ref[1].split('.')) node = (node as Json)[part];
  return resolve(valueOf(node));
}

/** Theme → role name (as in --pt-<role>) → #RRGGBB. */
function rolesFor(theme: 'light' | 'dark'): Map<string, string> {
  const roles = new Map<string, string>();
  const semantic = (tokens.semantic as Json)[theme] as Json;
  for (const [k, v] of Object.entries(semantic)) roles.set(k, resolve(valueOf(v)));
  for (const [k, v] of Object.entries(tokens.status as Json)) {
    const t = (v as Json)[theme] as Json;
    roles.set(`status-${k.replace(/_/g, '-')}-bg`, resolve(valueOf(t.bg)));
    roles.set(`status-${k.replace(/_/g, '-')}-fg`, resolve(valueOf(t.fg)));
  }
  for (const [k, v] of Object.entries(tokens.driverState as Json)) {
    const t = (v as Json)[theme] as Json;
    roles.set(`driver-${k.replace(/_/g, '-')}-bg`, resolve(valueOf(t.bg)));
    roles.set(`driver-${k.replace(/_/g, '-')}-fg`, resolve(valueOf(t.fg)));
  }
  for (const [k, v] of Object.entries(tokens.connection as Json))
    roles.set(`conn-${k}`, resolve(valueOf((v as Json)[theme])));
  return roles;
}

/** Custom properties of one CSS block, with var() references resolved against :root primitives. */
function cssBlock(selectorStart: string): Map<string, string> {
  const start = css.indexOf(selectorStart);
  if (start < 0) throw new Error(`block not found: ${selectorStart}`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  const body = css.slice(open + 1, close);
  const out = new Map<string, string>();
  for (const m of body.matchAll(/--pt-([a-z0-9-]+):\s*([^;]+);/g))
    if (m[1] && m[2]) out.set(m[1], m[2].trim());
  return out;
}

const primitives = cssBlock(':root {');
function resolveCss(value: string, scope: Map<string, string>): string {
  const ref = /^var\(--pt-([a-z0-9-]+)\)$/.exec(value);
  if (!ref?.[1]) return value.toUpperCase();
  const next = scope.get(ref[1]) ?? primitives.get(ref[1]);
  if (!next) throw new Error(`unresolved ${value}`);
  return resolveCss(next, scope);
}

describe.each(['light', 'dark'] as const)(
  'contrast of used token pairs — %s theme (WCAG 2.2 AA)',
  (theme) => {
    const roles = rolesFor(theme);
    it.each(CONTRAST_PAIRS.map((p) => [`${p.fg} on ${p.bg} ≥ ${p.min} (${p.usage})`, p] as const))(
      '%s',
      (_, pair) => {
        const fg = roles.get(pair.fg);
        const bg = roles.get(pair.bg);
        expect(fg, `missing token ${pair.fg}`).toBeDefined();
        expect(bg, `missing token ${pair.bg}`).toBeDefined();
        const ratio = contrastRatio(fg as string, bg as string);
        expect(ratio, `${pair.fg} ${fg} on ${pair.bg} ${bg} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(
          pair.min,
        );
      },
    );
  },
);

describe('tokens.css carries the tokens.json values (the app imports tokens.css)', () => {
  const blocks = {
    light: cssBlock(':root, [data-theme="light"] {'),
    dark: cssBlock('[data-theme="dark"] {'),
    systemDark: cssBlock('[data-theme="system"] {'),
  };
  it.each(['light', 'dark'] as const)('%s roles match', (theme) => {
    const block = blocks[theme];
    for (const [role, hex] of rolesFor(theme)) {
      const value = block.get(role);
      expect(value, `--pt-${role} missing in tokens.css (${theme})`).toBeDefined();
      expect(resolveCss(value as string, block), `--pt-${role} (${theme})`).toBe(hex);
    }
  });
  it('the system theme in dark mode equals the dark theme', () => {
    expect(Object.fromEntries(blocks.systemDark)).toEqual(Object.fromEntries(blocks.dark));
  });
});
