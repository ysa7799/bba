import { expect, test } from '@playwright/test';
import { createOrganization, registerVerifyAndSignIn, uniqueEmail } from './helpers';

test('commerce: catalogue, invoice, customer pays online; quote accepted and invoiced', async ({
  page,
  browser,
}) => {
  await registerVerifyAndSignIn(page, 'Finance Lead', uniqueEmail('commerce'));
  await createOrganization(page, 'Adliya Physio');
  const orgId = /\/o\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';
  const origin = new URL(page.url()).origin;

  // Setup: VAT 10% and the (development) payment provider.
  await page.getByRole('link', { name: 'Invoicing setup' }).click();
  await page.getByRole('button', { name: 'Add tax rate' }).click();
  await expect(page.getByTestId('tax-rates').getByText('VAT · 10%')).toBeVisible();
  await page.getByLabel('Provider').selectOption({ label: 'Test payments (development)' });
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page.getByTestId('payment-connection').getByText('Active')).toBeVisible();

  // Catalogue: a service priced in BHD (three decimals) with VAT by default.
  await page.getByRole('link', { name: 'Products' }).click();
  await page.getByRole('button', { name: 'New product or service' }).click();
  const productDialog = page.getByRole('dialog');
  await productDialog.getByLabel('Name').fill('Physiotherapy session');
  await productDialog.getByLabel('Default tax').selectOption({ label: 'VAT 10%' });
  await productDialog.getByLabel('Price', { exact: true }).fill('25.500');
  await productDialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTestId('product-list').getByText('BHD 25.500')).toBeVisible();

  const email = uniqueEmail('patient').toLowerCase();
  const contactResponse = await page.request.post(`/api/app/orgs/${orgId}/crm/contacts`, {
    data: { firstName: 'Huda', lastName: 'Saleh', email },
    headers: { origin },
  });
  expect(contactResponse.status()).toBe(201);

  // Invoice: 2 × BHD 25.500 + VAT 10% = BHD 56.100 (computed by the server).
  await page.getByRole('link', { name: 'Invoices' }).click();
  await page.getByRole('link', { name: 'New invoice' }).click();
  await page.getByLabel('Customer', { exact: true }).fill('Huda');
  await page.getByRole('button', { name: 'Huda Saleh' }).click();
  const line = page.getByTestId('line-editor').first();
  await line.getByLabel('Product').selectOption({ label: 'Physiotherapy session' });
  await line.getByLabel('Qty').fill('2');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByRole('heading', { name: 'Draft' })).toBeVisible();
  await expect(page.getByTestId('document-totals')).toContainText('BHD 56.100');

  await page.getByRole('button', { name: 'Issue invoice' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Issue invoice' }).click();
  await expect(page.getByText('Emailed to the customer.')).toBeVisible();
  const link = (await page.getByTestId('customer-link').textContent()) ?? '';
  expect(link).toMatch(/\/i\/[A-Za-z0-9_-]{43}$/);
  await expect(page.getByRole('heading', { name: /^INV-\d{6}$/ })).toBeVisible();

  // The customer opens the link without an account and pays online.
  const customer = await browser.newContext();
  const invoicePage = await customer.newPage();
  await invoicePage.goto(new URL(link).pathname);
  await expect(invoicePage.getByTestId('document-number')).toHaveText(/^INV-\d{6}$/);
  await invoicePage.getByRole('button', { name: 'Pay BHD 56.100' }).click();
  await invoicePage.getByRole('button', { name: 'Simulate successful payment' }).click();
  await expect(invoicePage.getByText('This invoice has been paid.')).toBeVisible({
    timeout: 15_000,
  });
  await customer.close();

  await page.reload();
  await expect(page.getByTestId('status-badge').first()).toHaveText('Paid');
  await expect(page.getByTestId('invoice-payments')).toContainText('BHD 56.100');
  await expect(page.getByTestId('invoice-payments')).toContainText('Online');

  // Quote: sent, accepted by the customer, then invoiced with the same amounts.
  await page.getByRole('link', { name: 'Quotes' }).click();
  await page.getByRole('link', { name: 'New quote' }).click();
  await page.getByLabel('Customer', { exact: true }).fill('Huda');
  await page.getByRole('button', { name: 'Huda Saleh' }).click();
  const quoteLine = page.getByTestId('line-editor').first();
  await quoteLine.getByLabel('Description').fill('Rehabilitation programme (6 weeks)');
  await quoteLine.getByLabel('Unit price').fill('180');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByRole('heading', { name: /^QUO-\d{6}$/ })).toBeVisible();
  await page.getByRole('button', { name: 'Send quote' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Send quote' }).click();
  const quoteLink = (await page.getByTestId('customer-link').textContent()) ?? '';
  expect(quoteLink).toMatch(/\/q\/[A-Za-z0-9_-]{43}$/);

  const prospect = await browser.newContext();
  const quotePage = await prospect.newPage();
  await quotePage.goto(new URL(quoteLink).pathname);
  await expect(quotePage.getByTestId('document-totals')).toContainText('BHD 180.000');
  await quotePage.getByRole('button', { name: 'Accept quote' }).click();
  await expect(quotePage.getByText('You accepted this quote.')).toBeVisible();
  await prospect.close();

  await page.reload();
  await expect(page.getByTestId('status-badge').first()).toHaveText('Accepted');
  await page.getByRole('button', { name: 'Create invoice' }).click();
  await expect(page.getByRole('heading', { name: 'Draft' })).toBeVisible();
  await expect(page.getByTestId('document-totals')).toContainText('BHD 180.000');
});
