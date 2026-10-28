import { defineConfig } from 'drizzle-kit';

// The SQL migrations are the source of truth (docs/06_schema.sql verbatim). Drizzle is used for typed
// table definitions only: `pnpm --filter @point/db pull` regenerates src/schema from a migrated database.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://point:point@localhost:5432/point' },
  tablesFilter: ['!schema_migrations'],
  introspect: { casing: 'preserve' },
});
