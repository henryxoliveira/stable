import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Applies migrations to DATABASE_URL_TEST once before the run.
    globalSetup: ['./tests/global-setup.js'],
    // Test files share one database, so run them one at a time.
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 60000,
  },
});
