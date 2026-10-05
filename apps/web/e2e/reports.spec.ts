import { expect, test } from '@playwright/test';
import { createOrganization, registerVerifyAndSignIn, uniqueEmail } from './helpers';

test('reports: dashboard on the overview, report periods and CSV download', async ({ page }) => {
  await registerVerifyAndSignIn(page, 'Operations Manager', uniqueEmail('reports'));
  await createOrganization(page, 'Muharraq Dental');
  const orgId = /\/o\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';
  const origin = new URL(page.url()).origin;

  for (const name of ['Ali', 'Zainab']) {
    const created = await page.request.post(`/api/app/orgs/${orgId}/crm/contacts`, {
      data: { firstName: name, lastName: 'Hasan' },
      headers: { origin },
    });
    expect(created.status()).toBe(201);
  }

  // Overview: this month's headline numbers for every report the owner may open.
  await page.goto(`/o/${orgId}`);
  const dashboard = page.getByTestId('dashboard');
  await expect(dashboard.getByRole('heading', { name: 'Contacts' })).toBeVisible();
  const contactsCard = dashboard.locator('div', {
    has: page.getByRole('heading', { name: 'Contacts' }),
  });
  await expect(
    contactsCard.getByTestId('stat-tile').filter({ hasText: 'New contacts' }).first(),
  ).toContainText('2');

  // Reports page: the contacts report with its chart, tables and CSV.
  await page.getByRole('link', { name: 'Reports' }).click();
  await page
    .getByRole('navigation', { name: 'Reports' })
    .getByRole('link', { name: 'Contacts', exact: true })
    .click();
  const report = page.getByTestId('report');
  await expect(report.getByTestId('stat-tile').filter({ hasText: 'New contacts' })).toContainText(
    '2',
  );
  await expect(report.getByTestId('bar-chart').first()).toBeVisible();
  await expect(report.getByText('New contacts by source')).toBeVisible();

  const download = page.getByRole('link', { name: 'Download CSV' });
  const href = (await download.getAttribute('href')) ?? '';
  const csv = await page.request.get(href);
  expect(csv.status()).toBe(200);
  expect(csv.headers()['content-type']).toContain('text/csv');
  expect(await csv.text()).toContain('new_contacts,2');

  // An impossible period is explained, not crashed on.
  await page.getByLabel('From').fill('2026-03-10');
  await page.getByLabel('To').fill('2026-03-01');
  await page.getByRole('button', { name: 'Show' }).click();
  await expect(page.getByText('The start date is after the end date')).toBeVisible();
});
