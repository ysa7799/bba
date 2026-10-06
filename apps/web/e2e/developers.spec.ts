import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import pg from 'pg';
import { createOrganization, registerVerifyAndSignIn, uniqueEmail } from './helpers';

/** Grants an entitlement the way a platform administrator would (an override row). */
async function grantEntitlement(organizationId: string, key: string) {
  const client = new pg.Client({
    connectionString:
      process.env.MIGRATION_DATABASE_URL ??
      'postgres://businessos:businessos@localhost:5432/businessos_test',
  });
  await client.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.system', 'on', true)");
    await client.query(
      `insert into entitlement_overrides (id, organization_id, key, value, reason)
       values (gen_random_uuid(), $1, $2, '{"value": true}', 'end-to-end test')`,
      [organizationId, key],
    );
    await client.query('commit');
  } finally {
    await client.end();
  }
}

/** Verifies a delivery exactly as the documentation tells receivers to. */
function verify(body: string, header: string, secret: string): boolean {
  const timestamp = Number(/(?:^|,)t=(\d+)/.exec(header)?.[1]);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest();
  const signatures = header
    .split(',')
    .filter((part) => part.startsWith('v1='))
    .map((part) => Buffer.from(part.slice(3), 'hex'));
  return signatures.some(
    (signature) => signature.length === expected.length && timingSafeEqual(signature, expected),
  );
}

test('developers: API keys call the public API; webhooks deliver signed events', async ({
  page,
}) => {
  const received: { body: string; headers: IncomingHttpHeaders }[] = [];
  const receiver = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      received.push({ body, headers: request.headers });
      response.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const hookUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/businessos`;

  try {
    await registerVerifyAndSignIn(page, 'Integration Lead', uniqueEmail('developer'));
    await createOrganization(page, 'Sitra Systems');
    const orgId = /\/o\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';

    // Without the API in the plan, nothing can be created.
    await page.getByRole('link', { name: 'API & webhooks' }).click();
    await expect(page.getByText('Your plan does not include the public API.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create API key' })).toHaveCount(0);

    await grantEntitlement(orgId, 'api.enabled');
    await page.reload();
    const apiBase = (await page.getByTestId('api-base-url').textContent())?.trim() ?? '';
    expect(apiBase).toMatch(/\/api\/v1$/);

    // A key that can read and create contacts, shown once.
    await page.getByRole('button', { name: 'Create API key' }).click();
    const keyDialog = page.getByRole('dialog');
    await keyDialog.getByLabel('Name', { exact: true }).fill('Website sync');
    await keyDialog.getByLabel('View contacts').check();
    await keyDialog.getByLabel('Create contacts').check();
    await keyDialog.getByRole('button', { name: 'Create key' }).click();
    const key = (await page.getByTestId('revealed-secret').textContent())?.trim() ?? '';
    expect(key).toMatch(/^bos_/);
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByText('Website sync')).toBeVisible();

    // A webhook endpoint for new contacts, with its signing secret shown once.
    await page.getByRole('button', { name: 'Add endpoint' }).click();
    const endpointDialog = page.getByRole('dialog');
    await endpointDialog.getByLabel('Endpoint URL').fill(hookUrl);
    await endpointDialog.getByLabel('Description').fill('Website CRM sync');
    await endpointDialog.getByLabel('contact.created').check();
    await endpointDialog.getByRole('button', { name: 'Save endpoint' }).click();
    const secret = (await page.getByTestId('revealed-secret').textContent())?.trim() ?? '';
    expect(secret).toMatch(/^whsec_/);
    await page.getByRole('button', { name: 'Done' }).click();

    // The public API with the key: allowed operations work, others are refused.
    const auth = { authorization: `Bearer ${key}` };
    const created = await page.request.post(`${apiBase}/contacts`, {
      headers: { ...auth, 'idempotency-key': 'website-signup-42' },
      data: { firstName: 'Reem', lastName: 'Al Mannai', email: 'reem@example.com' },
    });
    expect(created.status()).toBe(201);
    const contactId = ((await created.json()) as { contact: { id: string } }).contact.id;
    const replay = await page.request.post(`${apiBase}/contacts`, {
      headers: { ...auth, 'idempotency-key': 'website-signup-42' },
      data: { firstName: 'Reem', lastName: 'Al Mannai', email: 'reem@example.com' },
    });
    expect(((await replay.json()) as { contact: { id: string } }).contact.id).toBe(contactId);
    expect((await page.request.get(`${apiBase}/deals`, { headers: auth })).status()).toBe(403);
    expect((await page.request.get(`${apiBase}/contacts`)).status()).toBe(401);

    // The new contact reaches the endpoint as a signed contact.created delivery.
    await expect
      .poll(() => received.find((entry) => entry.body.includes(contactId)), { timeout: 20_000 })
      .toBeTruthy();
    const delivery = received.find((entry) => entry.body.includes(contactId));
    expect(JSON.parse(delivery?.body ?? '{}')).toMatchObject({
      type: 'contact.created',
      organizationId: orgId,
      data: { contactId },
    });
    expect(
      verify(delivery?.body ?? '', String(delivery?.headers['businessos-signature']), secret),
    ).toBe(true);
    expect(
      verify(
        delivery?.body ?? '',
        String(delivery?.headers['businessos-signature']),
        'whsec_wrong',
      ),
    ).toBe(false);

    // A test event from the endpoint page, visible in its delivery log.
    await page.getByRole('link', { name: 'Details' }).click();
    await page.getByRole('button', { name: 'Send test event' }).click();
    await expect(page.getByText('Test event queued.')).toBeVisible();
    await expect
      .poll(() => received.some((entry) => entry.body.includes('"webhook.test"')), {
        timeout: 20_000,
      })
      .toBe(true);
    await expect(async () => {
      await page.getByRole('button', { name: 'Refresh' }).click();
      await expect(
        page.getByRole('list', { name: 'Deliveries' }).getByText('webhook.test'),
      ).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
    await expect(
      page.getByRole('list', { name: 'Deliveries' }).getByText('Delivered').first(),
    ).toBeVisible();

    // Revoking the key stops it at once.
    await page.getByRole('link', { name: 'API & webhooks' }).first().click();
    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByRole('button', { name: 'Revoke' }).click();
    await expect(page.getByText('Revoked', { exact: true })).toBeVisible();
    expect((await page.request.get(`${apiBase}/me`, { headers: auth })).status()).toBe(401);
  } finally {
    receiver.closeAllConnections();
    await new Promise((resolve) => receiver.close(resolve));
  }
});
