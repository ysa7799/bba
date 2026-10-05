import { withSystem, type Database } from '@businessos/database';
import { addPrice, createPlan, createPlanVersion, publishPlanVersion } from './catalog';

/**
 * Example catalogue for development and demos (BHD pricing). Production catalogues are managed
 * by platform administrators; code never depends on these keys.
 */
export async function seedExampleCatalog(db: Database): Promise<void> {
  // System scope: platform catalogue seeding.
  await withSystem(db, async (tx) => {
    const free = await createPlan(tx, {
      key: 'free',
      name: 'Free',
      description: 'For trying BusinessOS with a small team.',
      isDefault: true,
      sortOrder: 0,
    });
    const freeVersion = await createPlanVersion(tx, free.id, {
      'users.max': 3,
      'crm.contacts.max': 500,
      'crm.pipelines.max': 1,
      'email.monthly_limit': 200,
    });
    await publishPlanVersion(tx, freeVersion.id);

    const starter = await createPlan(tx, {
      key: 'starter',
      name: 'Starter',
      description: 'For growing teams that run sales and support in one place.',
      sortOrder: 1,
    });
    const starterVersion = await createPlanVersion(tx, starter.id, {
      'users.max': 10,
      'crm.contacts.max': 10_000,
      'crm.pipelines.max': 5,
      'automation.workflows.max': 10,
      'automation.monthly_executions': 5_000,
      'email.monthly_limit': 10_000,
      'whatsapp.monthly_limit': 1_000,
      'helpdesk.enabled': true,
      'projects.enabled': true,
    });
    await addPrice(tx, starterVersion.id, {
      currency: 'BHD',
      interval: 'month',
      amountMinor: 15_000n,
    });
    await addPrice(tx, starterVersion.id, {
      currency: 'BHD',
      interval: 'year',
      amountMinor: 150_000n,
    });
    await publishPlanVersion(tx, starterVersion.id);

    const growth = await createPlan(tx, {
      key: 'growth',
      name: 'Growth',
      description: 'Automation, marketing and API access for scaling businesses.',
      sortOrder: 2,
    });
    const growthVersion = await createPlanVersion(tx, growth.id, {
      'users.max': 50,
      'crm.contacts.max': null,
      'crm.pipelines.max': null,
      'automation.workflows.max': null,
      'automation.monthly_executions': 100_000,
      'email.monthly_limit': 100_000,
      'sms.monthly_limit': 2_000,
      'whatsapp.monthly_limit': 10_000,
      'ai.monthly_credits': 5_000,
      'helpdesk.enabled': true,
      'projects.enabled': true,
      'marketing.enabled': true,
      'api.enabled': true,
    });
    await addPrice(tx, growthVersion.id, {
      currency: 'BHD',
      interval: 'month',
      amountMinor: 45_000n,
    });
    await addPrice(tx, growthVersion.id, {
      currency: 'BHD',
      interval: 'year',
      amountMinor: 450_000n,
    });
    await publishPlanVersion(tx, growthVersion.id);
  });
}
