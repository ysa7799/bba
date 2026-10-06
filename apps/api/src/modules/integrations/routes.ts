import { recordAudit } from '@businessos/audit';
import {
  connectCalendarAccount,
  disconnectAccountCalendars,
  getCalendarRow,
} from '@businessos/calendar';
import { withTenant, type TenantTx } from '@businessos/database';
import {
  completeAuthorization,
  completeAuthorizationInputSchema,
  disconnectAccount,
  getAccountRow,
  IntegrationTemporarilyUnavailable,
  listAccounts,
  listProviders,
  startAuthorization,
  startAuthorizationInputSchema,
} from '@businessos/integrations';
import { resolveMembership } from '@businessos/organizations';
import type { Permission } from '@businessos/permissions';
import { ForbiddenError, ProviderError, ValidationError } from '@businessos/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { auditContext } from '../../lib/http';
import { parseInput } from '../../lib/validation';
import { requireAuth } from '../../plugins/session';
import { requirePermission, requireTenant, resolveTenant, tenantScope } from '../../plugins/tenant';

const idParams = z.object({ id: z.uuid() });

/** Calendar provider used for each OAuth provider, and which of its calendars to use. */
const CALENDAR_PROVIDERS: Record<
  string,
  { provider: string; calendar: (label: string) => string }
> = {
  google: { provider: 'google_calendar', calendar: () => 'primary' },
  // Graph addresses a mailbox's calendar by the mailbox address.
  microsoft: { provider: 'microsoft_calendar', calendar: (label) => label },
  fake_oauth: { provider: 'fake_calendar', calendar: () => 'primary' },
};

interface Member {
  organizationId: string;
  userId: string;
  permissions: ReadonlySet<Permission>;
}

/**
 * Who may connect an account for a calendar: `calendar.manage`, or the member's own personal
 * calendar with `calendar.appointment.manage` (the same rule as pasted credentials).
 */
async function requireCalendarEditor(tx: TenantTx, member: Member, calendarId: string | undefined) {
  if (!calendarId || !z.uuid().safeParse(calendarId).success) {
    throw new ValidationError('Choose a calendar', [
      { path: 'context.calendarId', message: 'Required' },
    ]);
  }
  const calendar = await getCalendarRow(tx, member.organizationId, calendarId);
  const own =
    calendar.userId === member.userId && member.permissions.has('calendar.appointment.manage');
  if (!own && !member.permissions.has('calendar.manage')) throw new ForbiddenError();
  return calendar;
}

/**
 * `/app/orgs/:orgId/integrations` — connected accounts (OAuth). Members connect accounts for a
 * purpose they are allowed to use and manage their own; `integrations.manage` sees and
 * disconnects everyone's.
 */
export function integrationRoutes(app: FastifyInstance): void {
  const db = () => app.deps.db.db;

  app.addHook('preHandler', async (request) => {
    await resolveTenant(request);
  });

  app.get('/providers', (request) => {
    requireTenant(request);
    return {
      encryptionConfigured: app.integrations.secretBox !== null,
      data: listProviders(app.integrations),
    };
  });

  app.get('/accounts', async (request) => {
    const tenant = requireTenant(request);
    const everyone = tenant.permissions.has('integrations.manage');
    return {
      data: await withTenant(db(), tenantScope(tenant), (tx) =>
        listAccounts(tx, app.integrations, tenant.organizationId, {
          ...(everyone ? {} : { onlyUserId: tenant.userId }),
        }),
      ),
    };
  });

  app.post('/oauth/start', async (request) => {
    const tenant = requireTenant(request);
    const input = parseInput(startAuthorizationInputSchema, request.body);
    if (input.purpose !== 'calendar') {
      throw new ValidationError('Unknown purpose', [{ path: 'purpose', message: 'Not supported' }]);
    }
    if (!CALENDAR_PROVIDERS[input.provider]) {
      throw new ValidationError('Unknown provider', [
        { path: 'provider', message: 'Not supported' },
      ]);
    }
    await withTenant(db(), tenantScope(tenant), (tx) =>
      requireCalendarEditor(tx, tenant, input.context.calendarId),
    );
    return startAuthorization(app.integrations, tenantScope(tenant), {
      provider: input.provider,
      purpose: input.purpose,
      context: { calendarId: input.context.calendarId ?? '' },
    });
  });

  app.delete('/accounts/:id', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseInput(idParams, request.params);
    const revoke = await withTenant(db(), tenantScope(tenant), async (tx) => {
      const row = await getAccountRow(tx, tenant.organizationId, id);
      if (row.connectedByUserId !== tenant.userId) {
        requirePermission(request, 'integrations.manage');
      }
      const result = await disconnectAccount(app.integrations, tx, tenant.organizationId, id);
      const calendars = await disconnectAccountCalendars(tx, tenant.organizationId, id);
      await recordAudit(tx, auditContext(request), {
        organizationId: tenant.organizationId,
        action: 'integration.disconnected',
        target: { type: 'integration_account', id },
        metadata: { provider: row.provider, account: row.accountLabel, calendars },
      });
      return result.revoke;
    });
    // After commit: a slow provider never holds the transaction open.
    await revoke();
    return reply.status(204).send();
  });
}

/**
 * `/app/oauth/complete` — the web app's `/oauth/callback` page posts the provider's answer here
 * with the signed-in person's session. The organization comes from the stored state, never from
 * the request; permissions for the purpose are checked again.
 */
export function oauthCompletionRoutes(app: FastifyInstance): void {
  const db = () => app.deps.db.db;

  app.post('/complete', async (request: FastifyRequest) => {
    const auth = requireAuth(request);
    const input = parseInput(completeAuthorizationInputSchema, request.body);
    let completed;
    try {
      completed = await completeAuthorization(app.integrations, auth.user.id, input);
    } catch (error) {
      if (error instanceof IntegrationTemporarilyUnavailable) {
        throw new ProviderError('oauth', error.message, { retryable: true });
      }
      throw error;
    }
    const membership = await resolveMembership(db(), auth.user.id, completed.organizationId);
    if (!membership) throw new ForbiddenError();
    const member: Member = {
      organizationId: completed.organizationId,
      userId: auth.user.id,
      permissions: membership.access.permissions,
    };
    const scope = { organizationId: completed.organizationId, userId: auth.user.id };
    const mapping = CALENDAR_PROVIDERS[completed.account.provider];
    const redirectTo = await withTenant(db(), scope, async (tx) => {
      await recordAudit(tx, auditContext(request), {
        organizationId: completed.organizationId,
        action: 'integration.connected',
        target: { type: 'integration_account', id: completed.account.id },
        metadata: {
          provider: completed.account.provider,
          account: completed.account.accountLabel,
          purpose: completed.purpose,
        },
      });
      if (completed.purpose === 'calendar' && mapping) {
        const calendar = await requireCalendarEditor(tx, member, completed.context.calendarId);
        const connection = await connectCalendarAccount(
          tx,
          completed.organizationId,
          app.calendar,
          calendar.id,
          {
            provider: mapping.provider,
            integrationAccountId: completed.account.id,
            externalCalendarId: mapping.calendar(completed.account.accountLabel),
          },
        );
        await recordAudit(tx, auditContext(request), {
          organizationId: completed.organizationId,
          action: 'calendar.connection.connected',
          target: { type: 'calendar_connection', id: connection.id },
          metadata: {
            provider: connection.provider,
            calendarId: calendar.id,
            integrationAccountId: completed.account.id,
          },
        });
        return `/o/${completed.organizationId}/calendar/settings?calendar=${calendar.id}`;
      }
      return `/o/${completed.organizationId}/settings/integrations`;
    });
    return { account: completed.account, redirectTo };
  });
}
