import { describe, expect, it } from 'vitest';
import {
  buildResponseHeaders,
  MAX_FILE_PROXY_BODY_BYTES,
  MAX_IMPORT_PROXY_BODY_BYTES,
  MAX_PROXY_BODY_BYTES,
  maxBodyBytesFor,
} from './api-proxy';

describe('proxy body limits', () => {
  const org = '01a10a7d-64ba-7000-a694-68839952f9b9';

  it('raises the limit for file uploads only', () => {
    expect(maxBodyBytesFor('POST', ['app', 'orgs', org, 'files'])).toBe(MAX_FILE_PROXY_BODY_BYTES);
    expect(maxBodyBytesFor('DELETE', ['app', 'orgs', org, 'files'])).toBe(MAX_PROXY_BODY_BYTES);
    expect(maxBodyBytesFor('POST', ['app', 'orgs', org, 'files', 'x'])).toBe(MAX_PROXY_BODY_BYTES);
  });

  it('only raises the limit for CSV import uploads', () => {
    expect(maxBodyBytesFor('POST', ['app', 'orgs', org, 'crm', 'imports'])).toBe(
      MAX_IMPORT_PROXY_BODY_BYTES,
    );
    expect(maxBodyBytesFor('PATCH', ['app', 'orgs', org, 'crm', 'imports'])).toBe(
      MAX_PROXY_BODY_BYTES,
    );
    expect(maxBodyBytesFor('POST', ['app', 'orgs', org, 'crm', 'contacts'])).toBe(
      MAX_PROXY_BODY_BYTES,
    );
    expect(maxBodyBytesFor('POST', ['app', 'orgs', org, 'crm', 'imports', 'x'])).toBe(
      MAX_PROXY_BODY_BYTES,
    );
    expect(maxBodyBytesFor('POST', ['app', 'orgs', '..', 'crm', 'imports'])).toBe(
      MAX_PROXY_BODY_BYTES,
    );
  });
});

describe('proxy response headers', () => {
  it('passes file download safety headers through and drops the rest', () => {
    const upstream = new Response('x', {
      headers: {
        'content-type': 'image/png',
        'content-disposition': 'inline; filename="a.png"',
        'content-security-policy': "default-src 'none'; sandbox; frame-ancestors 'none'",
        'x-content-type-options': 'nosniff',
        'x-powered-by': 'internal',
        server: 'internal',
      },
    });
    const headers = buildResponseHeaders(upstream);
    expect(headers.get('content-security-policy')).toBe(
      "default-src 'none'; sandbox; frame-ancestors 'none'",
    );
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('x-powered-by')).toBeNull();
    expect(headers.get('server')).toBeNull();
  });
});
