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
        API_PUBLIC_URL: 'https://api.example.com',
        COOKIE_SECURE: 'false',
      }),
    ).toThrow(/COOKIE_SECURE/);
    expect(() =>
      loadApiEnv({
        ...base,
        NODE_ENV: 'production',
        APP_URL: 'https://app.example.com',
        CORS_ORIGINS: 'https://app.example.com',
        API_PUBLIC_URL: 'https://api.example.com',
        PASSWORD_HASH_MEMORY_KIB: '4096',
      }),
    ).toThrow(/OWASP/);
    const secure = {
      ...base,
      NODE_ENV: 'production',
      APP_URL: 'https://app.example.com',
      CORS_ORIGINS: 'https://app.example.com',
      API_PUBLIC_URL: 'https://api.example.com',
      FILES_STORAGE: 's3',
      S3_BUCKET: 'bos-files',
    };
    expect(() => loadApiEnv(secure)).toThrow(/CREDENTIALS_ENCRYPTION_KEYS/);
    const keys = `k1:${Buffer.alloc(32, 3).toString('base64')}`;
    expect(() => loadApiEnv({ ...secure, CREDENTIALS_ENCRYPTION_KEYS: keys })).not.toThrow();
    expect(() =>
      loadApiEnv({ ...secure, CREDENTIALS_ENCRYPTION_KEYS: keys, FILES_STORAGE: 'local' }),
    ).toThrow(/FILES_STORAGE/);
    expect(() =>
      loadApiEnv({ ...secure, CREDENTIALS_ENCRYPTION_KEYS: keys, S3_BUCKET: undefined }),
    ).toThrow(/S3_BUCKET/);
    expect(() =>
      loadApiEnv({
        ...secure,
        CREDENTIALS_ENCRYPTION_KEYS: keys,
        COMMUNICATIONS_FAKE_PROVIDERS: 'true',
      }),
    ).toThrow(/COMMUNICATIONS_FAKE_PROVIDERS/);
    expect(() =>
      loadApiEnv({ ...secure, CREDENTIALS_ENCRYPTION_KEYS: keys, COMMERCE_FAKE_PAYMENTS: 'true' }),
    ).toThrow(/COMMERCE_FAKE_PAYMENTS/);
    expect(() =>
      loadApiEnv({
        ...secure,
        CREDENTIALS_ENCRYPTION_KEYS: keys,
        WEBHOOKS_ALLOW_PRIVATE_NETWORK: 'true',
      }),
    ).toThrow(/WEBHOOKS_ALLOW_PRIVATE_NETWORK/);
  });

  it('validates credential encryption keys without echoing them', () => {
    expect(() => loadApiEnv({ ...base, CREDENTIALS_ENCRYPTION_KEYS: 'k1:dG9vLXNob3J0' })).toThrow(
      /CREDENTIALS_ENCRYPTION_KEYS/,
    );
    try {
      loadApiEnv({ ...base, CREDENTIALS_ENCRYPTION_KEYS: 'k1:dG9vLXNob3J0' });
    } catch (error) {
      expect(String(error)).not.toContain('dG9vLXNob3J0');
    }
  });
});
