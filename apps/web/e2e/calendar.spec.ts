import { expect, test } from '@playwright/test';
import { createOrganization, registerVerifyAndSignIn, uniqueEmail } from './helpers';
import { waitForLink } from './mail';

test('online booking: set up scheduling, book publicly, see it in the calendar, reschedule and cancel', async ({
  page,
  browser,
}) => {
  await registerVerifyAndSignIn(page, 'Clinic Owner', uniqueEmail('calendar'));
  await createOrganization(page, 'Riffa Physio');
  const orgId = /\/o\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';
  expect(orgId).not.toBe('');

  // Personal calendar, an appointment type and a public booking page.
  await page.getByRole('link', { name: 'Scheduling setup' }).click();
  await page.getByRole('button', { name: 'Set up my calendar' }).click();
  await expect(page.getByText('Sunday')).toBeVisible();
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'New appointment type' }).click();
  const typeDialog = page.getByRole('dialog');
  await typeDialog.getByLabel('Name', { exact: true }).fill('Assessment');
  await typeDialog.getByLabel('Clinic Owner').check();
  await typeDialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Assessment', { exact: true })).toBeVisible();
  await page.waitForLoadState('networkidle');
  const slug = `riffa-physio-${Date.now()}`;
  await page.getByRole('button', { name: 'New booking page' }).click();
  const pageDialog = page.getByRole('dialog');
  await pageDialog.getByLabel('Title').fill('Book an assessment');
  await pageDialog.getByLabel('Link').fill(slug);
  await pageDialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('link', { name: `/book/${slug}` })).toBeVisible();

  // A customer books without an account.
  const visitor = await browser.newContext({ timezoneId: 'Asia/Bahrain' });
  const booking = await visitor.newPage();
  await booking.goto(`/book/${slug}`);
  await expect(booking.getByRole('heading', { name: 'Book an assessment' })).toBeVisible();
  await booking.getByRole('button', { name: /Assessment/ }).click();
  await expect(booking.getByText('Times shown in Asia/Bahrain')).toBeVisible();
  const slots = booking.locator('button[data-start]');
  const none = booking.getByText('No available times this week.');
  await expect(slots.first().or(none)).toBeVisible();
  // Late in the week the first free times may be next week.
  if ((await slots.count()) === 0) {
    await booking.getByRole('button', { name: /Later/ }).click();
    await expect(slots.first()).toBeVisible();
  }
  const slotButton = slots.first();
  const startsAt = (await slotButton.getAttribute('data-start')) ?? '';
  await slotButton.click();
  const inviteeEmail = uniqueEmail('invitee');
  await booking.getByLabel('Full name').fill('Huda Saleh');
  await booking.getByLabel('Email').fill(inviteeEmail);
  await booking.getByRole('button', { name: 'Confirm booking' }).click();
  await expect(booking.getByRole('heading', { name: 'You are booked' })).toBeVisible();

  // The confirmation email carries the same manage link.
  const manageLink = await waitForLink(inviteeEmail, 'appointment_confirmed');
  expect(manageLink).toContain('/book/manage/');

  // Staff see the booking, linked to a new CRM contact.
  await page.goto(`/o/${orgId}/calendar?week=${startsAt.slice(0, 10)}`);
  await expect(page.getByText('Assessment with Huda Saleh')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Huda Saleh' })).toBeVisible();

  // The customer moves the appointment, then cancels it.
  await booking.goto(manageLink);
  await expect(booking.getByRole('heading', { name: 'Your appointment' })).toBeVisible();
  await booking.getByRole('button', { name: 'Choose a new time' }).click();
  const newSlot = booking.locator(`button[data-start]:not([data-start="${startsAt}"])`).first();
  await expect(newSlot).toBeVisible();
  await newSlot.click();
  await expect(booking.getByText('Your appointment was moved.')).toBeVisible();
  await booking.getByRole('button', { name: 'Cancel appointment' }).click();
  await booking.getByRole('button', { name: 'Yes, cancel it' }).click();
  await expect(booking.getByText('This appointment is cancelled.')).toBeVisible();
  await visitor.close();

  // Cancelled appointments leave the default (scheduled) view.
  await page.reload();
  await expect(page.getByText('Assessment with Huda Saleh')).toHaveCount(0);
});
