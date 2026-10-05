import type { Database } from '@businessos/database';
import type { EventSubscriber } from '@businessos/events';
import { startRunsForEvent, type AutomationServices } from './runs';
import { TRIGGER_EVENTS } from './triggers';

/**
 * Starts workflow runs from domain events. Delivery is at least once; runs are unique per
 * (workflow, event), so a redelivered event never starts a second run.
 */
export function createAutomationSubscriber(
  db: Database,
  services: AutomationServices,
): EventSubscriber {
  return {
    name: 'automation',
    events: TRIGGER_EVENTS,
    handle: async (event) => {
      await startRunsForEvent(db, services, event);
    },
  };
}
