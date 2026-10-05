import { describe, expect, it } from 'vitest';
import { MAX_IMPORT_PROXY_BODY_BYTES, MAX_PROXY_BODY_BYTES, maxBodyBytesFor } from './api-proxy';

describe('proxy body limits', () => {
  const org = '01a10a7d-64ba-7000-a694-68839952f9b9';

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
