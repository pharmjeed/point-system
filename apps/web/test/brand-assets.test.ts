import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Identity assets are copied from brand/ unchanged (CLAUDE.md §4) — `pnpm --filter @point/web brand:sync`
 * — and the staff source never spells a brand name (canon §1). Also checks the RTL document shell.
 */
const appDir = fileURLToPath(new URL('..', import.meta.url));
const brandDir = join(appDir, '..', '..', 'brand');

const same = (a: string, b: string) => readFileSync(a).equals(readFileSync(b));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

describe('brand assets in public/', () => {
  it('icons are byte-identical copies of brand/app-icons', () => {
    const icons = readdirSync(join(brandDir, 'app-icons'));
    expect(icons.length).toBeGreaterThan(10);
    for (const f of icons)
      expect(same(join(brandDir, 'app-icons', f), join(appDir, 'public/icons', f)), f).toBe(true);
  });

  it('sounds are byte-identical copies of brand/sounds (canon §13: six sounds)', () => {
    const sounds = readdirSync(join(brandDir, 'sounds')).filter((f) => f.endsWith('.mp3'));
    expect(sounds).toHaveLength(6);
    for (const f of sounds)
      expect(same(join(brandDir, 'sounds', f), join(appDir, 'public/sounds', f)), f).toBe(true);
  });

  it('the manifest is the brand manifest (RTL, Arabic, start_url /?source=pwa)', () => {
    expect(
      same(join(brandDir, 'manifest/manifest.webmanifest'), join(appDir, 'public/manifest.webmanifest')),
    ).toBe(true);
    const manifest = JSON.parse(readFileSync(join(appDir, 'public/manifest.webmanifest'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(manifest).toMatchObject({
      lang: 'ar',
      dir: 'rtl',
      start_url: '/?source=pwa',
      display: 'standalone',
    });
    expect(JSON.stringify(manifest)).not.toContain('مصاف');
  });
});

describe('document shell and source', () => {
  it('index.html is Arabic RTL, takes the brand from env and links the manifest and icons', () => {
    const html = readFileSync(join(appDir, 'index.html'), 'utf8');
    expect(html).toMatch(/<html lang="ar" dir="rtl"/);
    expect(html).toContain('<title>%VITE_BRAND_STAFF_NAME_AR%</title>');
    expect(html).toContain('href="/manifest.webmanifest"');
    expect(html).toContain('href="/icons/apple-touch-icon.png"');
    expect(html).not.toContain('بوينت');
  });

  it('no brand name is hard-coded in src/ (scripts/check-brand.mjs rule)', () => {
    const offenders = walk(join(appDir, 'src')).filter((f) => {
      const text = readFileSync(f, 'utf8');
      return text.includes('بوينت') || text.includes('مصاف');
    });
    expect(offenders).toEqual([]);
  });

  it('components never import the design-system preview bundle', () => {
    const offenders = walk(join(appDir, 'src')).filter((f) => readFileSync(f, 'utf8').includes('bundle.js'));
    expect(offenders).toEqual([]);
  });
});
