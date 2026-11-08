/**
 * Light/dark mode (DEC-19, 03 §2.10, 02 §1.5): `<html data-theme="system|light|dark">`.
 * Driver screens default to `system` (follow the device) with a manual switch in D-14; supervisor/admin
 * screens default to `light`, with the same switch in the ☰ menu. The choice is a per-device preference,
 * kept in localStorage behind try/catch (it may be unavailable in private mode) — never a secret.
 */
export type ThemePref = 'system' | 'light' | 'dark';
export type ThemeArea = 'driver' | 'staff';

export const THEME_PREFS: readonly ThemePref[] = ['system', 'light', 'dark'];
export const DEFAULT_THEME: Record<ThemeArea, ThemePref> = { driver: 'system', staff: 'light' };

const storageKey = (area: ThemeArea) => `point.theme.${area}`;

export function isThemePref(value: unknown): value is ThemePref {
  return value === 'system' || value === 'light' || value === 'dark';
}

export function readThemePref(area: ThemeArea): ThemePref {
  try {
    const stored = globalThis.localStorage?.getItem(storageKey(area));
    if (isThemePref(stored)) return stored;
  } catch {
    // storage blocked: fall back to the default
  }
  return DEFAULT_THEME[area];
}

export function writeThemePref(area: ThemeArea, pref: ThemePref): void {
  try {
    globalThis.localStorage?.setItem(storageKey(area), pref);
  } catch {
    // storage blocked: the choice lasts for this page only
  }
}

/**
 * Applies the theme to <html> and keeps `theme-color` in step (brand/manifest/head-snippet.html ships one
 * meta per colour scheme; a forced theme copies the matching colour into both).
 */
export function applyTheme(pref: ThemePref, doc: Document = document): void {
  doc.documentElement.dataset.theme = pref;
  const metas = Array.from(doc.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'));
  for (const meta of metas) {
    if (!meta.dataset.original) meta.dataset.original = meta.content;
  }
  const colorFor = (scheme: 'light' | 'dark') =>
    metas.find((m) => m.media.includes(scheme))?.dataset.original ?? metas[0]?.dataset.original ?? '';
  for (const meta of metas) {
    const own = meta.dataset.original ?? meta.content;
    meta.content = pref === 'system' ? own : colorFor(pref);
  }
}
