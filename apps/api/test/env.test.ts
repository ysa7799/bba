import { describe, expect, it } from 'vitest';
import { loadApiEnv } from '../src/env';

const base = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379/0',
  APP_URL: 'http://localhost:3000',
  CORS_ORIGINS: 'http://localhost:3000, http://localhost:3001',
};

describe('API environment validation', () => {
  it('parses a valid development environment', () => {
    const env = loadApiEnv(base);
    expect(env.API_PORT).toBe(4000);
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:3000', 'http://localhost:3001']);
    expect(env.TRUST_PROXY).toBe(false);
  });

  it('parses proxy trust settings', () => {
    expect(loadApiEnv({ ...base, TRUST_PROXY: 'true' }).TRUST_PROXY).toBe(true);
    expect(loadApiEnv({ ...base, TRUST_PROXY: '2' }).TRUST_PROXY).toBe(2);
    expect(loadApiEnv({ ...base, TRUST_PROXY: '10.0.0.0/8, 127.0.0.1' }).TRUST_PROXY).toBe(
      '10.0.0.0/8, 127.0.0.1',
    );
  });

  it('fails fast without leaking values', () => {
    expect(() => loadApiEnv({ ...base, DATABASE_URL: 'mysql://secret-pass@host/db' })).toThrow(
      /DATABASE_URL/,
    );
    try {
      loadApiEnv({ ...base, DATABASE_URL: 'mysql://secret-pass@host/db' });
    } catch (error) {
      expect(String(error)).not.toContain('secret-pass');
    }
  });

  it('refuses insecure production configuration', () => {
    expect(() => loadApiEnv({ ...base, NODE_ENV: 'production' })).toThrow(/https/);
    expect(() =>
      loadApiEnv({
        ...base,
        NODE_ENV: 'production',
        APP_URL: 'https://app.example.com',
        CORS_ORIGINS: 'https://app.example.com',
        COOKIE_SECURE: 'false',
      }),
    ).toThrow(/COOKIE_SECURE/);
    expect(() =>
      loadApiEnv({
        ...base,
        NODE_ENV: 'production',
        APP_URL: 'https://app.example.com',
        CORS_ORIGINS: 'https://app.example.com',
        PASSWORD_HASH_MEMORY_KIB: '4096',
      }),
    ).toThrow(/OWASP/);
  });

  it('requires a real email provider in production (CONFIGURATION_REQUIRED)', () => {
    let message = '';
    try {
      loadApiEnv({
        ...base,
        NODE_ENV: 'production',
        APP_URL: 'https://app.example.com',
        CORS_ORIGINS: 'https://app.example.com',
      });
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain('MAIL_TRANSPORT');
    expect(message).toContain('CONFIGURATION_REQUIRED');
    expect(message).not.toContain('APP_URL');
  });
});
