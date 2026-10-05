import { expect, test } from '@playwright/test';
import { createOrganization, PASSWORD, registerVerifyAndSignIn, uniqueEmail } from './helpers';
import { waitForLink } from './mail';

test('owner invites a teammate who joins with a restricted view of settings', async ({
  page,
  browser,
}) => {
  const ownerEmail = uniqueEmail('owner');
  await registerVerifyAndSignIn(page, 'Owner Person', ownerEmail);
  await createOrganization(page, 'Muharraq Logistics');

  await page.getByRole('link', { name: 'Members' }).click();
  await page.getByRole('button', { name: 'Invite member' }).click();
  const inviteeEmail = uniqueEmail('invitee');
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Work email').fill(inviteeEmail);
  await dialog.getByLabel('Role').selectOption({ label: 'Restricted' });
  await dialog.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByText(inviteeEmail)).toBeVisible();

  const invitee = await browser.newPage();
  await invitee.goto(await waitForLink(inviteeEmail, 'invitation'));
  await expect(invitee.getByRole('heading', { name: 'You are invited' })).toBeVisible();
  await invitee.getByLabel('Full name').fill('Invited Teammate');
  await invitee.getByLabel('Password').fill(PASSWORD);
  await invitee.getByRole('button', { name: 'Create account and join' }).click();
  await expect(invitee.getByRole('heading', { name: 'Muharraq Logistics' })).toBeVisible();

  // Restricted members see read-only settings and no member management controls.
  await invitee.getByRole('link', { name: 'Settings' }).click();
  await expect(invitee.getByText('You can view these settings but not change them.')).toBeVisible();
  await invitee.getByRole('link', { name: 'Members' }).click();
  await expect(invitee.getByRole('cell', { name: ownerEmail })).toBeVisible();
  await expect(invitee.getByRole('button', { name: 'Invite member' })).toHaveCount(0);

  // The owner promotes the teammate; the change applies on the teammate's next page load.
  await page.reload();
  const row = page.getByRole('row', { name: new RegExp(inviteeEmail) });
  await row.getByLabel('Change role').selectOption({ label: 'Admin' });
  await expect(row.getByRole('cell', { name: 'Admin', exact: true })).toBeVisible();

  await invitee.getByRole('link', { name: 'Settings' }).click();
  await expect(invitee.getByRole('button', { name: 'Save changes' })).toBeVisible();

  // Every step above is in the owner's audit log.
  await page.getByRole('link', { name: 'Audit log' }).click();
  for (const action of [
    'member.invited',
    'member.joined',
    'member.roles_changed',
    'organization.created',
  ]) {
    await expect(page.getByRole('cell', { name: action, exact: true }).first()).toBeVisible();
  }
});
