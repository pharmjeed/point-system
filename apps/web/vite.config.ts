import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

const appDir = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/** Local API (`API_PORT` in 05 §8). Same origin everywhere (DEC-29): the dev server proxies these paths. */
const API_TARGET = 'http://localhost:3000';
const proxy = {
  '/v1': { target: API_TARGET, changeOrigin: false },
  '/ws': { target: API_TARGET, ws: true, changeOrigin: false },
  '/webhooks': { target: API_TARGET, changeOrigin: false },
  '/health': { target: API_TARGET, changeOrigin: false },
};

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
  return {
    root: appDir,
    envDir: repoRoot,
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@/': fileURLToPath(new URL('./src/', import.meta.url)),
        '@brand/': fileURLToPath(new URL('../../brand/', import.meta.url)),
      },
    },
    server: { port: 5173, strictPort: false, proxy },
    preview: { proxy },
    build: { target: 'es2022', sourcemap: true },
  };
});
