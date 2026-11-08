import { createTestDatabase, type TestDatabase } from '@point/db/testing';
import { Database } from '../src/core/db/database.js';
import { FakeClock, type Clock } from '../src/core/clock/clock.js';
import { createLogger } from '../src/core/logging/logger.js';

export interface TestContext {
  testDb: TestDatabase;
  db: Database;
  clock: FakeClock;
  close(): Promise<void>;
}

export async function setupDb(clock: FakeClock = new FakeClock()): Promise<TestContext> {
  const testDb = await createTestDatabase();
  const db = new Database({ connectionString: testDb.url, poolMax: 30 }, clock as Clock);
  return {
    testDb,
    db,
    clock,
    async close() {
      await db.close();
      await testDb.drop();
    },
  };
}

export const silentLogger = createLogger({ level: 'silent' });

export const ORG = '00000000-0000-4000-8000-000000000001';
export const USER = '00000000-0000-4000-8000-0000000000c1';

export async function insertOrgAndUser(db: Database): Promise<void> {
  await db.query(`INSERT INTO organizations (id, name_ar) VALUES ($1, 'مؤسسة') ON CONFLICT DO NOTHING`, [
    ORG,
  ]);
  await db.query(
    `INSERT INTO users (id, org_id, employee_code, full_name, phone_e164, role, secret_kind, secret_hash)
     VALUES ($1, $2, 'D-0001', 'سائق', '+966500000001', 'driver', 'pin', 'x') ON CONFLICT DO NOTHING`,
    [USER, ORG],
  );
}
