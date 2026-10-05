import { expect, test } from '@playwright/test';
import { PASSWORD, uniqueEmail } from './helpers';
import { waitForLink } from './mail';

test('register → verify → sign in → create organization → members → sign out', async ({ page }) => {
  const email = uniqueEmail('owner');

  await page.goto('/register');
  await page.getByLabel('Full name').fill('Noor Al-Khalifa');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

  const verifyLink = await waitForLink(email, 'verify_email');
  await page.goto(verifyLink);
  await expect(page.getByText('Your email is verified')).toBeVisible();
  await page.getByRole('link', { name: 'Continue to sign in' }).click();

  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByRole('heading', { name: 'Create your organization' })).toBeVisible();
  await page.getByLabel('Organization name').fill('Seef Trading Co');
  await page.getByRole('button', { name: 'Create organization' }).click();

  await expect(page.getByRole('heading', { name: 'Seef Trading Co' })).toBeVisible();
  const details = page.getByTestId('organization-details');
  await expect(details.getByText('BHD', { exact: true })).toBeVisible();
  await expect(details.getByText('Asia/Bahrain', { exact: true })).toBeVisible();

  // Billing shows the baseline plan limits for an organization without a subscription.
  await page.getByRole('link', { name: 'Billing' }).click();
  await expect(page.getByText('No subscription — baseline limits apply.')).toBeVisible();
  await expect(page.getByText('1 / 3')).toBeVisible();

  await page.getByRole('link', { name: 'Members' }).click();
  await expect(page.getByRole('cell', { name: email })).toBeVisible();
  await page.getByPlaceholder('Search members').fill('nobody-matches-this');
  await page.getByPlaceholder('Search members').press('Enter');
  await expect(page.getByText('No members match your search.')).toBeVisible();

  const orgUrl = page.url().replace(/\/members.*$/, '');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

  await page.goto(orgUrl);
  await expect(page).toHaveURL(/\/login\?next=/);
});

test('password reset signs out other sessions', async ({ page, browser }) => {
  const email = uniqueEmail('reset');
  await page.goto('/register');
  await page.getByLabel('Full name').fill('Ali');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.goto(await waitForLink(email, 'verify_email'));
  await expect(page.getByText('Your email is verified')).toBeVisible();

  await page.goto('/login');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Create your organization' })).toBeVisible();

  const other = await browser.newPage();
  await other.goto('/forgot-password');
  await other.getByLabel('Work email').fill(email);
  await other.getByRole('button', { name: 'Send reset link' }).click();
  await expect(other.getByText('a reset link is on its way')).toBeVisible();
  await other.goto(await waitForLink(email, 'password_reset'));
  await other.getByLabel('New password').fill('a different password 9');
  await other.getByRole('button', { name: 'Update password' }).click();
  await expect(other.getByText('Your password has been updated')).toBeVisible();

  await page.reload();
  await expect(page).toHaveURL(/\/login/);
});

test('ignores off-site redirect targets after sign-in', async ({ page }) => {
  const email = uniqueEmail('redirect');
  await page.goto('/register');
  await page.getByLabel('Full name').fill('Redirect Tester');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.goto(await waitForLink(email, 'verify_email'));
  await expect(page.getByText('Your email is verified')).toBeVisible();

  await page.goto('/login?next=//evil.example.com/steal');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Create your organization' })).toBeVisible();
  expect(new URL(page.url()).host).toBe('localhost:3100');
});
