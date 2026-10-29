import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

const appDir = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Local API on `API_PORT` (05 §8, default 3000). Same origin everywhere (DEC-29): the dev server and
 * `vite preview` (the e2e server, also for the live-API mode of PNT-036) proxy these paths.
 */
function apiProxy(mode: string) {
  const port = process.env.API_PORT ?? loadEnv(mode, repoRoot, '').API_PORT ?? '3000';
  const target = `http://localhost:${port}`;
  return {
    '/v1': { target, changeOrigin: false },
    '/ws': { target, ws: true, changeOrigin: false },
    '/webhooks': { target, changeOrigin: false },
    '/health': { target, changeOrigin: false },
  };
}

/**
 * Brand names come from VITE_BRAND_* (canon §1, 05 §8). The single `.env` lives at the repo root (envDir).
 * When a variable is not set at all (fresh clone, CI), the staff name falls back to the brand asset that
 * already carries it (`short_name` of the copied manifest) — never to a literal in the source.
 */
function applyBrandDefaults(mode: string): void {
  const env = loadEnv(mode, repoRoot, 'VITE_');
  if (!env.VITE_BRAND_STAFF_NAME_AR && !process.env.VITE_BRAND_STAFF_NAME_AR) {
    const manifest = JSON.parse(
      readFileSync(new URL('./public/manifest.webmanifest', import.meta.url), 'utf8'),
    ) as {
      short_name?: string;
    };
    if (manifest.short_name) process.env.VITE_BRAND_STAFF_NAME_AR = manifest.short_name;
  }
}

export default defineConfig(({ mode }) => {
  applyBrandDefaults(mode);
  const proxy = apiProxy(mode);
  return {
    root: appDir,
    envDir: repoRoot,
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@/': fileURLToPath(new URL('./src/', import.meta.url)),
        '@brand/': fileURLToPath(new URL('../../brand/', import.meta.url)),
        // the canon as zod schemas (realtime envelopes, Web Push payload): source files of @point/shared,
        // bundled into the chunks that use them (05 §3 «packages/shared zod wire schemas»)
        '@shared/': fileURLToPath(new URL('../../packages/shared/src/', import.meta.url)),
      },
    },
    server: { port: 5173, strictPort: false, proxy },
    preview: { proxy },
    build: { target: 'es2022', sourcemap: true },
  };
});
