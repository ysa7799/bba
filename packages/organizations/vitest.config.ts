import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    globalSetup: ['@businessos/testing/global-setup'],
    setupFiles: ['@businessos/testing/setup-env'],
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
