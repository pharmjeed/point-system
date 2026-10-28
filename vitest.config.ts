import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// unit: pure logic, no database. integration: real PostgreSQL 16 (Testcontainers, or TEST_DATABASE_URL).
const shared = {
  resolve: { conditions: ['@point/source'] },
  plugins: [swc.vite({ jsc: { transform: { decoratorMetadata: true, legacyDecorator: true } } })],
};

export default defineConfig({
  test: {
    projects: [
      {
        ...shared,
        test: {
          name: 'unit',
          include: [
            'packages/*/src/**/*.test.ts',
            'packages/*/test/**/*.test.ts',
            'apps/{api,worker}/{src,test}/**/*.test.ts',
            'tools/*/{src,test}/**/*.test.ts',
          ],
          exclude: ['**/*.int.test.ts', '**/node_modules/**'],
        },
      },
      {
        ...shared,
        test: {
          name: 'integration',
          include: [
            'packages/*/{src,test}/**/*.int.test.ts',
            'apps/{api,worker}/{src,test}/**/*.int.test.ts',
            'tools/*/{src,test}/**/*.int.test.ts',
          ],
          globalSetup: ['packages/db/test/global-setup.ts'],
          testTimeout: 60000,
          hookTimeout: 120000,
          fileParallelism: false,
        },
      },
    ],
  },
});
