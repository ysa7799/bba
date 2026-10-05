import { expect, type Page } from '@playwright/test';
import { waitForLink } from './mail';

export const PASSWORD = 'correct horse battery staple';

export function uniqueEmail(label: string): string {
  return `${label}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}@example.com`;
}

/**
 * A distinct client IP for this browser context. Every E2E request comes from 127.0.0.1, so
 * without it the suite's sign-ups would share the production per-IP registration limit. The
 * web server trusts the header in E2E (`TRUST_PROXY_HEADERS`), as it would behind a load
 * balancer.
 */
export async function asDistinctVisitor(page: Page): Promise<void> {
  const octet = () => 1 + Math.floor(Math.random() * 254);
  await page.context().setExtraHTTPHeaders({
    'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}`,
  });
}

export async function registerVerifyAndSignIn(page: Page, name: string, email: string) {
  await asDistinctVisitor(page);
  await page.goto('/register');
  await page.getByLabel('Full name').fill(name);
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await page.goto(await waitForLink(email, 'verify_email'));
  await expect(page.getByText('Your email is verified')).toBeVisible();
  await page.goto('/login');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

export async function createOrganization(page: Page, name: string) {
  await expect(page.getByRole('heading', { name: 'Create your organization' })).toBeVisible();
  await page.getByLabel('Organization name').fill(name);
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
}
