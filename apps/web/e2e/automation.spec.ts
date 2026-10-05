import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { E2E_STATE_FILE } from './global-setup';
import { createOrganization, registerVerifyAndSignIn, uniqueEmail } from './helpers';

/** Workflows need a plan that includes them: subscribe through the (fake) hosted checkout. */
async function subscribe(page: Page) {
  const { planName } = JSON.parse(readFileSync(E2E_STATE_FILE, 'utf8')) as { planName: string };
  await page.getByRole('link', { name: 'Billing' }).click();
  const card = page.locator('div', { has: page.getByRole('heading', { name: planName }) }).last();
  await card.getByRole('button', { name: 'Subscribe' }).click();
  await page.getByRole('button', { name: 'Simulate successful payment' }).click();
  await expect(page.getByText('Payment confirmed. Your plan is now active.')).toBeVisible();
}

test('workflows: build, publish, run on a new contact and from an inbound webhook', async ({
  page,
}) => {
  await registerVerifyAndSignIn(page, 'Ops Lead', uniqueEmail('automation'));
  await createOrganization(page, 'Juffair Fitness');
  const orgId = /\/o\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';
  await subscribe(page);

  const origin = new URL(page.url()).origin;
  const tagResponse = await page.request.post(`/api/app/orgs/${orgId}/crm/tags`, {
    data: { name: 'New member' },
    headers: { origin },
  });
  expect(tagResponse.status()).toBe(201);

  // Build: when a contact is created → tag them → create a follow-up task.
  await page.goto(`/o/${orgId}/automation`);
  await page.getByRole('button', { name: 'New workflow' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill('Welcome new members');
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome new members' })).toBeVisible();
  await page.getByLabel('Add step').selectOption({ label: 'Add tag' });
  await page.getByRole('button', { name: 'Add step' }).click();
  await page
    .locator('[data-step-key="step-1"]')
    .getByLabel('Tag', { exact: true })
    .selectOption({ label: 'New member' });
  await page.getByLabel('Add step').selectOption({ label: 'Create task' });
  await page.getByRole('button', { name: 'Add step' }).click();
  await expect(page.locator('[data-step-key="step-2"]').getByLabel('Task title')).toHaveValue(
    'Follow up with {{contact.fullName}}',
  );
  await page.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText('Published. New triggers start runs.')).toBeVisible();
  await expect(page.getByText('Active', { exact: true })).toBeVisible();

  // A new contact starts a run; the worker applies the tag and creates the task.
  await page.getByRole('link', { name: 'Contacts' }).click();
  await page.getByRole('button', { name: 'New contact' }).click();
  await page.getByRole('dialog').getByLabel('First name').fill('Yusuf');
  await page.getByRole('dialog').getByLabel('Last name').fill('Mahdi');
  await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: 'Yusuf Mahdi' })).toBeVisible();
  await expect(async () => {
    await page.reload();
    await expect(page.getByText('Follow up with Yusuf Mahdi', { exact: true })).toBeVisible({
      timeout: 1_000,
    });
    await expect(page.getByText('New member').first()).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });

  // Run history.
  await page.goto(`/o/${orgId}/automation`);
  await page.getByRole('link', { name: 'Runs' }).click();
  await page.getByTestId('run-row').first().click();
  const steps = page.getByTestId('run-steps');
  await expect(steps.getByText('Add tag')).toBeVisible();
  await expect(steps.getByText('Create task')).toBeVisible();
  await expect(page.getByText('Completed').first()).toBeVisible();

  // Inbound webhook: an external system creates a contact through a second workflow.
  await page.goto(`/o/${orgId}/automation`);
  await page.getByRole('button', { name: 'New workflow' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('Website sign-ups');
  await page
    .getByRole('dialog')
    .getByLabel('Starts when')
    .selectOption({ label: 'A webhook is received' });
  await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: 'Website sign-ups' })).toBeVisible();
  await page.getByLabel('Add step').selectOption({ label: 'Create or find contact' });
  await page.getByRole('button', { name: 'Add step' }).click();
  await page
    .locator('[data-step-key="step-1"]')
    .getByLabel('First name', { exact: true })
    .fill('{{trigger.body.name}}');
  await page.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText('Published. New triggers start runs.')).toBeVisible();
  await page.getByRole('button', { name: 'Create webhook URL' }).click();
  const webhookUrl = (await page.getByTestId('webhook-url').textContent()) ?? '';
  expect(webhookUrl).toMatch(/\/webhooks\/automation\/[A-Za-z0-9_-]{43}$/);

  const email = uniqueEmail('signup').toLowerCase();
  const delivered = await page.request.post(webhookUrl, {
    data: { name: 'Mariam', email },
    headers: { 'idempotency-key': 'signup-1' },
  });
  expect(delivered.status()).toBe(202);
  const duplicate = await page.request.post(webhookUrl, {
    data: { name: 'Mariam', email },
    headers: { 'idempotency-key': 'signup-1' },
  });
  expect((await duplicate.json()) as { duplicate: boolean }).toMatchObject({ duplicate: true });

  // Navigate directly: the builder may still be refreshing after the last save.
  await page.goto(`${new URL(page.url()).pathname}/runs`);
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId('run-row')).toHaveCount(1, { timeout: 1_000 });
    await expect(page.getByTestId('run-row').getByText('Completed')).toBeVisible({
      timeout: 1_000,
    });
  }).toPass({ timeout: 20_000 });
  await page.getByTestId('run-row').click();
  await page.getByRole('link', { name: 'Mariam', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Mariam' })).toBeVisible();
  await expect(page.getByText(email)).toBeVisible();
});
