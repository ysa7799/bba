import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  casing: 'snake_case',
  dbCredentials: {
    url:
      process.env.MIGRATION_DATABASE_URL ??
      'postgres://businessos:businessos@localhost:5432/businessos_dev',
  },
  strict: true,
  verbose: true,
});
