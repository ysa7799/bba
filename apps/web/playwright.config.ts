import { defineConfig, devices } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

/**
 * End-to-end tests against the built web app and API (run `pnpm build` first).
 * Uses the test database; emails are captured via the API's file mail transport.
 */
const WEB_PORT = 3100;
const API_PORT = 4100;
const WORKER_HEALTH_PORT = 4200;
const QUEUE_PREFIX = `e2e${Date.now()}`;
// Fresh channel-credential encryption key per run (shared by the API and the worker).
const CREDENTIALS_ENCRYPTION_KEYS = `e2e:${randomBytes(32).toString('base64')}`;
const repoRoot = path.resolve(import.meta.dirname, '../..');
export const MAIL_FILE = path.join(repoRoot, 'apps/web/test-results/e2e-mail.jsonl');

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(executablePath ? { launchOptions: { executablePath } } : {}),
      },
    },
  ],
  webServer: [
    {
      command: 'node --enable-source-maps dist/server.js',
      cwd: path.join(repoRoot, 'apps/api'),
      url: `http://localhost:${API_PORT}/health/ready`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        NODE_ENV: 'test',
        LOG_LEVEL: 'warn',
        DATABASE_URL:
          process.env.DATABASE_URL ??
          'postgres://businessos_app:businessos_app@localhost:5432/businessos_test',
        REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379/1',
        REDIS_KEY_PREFIX: `e2e:${Date.now()}:`,
        API_HOST: '127.0.0.1',
        API_PORT: String(API_PORT),
        APP_URL: `http://localhost:${WEB_PORT}`,
        CORS_ORIGINS: `http://localhost:${WEB_PORT}`,
        TRUST_PROXY: '127.0.0.1',
        QUEUE_PREFIX: QUEUE_PREFIX,
        PAYMENTS_PROVIDER: 'fake',
        API_PUBLIC_URL: `http://localhost:${API_PORT}`,
        CREDENTIALS_ENCRYPTION_KEYS,
        COMMUNICATIONS_FAKE_PROVIDERS: 'true',
        PASSWORD_HASH_MEMORY_KIB: '4096',
        PASSWORD_HASH_TIME_COST: '1',
      },
    },
    {
      // Emails are delivered by the worker (email.send jobs) using the file transport.
      command: 'node --enable-source-maps dist/main.js',
      cwd: path.join(repoRoot, 'apps/worker'),
      url: `http://localhost:${WORKER_HEALTH_PORT}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        NODE_ENV: 'test',
        LOG_LEVEL: 'warn',
        DATABASE_URL:
          process.env.DATABASE_URL ??
          'postgres://businessos_app:businessos_app@localhost:5432/businessos_test',
        REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379/1',
        QUEUE_PREFIX: QUEUE_PREFIX,
        WORKER_HEALTH_PORT: String(WORKER_HEALTH_PORT),
        EMAIL_TRANSPORT: 'file',
        EMAIL_FILE_PATH: MAIL_FILE,
        OUTBOX_POLL_MS: '200',
        API_PUBLIC_URL: `http://localhost:${API_PORT}`,
        APP_URL: `http://localhost:${WEB_PORT}`,
        CREDENTIALS_ENCRYPTION_KEYS,
        COMMUNICATIONS_FAKE_PROVIDERS: 'true',
      },
    },
    {
      command: `pnpm exec next start --port ${WEB_PORT}`,
      cwd: path.join(repoRoot, 'apps/web'),
      url: `http://localhost:${WEB_PORT}/login`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        API_INTERNAL_URL: `http://127.0.0.1:${API_PORT}`,
        // Each test acts as its own visitor (see `asDistinctVisitor` in e2e/helpers.ts).
        TRUST_PROXY_HEADERS: 'true',
        ENABLE_DEV_PAYMENTS: 'true',
      },
    },
  ],
});
