import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { build, type Plugin, type ResolvedConfig } from 'vite';

/**
 * `point-service-worker` (05 §15.2; PNT-070): after the app build, bundles src/sw/sw.ts into `dist/sw.js` (IIFE,
 * served at the root so its scope is `/`) with:
 * - `__PRECACHE__`: the app shell — every emitted asset (JS, CSS, fonts) except source maps and the
 *   development gallery, plus the public files (icons, sounds, manifest) and `/index.html`;
 * - `__SW_VERSION__`: a hash of that list (hashed file names change with their content), so a new build is a
 *   new worker and «تحديث متاح» appears (02 D-15 و);
 * - `__BRAND__`: the staff brand for the quiet notifications (canon §1: from `VITE_BRAND_STAFF_NAME_AR`).
 * `/v1` is never in the list and the worker never caches it (sw.ts).
 */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

export function serviceWorkerPlugin(options: { appDir: string; alias: Record<string, string> }): Plugin {
  let config: ResolvedConfig;
  return {
    name: 'point-service-worker',
    apply: 'build',
    configResolved(resolved) {
      config = resolved;
    },
    async closeBundle() {
      const outDir = config.build.outDir;
      const files = walk(outDir)
        .map((f) => `/${relative(outDir, f).split(sep).join('/')}`)
        .filter((f) => !f.endsWith('.map') && f !== '/sw.js' && !/\/Gallery-[^/]+\.js$/.test(f));
      const precache = [...new Set(['/index.html', ...files])].sort();
      const version = createHash('sha256').update(precache.join('\n')).digest('hex').slice(0, 16);
      await build({
        configFile: false,
        root: options.appDir,
        logLevel: 'warn',
        publicDir: false,
        resolve: { alias: options.alias },
        define: {
          __PRECACHE__: JSON.stringify(precache),
          __SW_VERSION__: JSON.stringify(version),
          // the .env file (config.env) or the process (CI, the manifest fallback of vite.config.ts)
          __BRAND__: JSON.stringify(
            String(config.env.VITE_BRAND_STAFF_NAME_AR || process.env.VITE_BRAND_STAFF_NAME_AR || ''),
          ),
        },
        build: {
          outDir,
          emptyOutDir: false,
          copyPublicDir: false,
          sourcemap: false,
          minify: true,
          target: 'es2022',
          lib: {
            entry: join(options.appDir, 'src/sw/sw.ts'),
            formats: ['iife'],
            name: 'pointServiceWorker',
            fileName: () => 'sw.js',
          },
        },
      });
    },
  };
}
