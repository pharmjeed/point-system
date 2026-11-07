/**
 * Design values for the customer app, read from brand/tokens/tokens.json (W3C Design Tokens) — no value is
 * invented here (DEC-49, 03 §2.1). References such as `{color.ink.50}` are resolved once at load. Components use
 * the semantic roles (`color.primary`, `color.textMuted` …), never the raw scales, as in the staff app.
 * Pure (no React Native import), so it is unit tested in node.
 */
import raw from '../../../../brand/tokens/tokens.json';

type Json = { [key: string]: unknown };

/** Resolves `{a.b.c}` against the token tree (following chained references); literal values pass through. */
export function resolveTokenValue(tree: Json, value: string, depth = 0): string {
  const m = /^\{([^}]+)\}$/.exec(value);
  if (!m) return value;
  if (depth > 8) throw new Error(`token reference loop at ${value}`);
  let node: unknown = tree;
  for (const part of (m[1] as string).split('.')) {
    node = node && typeof node === 'object' ? (node as Json)[part] : undefined;
  }
  const next = node && typeof node === 'object' ? (node as Json).$value : node;
  if (typeof next !== 'string') throw new Error(`unknown token reference ${value}`);
  return resolveTokenValue(tree, next, depth + 1);
}

/** `"16px"` → 16. */
export function px(value: string): number {
  const m = /^(-?\d+(?:\.\d+)?)px$/.exec(value);
  if (!m) throw new Error(`not a px dimension: ${value}`);
  return Number(m[1]);
}

const tree = raw as unknown as Json;
const semanticLight = (raw.semantic as unknown as { light: Record<string, { $value: string }> }).light;

function role(name: string): string {
  const entry = semanticLight[name];
  if (!entry) throw new Error(`missing semantic token ${name}`);
  return resolveTokenValue(tree, entry.$value);
}

/** Light theme roles (03 §2.2). The customer app ships light only in V2-011 (DEC-483). */
export const color = {
  bg: role('bg'),
  surface: role('surface'),
  surface2: role('surface-2'),
  border: role('border'),
  borderStrong: role('border-strong'),
  text: role('text'),
  textMuted: role('text-muted'),
  textDisabled: role('text-disabled'),
  textInverse: role('text-inverse'),
  primary: role('primary'),
  primaryPressed: role('primary-pressed'),
  primarySubtle: role('primary-subtle'),
  primaryText: role('primary-text'),
  onPrimary: role('on-primary'),
  focus: role('focus'),
  success: role('success'),
  successSubtle: role('success-subtle'),
  successText: role('success-text'),
  warningSubtle: role('warning-subtle'),
  warningText: role('warning-text'),
  danger: role('danger'),
  dangerSubtle: role('danger-subtle'),
  dangerText: role('danger-text'),
  infoSubtle: role('info-subtle'),
  infoText: role('info-text'),
} as const;

function scale<K extends string>(group: Record<K, { $value: string }>): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const key of Object.keys(group) as K[]) out[key] = px(group[key].$value);
  return out;
}

/** 4px grid: `space[4]` = 16 (03 §2.4). */
type SpaceKey = '0' | '0.5' | '1' | '2' | '3' | '4' | '5' | '6' | '8' | '10' | '12' | '16';
export const space = scale(raw.space as unknown as Record<SpaceKey, { $value: string }>);
/** `radius.md` = 12 (buttons, fields), `radius.lg` = 16 (cards) (03 §2.5). */
export const radius = scale(
  raw.radius as unknown as Record<'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'full', { $value: string }>,
);

type FontSizeKey = 'xs' | 'sm' | 'base' | 'lg' | 'xl' | '2xl' | '3xl' | '4xl' | 'display';
/** Type scale with line heights (03 §2.3): `fontSize.base` = 16/26. */
export const fontSize = Object.fromEntries(
  Object.entries(raw.fontSize as unknown as Record<FontSizeKey, { $value: string; lineHeight: string }>).map(
    ([k, v]) => [k, { fontSize: px(v.$value), lineHeight: px(v.lineHeight) }],
  ),
) as Record<FontSizeKey, { fontSize: number; lineHeight: number }>;

/** Touch targets and bars (03 §2.4, §5): 44 minimum, 56 for the main action. */
export const layout = {
  touchMin: px(raw.layout['touch-min']),
  buttonLg: px(raw.layout['button-lg']),
  topbarH: px(raw.layout['topbar-h']),
  shellMaxW: px(raw.layout['shell-max-w']),
  focusRingW: px(raw.layout['focus-ring-w']),
} as const;

/** Font family names registered at start-up (src/theme/fonts.ts); weights of brand §5. */
export const font = {
  regular: 'IBMPlexSansArabic_400Regular',
  medium: 'IBMPlexSansArabic_500Medium',
  semibold: 'IBMPlexSansArabic_600SemiBold',
  bold: 'IBMPlexSansArabic_700Bold',
  mono: 'IBMPlexMono_400Regular',
  monoSemibold: 'IBMPlexMono_600SemiBold',
} as const;
