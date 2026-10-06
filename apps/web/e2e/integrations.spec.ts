import { expect, test } from '@playwright/test';
import { createOrganization, registerVerifyAndSignIn, uniqueEmail } from './helpers';

test('connected accounts: a calendar connects through OAuth consent and can be disconnected', async ({
  page,
}) => {
  await registerVerifyAndSignIn(page, 'Scheduling Lead', uniqueEmail('oauth'));
  await createOrganization(page, 'Hidd Dental');
  const orgId = /\/o\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';

  await page.getByRole('link', { name: 'Scheduling setup' }).click();
  await page.getByRole('button', { name: 'Set up my calendar' }).click();
  await expect(page.getByText('Sunday')).toBeVisible();
  await page.waitForLoadState('networkidle');

  // Google and Microsoft are not offered until the server has OAuth clients for them.
  await expect(page.getByRole('button', { name: 'Connect with Google' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Connect with Test account (development)' }).click();

  // The provider's consent screen (the development stand-in), then back through the callback.
  await expect(page.getByRole('heading', { name: 'Test sign-in (development)' })).toBeVisible();
  await page.getByLabel('Account email').fill('dentist.calendar@example.com');
  await page.getByRole('button', { name: 'Allow access' }).click();
  await page.waitForURL(new RegExp(`/o/${orgId}/calendar/settings\\?calendar=`));
  await expect(page.getByText('Test calendar (development) · primary')).toBeVisible();
  await expect(page.getByText(/Active · through a connected account/)).toBeVisible();

  // The account is listed (no tokens anywhere on the page) and can be disconnected.
  await page.getByRole('link', { name: 'Connected accounts' }).click();
  const accounts = page.getByRole('list', { name: 'Connected accounts' });
  await expect(accounts.getByText('dentist.calendar@example.com')).toBeVisible();
  await expect(accounts.getByText('Connected', { exact: true })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('fake-access-');
  await expect(
    page
      .getByRole('list', { name: 'Providers' })
      .getByText('Not set up on this server yet')
      .first(),
  ).toBeVisible();
  page.once('dialog', (dialog) => void dialog.accept());
  await accounts.getByRole('button', { name: 'Disconnect' }).click();
  await expect(page.getByText('No connected accounts yet.')).toBeVisible();

  // Refusing consent connects nothing.
  await page.getByRole('link', { name: 'Scheduling setup' }).click();
  await page.getByRole('button', { name: 'Connect with Test account (development)' }).click();
  await page.getByRole('button', { name: 'Deny' }).click();
  await expect(page.getByText('The connection was cancelled')).toBeVisible();
});
