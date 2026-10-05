import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { createOrganization, PASSWORD, registerVerifyAndSignIn, uniqueEmail } from './helpers';
import { waitForLink } from './mail';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << >>\n%%EOF\n');

test('files: attach, download and delete a file on a contact', async ({ page }) => {
  await registerVerifyAndSignIn(page, 'Records Keeper', uniqueEmail('files'));
  await createOrganization(page, 'Seef Legal');
  const orgId = /\/o\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';
  const origin = new URL(page.url()).origin;
  const created = await page.request.post(`/api/app/orgs/${orgId}/crm/contacts`, {
    data: { firstName: 'Mariam', lastName: 'Al Sayed' },
    headers: { origin },
  });
  expect(created.status()).toBe(201);
  const contactId = ((await created.json()) as { contact: { id: string } }).contact.id;

  await page.goto(`/o/${orgId}/crm/contacts/${contactId}`);
  const panel = page.getByRole('list', { name: 'Attachments' });
  await expect(page.getByText('No files attached yet.')).toBeVisible();

  await page.getByLabel('Attach file').setInputFiles({
    name: 'عقد الخدمة.pdf',
    mimeType: 'application/pdf',
    buffer: PDF,
  });
  await expect(panel.getByRole('link', { name: 'عقد الخدمة.pdf' })).toBeVisible();

  // The download is the exact bytes under the original name.
  // Served as an inert, sandboxed download, never as something the browser could run.
  const href = await panel.getByRole('link', { name: 'Download' }).getAttribute('href');
  const headers = (await page.request.get(href ?? '')).headers();
  expect(headers['content-security-policy']).toBe(
    "default-src 'none'; sandbox; frame-ancestors 'none'",
  );
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['x-frame-options']).toBe('DENY');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    panel.getByRole('link', { name: 'Download' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('عقد الخدمة.pdf');
  expect((await readFile(await download.path())).equals(PDF)).toBe(true);

  // A web page renamed to .png is refused by its content, not its name.
  await page.getByLabel('Attach file').setInputFiles({
    name: 'photo.png',
    mimeType: 'image/png',
    buffer: Buffer.from('<html><script>alert(1)</script></html>'),
  });
  await expect(page.getByText('This type of file is not allowed')).toBeVisible();
  await expect(panel.getByRole('listitem')).toHaveCount(1);

  page.once('dialog', (dialog) => void dialog.accept());
  await panel.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText('No files attached yet.')).toBeVisible();
});

test('notifications: an assigned task reaches the assignee in-app and by email', async ({
  page,
  browser,
}) => {
  await registerVerifyAndSignIn(page, 'Team Lead', uniqueEmail('lead'));
  await createOrganization(page, 'Riffa Interiors');
  const orgId = /\/o\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';

  // A teammate joins with the standard member role.
  await page.getByRole('link', { name: 'Members' }).click();
  await page.getByRole('button', { name: 'Invite member' }).click();
  const teammateEmail = uniqueEmail('teammate');
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Work email').fill(teammateEmail);
  await dialog.getByLabel('Role').selectOption({ label: 'Member' });
  await dialog.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByText(teammateEmail)).toBeVisible();
  const teammate = await browser.newPage();
  await teammate.goto(await waitForLink(teammateEmail, 'invitation'));
  await teammate.getByLabel('Full name').fill('Huda Teammate');
  await teammate.getByLabel('Password').fill(PASSWORD);
  await teammate.getByRole('button', { name: 'Create account and join' }).click();
  await expect(teammate.getByRole('heading', { name: 'Riffa Interiors' })).toBeVisible();
  const bell = teammate.getByTestId('notification-bell');
  await expect(bell).toHaveAccessibleName('Notifications');

  // The lead assigns a task to the teammate.
  await page.goto(`/o/${orgId}/crm/tasks`);
  await page.getByRole('button', { name: 'New task' }).click();
  const taskDialog = page.getByRole('dialog');
  await taskDialog.getByLabel('Title').fill('Measure the Amwaj villa');
  await taskDialog.getByLabel('Assignee').selectOption({ label: 'Huda Teammate' });
  await taskDialog.getByRole('button', { name: 'Create' }).click();
  await expect(taskDialog).toBeHidden();
  await page.getByRole('search').getByLabel('Assignee').selectOption({ label: 'All' });
  await page.getByRole('search').getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByText('Measure the Amwaj villa', { exact: true })).toBeVisible();
  // The person who acted is not notified about their own action.
  await expect(page.getByTestId('notification-bell')).toHaveAccessibleName('Notifications');

  // The worker delivers it: the teammate's bell counts it and an email links to it.
  await expect(async () => {
    await teammate.reload();
    await expect(bell).toHaveAccessibleName('Notifications, 1 unread', { timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
  expect(await waitForLink(teammateEmail, 'notification')).toContain(`/o/${orgId}/crm/tasks`);

  await bell.click();
  await expect(teammate.getByRole('heading', { name: 'Notifications' })).toBeVisible();
  const list = teammate.getByRole('list', { name: 'Notifications' });
  await expect(list.getByText('Task assigned to you: Measure the Amwaj villa')).toBeVisible();
  await teammate.getByRole('button', { name: 'Mark all as read' }).click();
  await expect(teammate.getByTestId('notifications-unread')).toContainText('0');
  await expect(bell).toHaveAccessibleName('Notifications');

  // Channel choices: the teammate turns off task emails.
  const emailToggle = teammate.getByLabel('A task is assigned to me: Email');
  await expect(emailToggle).toBeChecked();
  await emailToggle.uncheck();
  await teammate.getByRole('button', { name: 'Save preferences' }).click();
  await expect(teammate.getByText('Preferences saved.')).toBeVisible();
  await teammate.reload();
  await expect(teammate.getByLabel('A task is assigned to me: Email')).not.toBeChecked();
  // Types the member cannot access are not offered.
  await expect(teammate.getByText('A workflow I created fails')).toHaveCount(0);
});
