import { describe, expect, it } from 'vitest';
import { redactSensitive } from './logging';

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
