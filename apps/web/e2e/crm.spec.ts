import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { createOrganization, registerVerifyAndSignIn, uniqueEmail } from './helpers';

test('runs the CRM: contact, note, task, deal board, CSV import and export', async ({
  page,
  browser,
}) => {
  await registerVerifyAndSignIn(page, 'Sales Owner', uniqueEmail('crm-owner'));
  await createOrganization(page, 'Manama Trading');
  const orgPath = new URL(page.url()).pathname;

  // Contacts start empty, then the owner adds one with a local Bahrain number.
  await page.getByRole('link', { name: 'Contacts' }).click();
  await expect(page.getByText('No contacts yet.')).toBeVisible();
  await page.getByRole('button', { name: 'New contact' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('First name').fill('Fatima');
  await dialog.getByLabel('Last name').fill('Al Khalifa');
  await dialog.getByLabel('Email').fill('fatima@gulf-steel.example');
  await dialog.getByLabel('Phone', { exact: true }).fill('3312 3456');
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: 'Fatima Al Khalifa' })).toBeVisible();
  await expect(page.getByRole('link', { name: '+97333123456' })).toBeVisible();
  const contactUrl = page.url();

  // Notes and tasks on the contact.
  await page.getByLabel('Add note').fill('Met at Gulf Industry Expo; wants a quote.');
  await page.getByRole('button', { name: 'Add note' }).click();
  await expect(page.getByText('Met at Gulf Industry Expo; wants a quote.').first()).toBeVisible();
  await page.getByRole('button', { name: 'New task' }).click();
  await page.getByRole('dialog').getByLabel('Title').fill('Send steel quote');
  await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
  await expect(page.getByText('Send steel quote', { exact: true })).toBeVisible();

  // A deal linked to the contact appears on the board and moves to Won.
  await page.getByRole('link', { name: 'Deals' }).click();
  await expect(page.getByRole('region', { name: 'Lead' })).toBeVisible();
  await page.getByRole('button', { name: 'New deal' }).click();
  const dealDialog = page.getByRole('dialog');
  await dealDialog.getByLabel('Deal name').fill('Rebar supply 2026');
  await dealDialog.getByLabel('Amount').fill('12500.250');
  await dealDialog.getByLabel('Contact').fill('Fatima');
  await dealDialog.getByRole('button', { name: 'Fatima Al Khalifa' }).click();
  await dealDialog.getByRole('button', { name: 'Create' }).click();
  const lead = page.getByRole('region', { name: 'Lead' });
  await expect(lead.getByRole('link', { name: 'Rebar supply 2026' })).toBeVisible();
  await expect(lead.getByText('BHD 12,500.250').first()).toBeVisible();
  await lead.getByLabel('Move to stage: Rebar supply 2026').selectOption({ label: 'Won' });
  const won = page.getByRole('region', { name: 'Won' });
  await expect(won.getByRole('link', { name: 'Rebar supply 2026' })).toBeVisible();
  // The move is optimistic; let the background refresh finish before reloading.
  await page.waitForLoadState('networkidle');
  await page.reload();
  await expect(
    page.getByRole('region', { name: 'Won' }).getByRole('link', { name: 'Rebar supply 2026' }),
  ).toBeVisible();

  // CSV import (semicolon separated, processed by the worker).
  await page.getByRole('link', { name: 'Import & export' }).click();
  await page.getByLabel('CSV file').setInputFiles({
    name: 'leads.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      'First name;Email;Mobile\nAli;ali@riffa.example;3999 0000\nBroken;not-an-email;\n',
    ),
  });
  await expect(page.getByRole('heading', { name: /Map columns/ })).toBeVisible();
  await page.getByRole('button', { name: 'Preview first rows' }).click();
  await expect(page.getByText(/email: Invalid email address/i)).toBeVisible();
  await page.getByRole('button', { name: 'Start import' }).click();
  await expect(page.getByText('1 created · 0 updated · 0 skipped · 1 failed')).toBeVisible({
    timeout: 20_000,
  });

  // Export runs in the background and downloads as CSV.
  await page.getByRole('button', { name: 'Export: Contacts' }).click();
  const downloadLink = page.getByRole('link', { name: 'Download' }).first();
  await expect(downloadLink).toBeVisible({ timeout: 20_000 });
  const [download] = await Promise.all([page.waitForEvent('download'), downloadLink.click()]);
  const csv = readFileSync(await download.path(), 'utf8');
  expect(csv).toContain('Fatima');
  expect(csv).toContain('ali@riffa.example');
  expect(csv).toContain("'+97333123456");

  // Imported contacts are searchable.
  await page.getByRole('link', { name: 'Contacts' }).click();
  await page.getByRole('searchbox').fill('ali@riffa');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByRole('link', { name: 'Ali', exact: true })).toBeVisible();

  // Another organization's member cannot open the contact by URL.
  const outsider = await browser.newPage();
  await registerVerifyAndSignIn(outsider, 'Other Owner', uniqueEmail('crm-outsider'));
  await createOrganization(outsider, 'Sitra Shipping');
  await outsider.goto(contactUrl);
  await expect(outsider.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await outsider.goto(`${orgPath}/crm/deals`);
  await expect(outsider.getByRole('heading', { name: 'Page not found' })).toBeVisible();
});
