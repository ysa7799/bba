import { expect, test } from '@playwright/test';
import { createOrganization, registerVerifyAndSignIn, uniqueEmail } from './helpers';

test('forms: build and publish, submit publicly, review the submission and the new contact', async ({
  page,
  browser,
}) => {
  await registerVerifyAndSignIn(page, 'Marketing Lead', uniqueEmail('forms'));
  await createOrganization(page, 'Seef Interiors');

  // Build: the default fields map to the contact; add a choice field and allow one embed site.
  await page.getByRole('link', { name: 'Forms' }).click();
  await page.getByRole('button', { name: 'New form' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('Website enquiry');
  await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: 'Website enquiry' })).toBeVisible();
  await expect(page.locator('[data-field-key="email"]')).toBeVisible();

  await page.getByLabel('Type', { exact: true }).last().selectOption('radio');
  await page.getByRole('button', { name: 'Add field' }).click();
  const added = page.locator('li[data-field-key="single_choice"]');
  await added.getByLabel('Label').fill('Project size');
  await expect(page.locator('li[data-field-key="project_size"]')).toBeVisible();
  const sizeField = page.locator('li[data-field-key="project_size"]');
  await sizeField.getByLabel('Options').fill('One room\nWhole home');
  await sizeField.getByLabel('Required').check();
  await page.getByLabel('Websites allowed to embed this form').fill('https://www.example.com');
  await page.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText('Published.')).toBeVisible();

  const publicLink = page.getByRole('link', { name: /^\/f\// });
  await expect(publicLink).toBeVisible();
  const path = (await publicLink.textContent()) ?? '';
  expect(path).toMatch(/^\/f\/website-enquiry-[a-z0-9]{6}$/);

  // Framing: only the embed route, only for the allowed site.
  const embed = await page.request.get(`${path}/embed`);
  expect(embed.status()).toBe(200);
  expect(embed.headers()['content-security-policy']).toBe(
    'frame-ancestors https://www.example.com',
  );
  expect(embed.headers()['x-frame-options']).toBeUndefined();
  const standalone = await page.request.get(path);
  expect(standalone.headers()['x-frame-options']).toBe('DENY');

  // A visitor submits without an account. Validation errors come back per field.
  const visitor = await browser.newContext();
  const form = await visitor.newPage();
  await form.goto(path);
  await expect(form.getByRole('heading', { name: 'Website enquiry' })).toBeVisible();
  await form.getByLabel('Full name *').fill('Layla Hasan');
  await form.getByLabel('Email *').fill('not-an-email');
  await form.getByLabel('Whole home').check();
  await form.getByLabel('Message').fill('We are renovating a villa in Saar.');
  // People take a few seconds; instant submissions are treated as automated.
  await form.waitForTimeout(3_200);
  await form.getByRole('button', { name: 'Submit' }).click();
  await expect(form.getByText('Invalid email address')).toBeVisible();
  const email = uniqueEmail('layla');
  await form.getByLabel('Email *').fill(email);
  await form.getByRole('button', { name: 'Submit' }).click();
  await expect(form.getByText('Thank you. We have received your submission.')).toBeVisible();
  await visitor.close();

  // Staff see the submission, linked to the new contact.
  await page.getByRole('link', { name: 'Submissions' }).click();
  await page.getByText('Layla Hasan').first().click();
  await expect(page.getByText('We are renovating a villa in Saar.')).toBeVisible();
  await expect(page.getByText('Whole home')).toBeVisible();
  await page.getByRole('link', { name: 'Layla Hasan', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Layla Hasan' })).toBeVisible();
  await expect(page.getByText(email.toLowerCase())).toBeVisible();

  // The worker projects the submission onto the contact timeline.
  const timeline = page.getByRole('region', { name: 'Activity' });
  await expect(async () => {
    await page.reload();
    await expect(timeline.getByText('Submitted Website enquiry')).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
});
