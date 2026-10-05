import { expect, test } from '@playwright/test';
import { createOrganization, registerVerifyAndSignIn, uniqueEmail } from './helpers';

test('shared inbox: connect a channel, receive, reply, note, assign and close', async ({
  page,
}) => {
  await registerVerifyAndSignIn(page, 'Inbox Owner', uniqueEmail('inbox'));
  await createOrganization(page, 'Muharraq Traders');

  // Connect a development email channel; the webhook URL is shown once.
  await page.getByRole('link', { name: 'Channels' }).click();
  await expect(page.getByRole('heading', { name: 'Channels' })).toBeVisible();
  await page.getByRole('button', { name: 'Connect channel' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Provider').selectOption({ label: 'Test email (development) (Email)' });
  await dialog.getByLabel('Name').fill('Support');
  await dialog.getByLabel('Sending address').fill('support@muharraq.example');
  await dialog.getByRole('button', { name: 'Connect channel' }).click();
  await expect(page.getByRole('textbox', { name: 'Webhook URL' })).toHaveValue(
    /\/webhooks\/communications\/fake_email\/[A-Za-z0-9_-]{40,}$/,
  );
  await expect(page.getByText('Active', { exact: true })).toBeVisible();

  // A customer writes in (signed test webhook through the real pipeline).
  await page.getByText('Simulate an incoming message').click();
  await page.getByLabel('From').fill('layla@example.com');
  await page.getByLabel('Sender name').fill('Layla');
  await page.getByLabel('Message', { exact: true }).fill('Do you deliver to Riffa?');
  await page.getByRole('button', { name: 'Simulate' }).click();
  await expect(page.getByText('Message received.')).toBeVisible();
  await page.waitForLoadState('networkidle');

  // The conversation is in the inbox, linked to a new contact.
  await page.getByRole('link', { name: 'Inbox', exact: true }).click();
  const list = page.getByRole('list', { name: 'Inbox' });
  await expect(list.getByText('Do you deliver to Riffa?')).toBeVisible();
  await list.getByRole('link', { name: /Layla/ }).click();
  await expect(page.getByRole('heading', { name: 'Layla' })).toBeVisible();
  const thread = page.getByRole('region', { name: 'Layla' });
  await expect(thread.getByText('Do you deliver to Riffa?')).toBeVisible();
  // Opening marks it read (then refreshes); let that settle before acting.
  await page.waitForLoadState('networkidle');

  // Reply: queued, then sent by the worker.
  await thread.getByPlaceholder('Write a reply…').fill('Yes — delivery to Riffa is BHD 2.500.');
  await thread.getByRole('button', { name: 'Send' }).click();
  await expect(thread.getByText('Yes — delivery to Riffa is BHD 2.500.')).toBeVisible();
  await page.waitForLoadState('networkidle');
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole('region', { name: 'Layla' }).getByText(/· Sent$/)).toBeVisible({
      timeout: 1_000,
    });
  }).toPass({ timeout: 20_000 });

  // Internal note (never sent to the customer).
  const region = page.getByRole('region', { name: 'Layla' });
  await region.getByRole('tab', { name: 'Note' }).click();
  await region.getByPlaceholder('Write a note for your team…').fill('Prefers evening delivery');
  await region.getByRole('button', { name: 'Add note' }).click();
  await expect(region.getByText('Prefers evening delivery')).toBeVisible();
  await expect(region.getByText('Internal note')).toBeVisible();
  await page.waitForLoadState('networkidle');

  // Assign to me and close.
  const details = page.getByRole('complementary', { name: 'Details' });
  await details.getByLabel('Assign to').selectOption({ label: 'Inbox Owner' });
  await expect(page.getByRole('list', { name: 'Inbox' }).getByText('→ Inbox Owner')).toBeVisible();
  await page.waitForLoadState('networkidle');
  await details.getByRole('button', { name: 'Close conversation' }).click();
  await expect(details.getByRole('button', { name: 'Reopen' })).toBeVisible();
  await page.waitForLoadState('networkidle');

  // The contact's timeline shows the exchange (projected by the worker).
  await details.getByRole('link', { name: 'Layla' }).click();
  await expect(page.getByRole('heading', { name: 'Layla' })).toBeVisible();
  const timeline = page.getByRole('region', { name: 'Activity' });
  await expect(async () => {
    await page.reload();
    await expect(timeline.getByText(/Email from Layla: Do you deliver to Riffa\?/)).toBeVisible({
      timeout: 1_000,
    });
  }).toPass({ timeout: 20_000 });
});
