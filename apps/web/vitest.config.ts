import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Unit tests for pure logic in the web app (formatting, API client, contrast, brand assets).
// Browser behaviour is covered by Playwright in e2e/.
export default defineConfig({
  resolve: {
    alias: {
      '@/': fileURLToPath(new URL('./src/', import.meta.url)),
      '@brand/': fileURLToPath(new URL('../../brand/', import.meta.url)),
      '@shared/': fileURLToPath(new URL('../../packages/shared/src/', import.meta.url)),
    },
  },
  test: {
    name: 'web-unit',
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
  },
});
