import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Migrates one template database per run; each integration file copies it.
    globalSetup: ['./test/global-database.ts'],
  },
});
