import { UnrecoverableError } from '@businessos/jobs';
import { describe, expect, it, vi } from 'vitest';
import { PostmarkEmailTransport } from '../src/email/transports';
import { loadWorkerEnv } from '../src/env';

const email = {
  to: 'user@example.com',
  subject: 'Verify',
  text: 'Link',
  template: 'verify_email',
  link: null,
};

function response(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Postmark transactional email transport', () => {
  it('sends from the platform sender with the server token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ MessageID: 'pm-1', ErrorCode: 0 }, 200));
    await new PostmarkEmailTransport('server-token-123', 'no-reply@businessos.example', {
      fetch: fetchMock,
    }).send(email);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({
      From: 'no-reply@businessos.example',
      To: 'user@example.com',
      Subject: 'Verify',
    });
  });

  it('retries temporary failures and dead-letters permanent rejections', async () => {
    const temporary = new PostmarkEmailTransport('server-token-123', 'a@b.example', {
      fetch: vi.fn().mockResolvedValue(response({}, 503)),
    });
    const error = await temporary.send(email).catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(UnrecoverableError);
    const permanent = new PostmarkEmailTransport('server-token-123', 'a@b.example', {
      fetch: vi
        .fn()
        .mockResolvedValue(response({ ErrorCode: 406, Message: 'Inactive recipient' }, 422)),
    });
    await expect(permanent.send(email)).rejects.toBeInstanceOf(UnrecoverableError);
  });
});

describe('worker production configuration', () => {
  const base = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://u:p@db:5432/x',
    REDIS_URL: 'redis://redis:6379',
    API_PUBLIC_URL: 'https://api.example.com',
  };

  it('requires a real email provider and credential encryption keys', () => {
    expect(() => loadWorkerEnv({ ...base, EMAIL_TRANSPORT: 'log' })).toThrow(/EMAIL_TRANSPORT/);
    expect(() => loadWorkerEnv({ ...base, EMAIL_TRANSPORT: 'postmark' })).toThrow(
      /POSTMARK_SERVER_TOKEN/,
    );
    expect(() =>
      loadWorkerEnv({
        ...base,
        EMAIL_TRANSPORT: 'postmark',
        POSTMARK_SERVER_TOKEN: 'server-token-123',
        EMAIL_FROM: 'no-reply@example.com',
      }),
    ).toThrow(/CREDENTIALS_ENCRYPTION_KEYS/);
    const key = Buffer.alloc(32, 7).toString('base64');
    expect(
      loadWorkerEnv({
        ...base,
        EMAIL_TRANSPORT: 'postmark',
        POSTMARK_SERVER_TOKEN: 'server-token-123',
        EMAIL_FROM: 'no-reply@example.com',
        CREDENTIALS_ENCRYPTION_KEYS: `k1:${key}`,
      }).EMAIL_TRANSPORT,
    ).toBe('postmark');
    expect(() =>
      loadWorkerEnv({
        ...base,
        EMAIL_TRANSPORT: 'postmark',
        POSTMARK_SERVER_TOKEN: 'server-token-123',
        EMAIL_FROM: 'no-reply@example.com',
        CREDENTIALS_ENCRYPTION_KEYS: `k1:${key}`,
        COMMUNICATIONS_FAKE_PROVIDERS: 'true',
      }),
    ).toThrow(/COMMUNICATIONS_FAKE_PROVIDERS/);
  });
});
