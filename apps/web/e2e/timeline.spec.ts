import { expect, test } from '@playwright/test';
import { createOrganization, registerVerifyAndSignIn, uniqueEmail } from './helpers';

test('contact timeline shows worker-projected history and logged calls', async ({ page }) => {
  await registerVerifyAndSignIn(page, 'Timeline Owner', uniqueEmail('timeline'));
  await createOrganization(page, 'Hidd Hardware');

  await page.getByRole('link', { name: 'Contacts' }).click();
  await page.getByRole('button', { name: 'New contact' }).click();
  await page.getByRole('dialog').getByLabel('First name').fill('Yusuf');
  await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: 'Yusuf' })).toBeVisible();

  await page.getByLabel('Add note').fill('Interested in bulk cement.');
  await page.getByRole('button', { name: 'Add note' }).click();
  await expect(page.getByText('Interested in bulk cement.').first()).toBeVisible();
  await page.waitForLoadState('networkidle');

  // History is projected by the worker from domain events; it appears within seconds.
  const timeline = page.getByRole('region', { name: 'Activity' });
  await expect(async () => {
    await page.reload();
    await expect(timeline.getByText('Contact created')).toBeVisible({ timeout: 1_000 });
    await expect(timeline.getByText('Interested in bulk cement.')).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });

  // Log a call and filter to calls & messages.
  await timeline.getByRole('button', { name: 'Log activity' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Summary').fill('Called about delivery to Hidd');
  await dialog.getByLabel('Details').fill('Prefers morning deliveries');
  await dialog.getByLabel('Duration (minutes)').fill('7');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(timeline.getByText('Called about delivery to Hidd')).toBeVisible();
  await timeline.getByRole('tab', { name: 'Calls & messages' }).click();
  await expect(timeline.getByTestId('timeline-item')).toHaveCount(1);
  await expect(timeline.getByText('Prefers morning deliveries')).toBeVisible();
  await timeline.getByRole('tab', { name: 'Notes' }).click();
  await expect(timeline.getByText('Interested in bulk cement.')).toBeVisible();
  await expect(timeline.getByText('Called about delivery to Hidd')).toHaveCount(0);
});
