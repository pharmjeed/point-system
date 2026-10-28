import { fileURLToPath } from 'node:url';

// Resolved relative to the package root so it works from both src/ and dist/.
export const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));
export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const SCHEMA_SQL = fileURLToPath(new URL('../../../docs/06_schema.sql', import.meta.url));
export const INVARIANTS_SQL = fileURLToPath(
  new URL('../../../docs/06_schema_invariants_test.sql', import.meta.url),
);
