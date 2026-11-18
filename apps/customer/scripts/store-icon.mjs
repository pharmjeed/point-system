#!/usr/bin/env node
/**
 * The 1024 × 1024 app icon of the customer app (V2-052, DEC-567), exported from the brand's own vector
 * `brand/app-icons/icon-maskable.svg` (full-bleed square, the mark inside the safe zone — the same artwork as the
 * committed `icon-maskable-512.png`). Nothing is drawn or recoloured: the SVG's paths are rasterised at a larger
 * size, and written without an alpha channel (the App Store icon must have none).
 *
 *   pnpm --filter @point/customer run store:icon            # writes assets/brand/icon-1024.png
 *   pnpm --filter @point/customer run store:icon -- --check # fails if the committed file differs from the SVG
 *
 * sharp (librsvg) comes from packages/server, which already depends on it for vehicle photos.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(appDir, '..', '..');
const source = join(repo, 'brand', 'app-icons', 'icon-maskable.svg');
const target = join(appDir, 'assets', 'brand', 'icon-1024.png');
const sharp = createRequire(join(repo, 'packages', 'server', 'package.json'))('sharp');

const svg = readFileSync(source);
const png = await sharp(svg, { density: 72 * (1024 / 512) })
  .resize(1024, 1024)
  .removeAlpha()
  .png({ compressionLevel: 9 })
  .toBuffer();

if (process.argv.includes('--check')) {
  const meta = await sharp(readFileSync(target)).metadata();
  const committed = await sharp(readFileSync(target)).raw().toBuffer();
  const fresh = await sharp(png).raw().toBuffer();
  // anti-aliased edges may differ by a few levels between librsvg builds; the artwork itself may not
  let max = 0;
  let sum = 0;
  for (let i = 0; i < committed.length; i++) {
    const d = Math.abs(committed[i] - (fresh[i] ?? 0));
    sum += d;
    if (d > max) max = d;
  }
  const mean = sum / committed.length;
  const sizeOk = meta.width === 1024 && meta.height === 1024 && !meta.hasAlpha;
  if (!sizeOk || committed.length !== fresh.length || mean > 0.5 || max > 64) {
    process.stderr.write(
      `${target} does not match ${source} (mean ${mean.toFixed(3)}, max ${max}): run store:icon\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`icon-1024.png matches the brand SVG (mean difference ${mean.toFixed(3)})\n`);
} else {
  writeFileSync(target, png);
  const meta = await sharp(target).metadata();
  process.stdout.write(
    `${target}: ${meta.width}x${meta.height}, channels ${meta.channels}, alpha ${meta.hasAlpha}\n`,
  );
}
