import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { E2E_STATE_FILE } from './global-setup';
import { createOrganization, registerVerifyAndSignIn, uniqueEmail } from './helpers';

test('subscribes to a paid plan through hosted checkout; activation needs server verification', async ({
  page,
}) => {
  const { planName } = JSON.parse(readFileSync(E2E_STATE_FILE, 'utf8')) as { planName: string };
  await registerVerifyAndSignIn(page, 'Paying Owner', uniqueEmail('payer'));
  await createOrganization(page, 'Riffa Retail');

  await page.getByRole('link', { name: 'Billing' }).click();
  const card = page.locator('div', { has: page.getByRole('heading', { name: planName }) }).last();
  await expect(card.getByText('BHD 19.500')).toBeVisible();
  await card.getByRole('button', { name: 'Subscribe' }).click();

  // Hosted payment page (fake provider in end-to-end runs).
  await expect(page.getByRole('heading', { name: 'Development payment page' })).toBeVisible();
  const returnUrl = new URL(page.url()).searchParams.get('return') ?? '';

  // Visiting the return page before paying must not activate anything.
  await page.goto(
    `${new URL(returnUrl).pathname}${new URL(returnUrl).search}&status=CAPTURED&tap_id=chg_forged`,
  );
  await expect(page.getByText(/Confirming your payment|Still waiting/)).toBeVisible();
  await page.goBack();

  await page.getByRole('button', { name: 'Simulate successful payment' }).click();
  await expect(page.getByText('Payment confirmed. Your plan is now active.')).toBeVisible();

  await page.getByRole('link', { name: 'Back to billing' }).click();
  await expect(page.getByText(planName).first()).toBeVisible();
  await expect(page.getByText('Current plan', { exact: true }).last()).toBeVisible();
  await expect(page.getByText('1 / 25')).toBeVisible();
});
