// Copies the identity assets from brand/ into apps/web/public/ exactly as they are (CLAUDE.md §4:
// "copy, never redraw"). Run after any change in brand/: `pnpm --filter @point/web brand:sync`.
// test/brand-assets.test.ts fails when the copies drift from brand/.
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const brandDir = join(appDir, '..', '..', 'brand');
const publicDir = join(appDir, 'public');

/** [source directory in brand/, target directory in public/, file filter] */
export const BRAND_COPIES = [
  ['app-icons', 'icons', () => true],
  ['sounds', 'sounds', (f) => f.endsWith('.mp3')],
  ['manifest', '.', (f) => f === 'manifest.webmanifest'],
];

for (const [from, to, keep] of BRAND_COPIES) {
  const src = join(brandDir, from);
  const dst = join(publicDir, to);
  mkdirSync(dst, { recursive: true });
  for (const file of readdirSync(src).filter(keep)) {
    copyFileSync(join(src, file), join(dst, file));
    console.log(`brand → public/${to === '.' ? '' : `${to}/`}${file}`);
  }
}
