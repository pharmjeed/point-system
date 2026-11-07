import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// No 'module' condition: it selects bundler-only builds (e.g. the AWS SDK's extensionless ESM) that Node cannot load.
// unit: pure logic, no database. integration: real PostgreSQL 16 (Testcontainers, or TEST_DATABASE_URL).
const conditions = ['@point/source', 'node', 'development|production'];
const shared = {
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: ['@point/source'] } },
  plugins: [swc.vite({ jsc: { transform: { decoratorMetadata: true, legacyDecorator: true } } })],
};

export default defineConfig({
  test: {
    projects: [
      {
        ...shared,
        test: {
          name: 'unit',
          server: { deps: { inline: [/@point\//, /packages\/.*\/src/] } },
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
          server: { deps: { inline: [/@point\//, /packages\/.*\/src/] } },
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
      // apps/web keeps its own config (aliases, browser-free unit tests); Playwright covers the browser
      'apps/web/vitest.config.ts',
      {
        // V2-011: the customer app's logic (API client, fake backend, contracts, screen models) in node; screens stay
        // thin over these modules and React Native is never imported here (DEC-483).
        ...shared,
        test: {
          name: 'customer-unit',
          server: { deps: { inline: [/@point\//, /packages\/.*\/src/] } },
          include: ['apps/customer/{src,test}/**/*.test.ts'],
          environment: 'node',
        },
      },
    ],
  },
});
