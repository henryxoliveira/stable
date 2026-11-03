/** Runs once before all tests: bring the test database schema up to date. */
import { migrateTestDb } from '../scripts/migrate-test-db.js';

export default function setup() {
  migrateTestDb();
}
