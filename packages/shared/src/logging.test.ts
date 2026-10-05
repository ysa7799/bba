import { describe, expect, it } from 'vitest';
import { redactSensitive, redactUrlForLog } from './logging';

describe('redactSensitive', () => {
  it('redacts sensitive keys at any depth', () => {
    expect(
      redactSensitive({
        email: 'a@example.com',
        password: 'hunter22',
        nested: { accessToken: 'x', items: [{ apiKey: 'k', name: 'ok' }] },
      }),
    ).toEqual({
      email: 'a@example.com',
      password: '[REDACTED]',
      nested: { accessToken: '[REDACTED]', items: [{ apiKey: '[REDACTED]', name: 'ok' }] },
    });
  });
});

describe('redactUrlForLog', () => {
  it('masks webhook routing tokens and sensitive query values', () => {
    expect(
      redactUrlForLog(
        '/webhooks/communications/whatsapp_cloud/AbCdEf0123456789_-xyzAbCdEf0123456789',
      ),
    ).toBe('/webhooks/communications/whatsapp_cloud/[REDACTED]');
    expect(
      redactUrlForLog(
        '/webhooks/communications/whatsapp_cloud/tok123456789012345678?hub.mode=subscribe&hub.verify_token=s3cret&hub.challenge=42',
      ),
    ).toBe(
      '/webhooks/communications/whatsapp_cloud/[REDACTED]?hub.mode=subscribe&hub.verify_token=[REDACTED]&hub.challenge=42',
    );
    expect(redactUrlForLog('/auth/verify?token=abc&next=%2Fo')).toBe(
      '/auth/verify?token=[REDACTED]&next=%2Fo',
    );
    expect(redactUrlForLog('/app/orgs/1/crm/contacts?q=ali&limit=10')).toBe(
      '/app/orgs/1/crm/contacts?q=ali&limit=10',
    );
    expect(
      redactUrlForLog(
        '/public/booking/manage/AbCdEf0123456789_-xyzAbCdEf0123456789abcdefgh/slots?from=x',
      ),
    ).toBe('/public/booking/manage/[REDACTED]/slots?from=x');
    expect(redactUrlForLog('/webhooks/communications/fake_email')).toBe(
      '/webhooks/communications/fake_email',
    );
    expect(redactUrlForLog('/webhooks/automation/AbCdEf0123456789_-xyzAbCdEf0123456789abcde')).toBe(
      '/webhooks/automation/[REDACTED]',
    );
  });
});
