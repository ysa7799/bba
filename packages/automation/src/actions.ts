import { queueMessage, startConversation } from '@businessos/communications';
import {
  addTags,
  createContact,
  createDeal,
  createTask,
  eventMeta,
  findContactByEmail,
  moveDeal,
  normalizeEmail,
  removeTags,
  updateContact,
  type CrmContext,
  type UpdateContactInput,
} from '@businessos/crm';
import {
  CONTACT_STATUSES,
  LIFECYCLE_STAGES,
  TASK_PRIORITIES,
  type AutomationRun,
  type TenantTx,
} from '@businessos/database';
import { emitEvent } from '@businessos/events';
import { currencyCodeSchema, ValidationError } from '@businessos/shared';
import { z } from 'zod';
import { isValidPath, renderTemplate, templatePaths, type RunContext } from './context';
import { postJson } from './http';

/** A text field that may contain `{{placeholders}}`; unknown placeholders are refused. */
function template(max: number) {
  return z
    .string()
    .max(max)
    .superRefine((value, ctx) => {
      for (const path of templatePaths(value)) {
        if (!isValidPath(path)) {
          ctx.addIssue({ code: 'custom', message: `Unknown placeholder {{${path}}}` });
        }
      }
    });
}

const DAY_MS = 86_400_000;

export interface ActionContext {
  tx: TenantTx;
  crm: CrmContext;
  run: AutomationRun;
  nodeKey: string;
  context: RunContext;
  now: Date;
}

export interface ExternalActionContext {
  run: AutomationRun;
  nodeKey: string;
  context: RunContext;
  allowPrivateNetwork: boolean;
  ownHosts: readonly string[];
}

export interface QueuedJob {
  name: 'communications.send';
  payload: { organizationId: string; messageId: string };
  jobId: string;
}

export interface ActionResult {
  output: Record<string, unknown>;
  /** Jobs to enqueue once the step has committed. */
  jobs?: QueuedJob[];
  /** The run's contact or deal from now on (e.g. after "create contact"). */
  contactId?: string;
  dealId?: string;
}

interface ActionDefinition<Schema extends z.ZodType> {
  schema: Schema;
  /** The run must have a contact (or deal) for this action. */
  requires: 'contact' | 'deal' | null;
  /** Runs outside the database transaction (calls the outside world). */
  external?: boolean;
  run?: (ctx: ActionContext, config: z.infer<Schema>) => Promise<ActionResult>;
  runExternal?: (ctx: ExternalActionContext, config: z.infer<Schema>) => Promise<ActionResult>;
}

function define<Schema extends z.ZodType>(definition: ActionDefinition<Schema>) {
  return definition;
}

function contactOf(ctx: ActionContext): string {
  const id = ctx.context.contact?.id;
  if (!id) throw new ValidationError('This step needs a contact; the run has none');
  return id;
}

function dealOf(ctx: ActionContext): string {
  const id = ctx.context.deal?.id;
  if (!id) throw new ValidationError('This step needs a deal; the run has none');
  return id;
}

async function sendMessage(
  ctx: ActionContext,
  connectionId: string,
  body: {
    subject?: string;
    text?: string;
    template?: { name: string; language: string; parameters: string[] };
  },
): Promise<ActionResult> {
  const contactId = contactOf(ctx);
  const { conversation } = await startConversation(ctx.tx, ctx.crm, {
    connectionId,
    contactId,
    ...(body.subject ? { subject: body.subject } : {}),
  });
  const message = await queueMessage(ctx.tx, ctx.crm, conversation.id, body);
  return {
    output: { conversationId: conversation.id, messageId: message.id },
    jobs: [
      {
        name: 'communications.send',
        payload: { organizationId: ctx.crm.organizationId, messageId: message.id },
        // Same id as messages sent from the inbox: one delivery job per message.
        jobId: `msg-${message.id}`,
      },
    ],
  };
}

export const ACTIONS = {
  'contact.create': define({
    requires: null,
    schema: z
      .object({
        firstName: template(200).default(''),
        lastName: template(200).default(''),
        email: template(320).default(''),
        phone: template(60).default(''),
      })
      .refine((config) => Object.values(config).some((value) => value.trim() !== ''), {
        message: 'Fill in at least one detail',
      }),
    run: async (ctx, config) => {
      const render = (value: string) => renderTemplate(value, ctx.context).trim();
      const email = render(config.email);
      if (email) {
        const existing = await findContactByEmail(
          ctx.tx,
          ctx.crm.organizationId,
          normalizeEmail(email),
        );
        if (existing)
          return { output: { contactId: existing, created: false }, contactId: existing };
      }
      const created = await createContact(ctx.tx, ctx.crm, {
        firstName: render(config.firstName) || null,
        lastName: render(config.lastName) || null,
        email: email || null,
        phone: render(config.phone) || null,
        source: 'automation',
        ownerUserId: null,
      });
      return { output: { contactId: created.id, created: true }, contactId: created.id };
    },
  }),
  'contact.update': define({
    requires: 'contact',
    schema: z
      .object({
        firstName: template(200).optional(),
        lastName: template(200).optional(),
        jobTitle: template(150).optional(),
        lifecycleStage: z.enum(LIFECYCLE_STAGES).optional(),
        status: z.enum(CONTACT_STATUSES).optional(),
      })
      .refine((config) => Object.keys(config).length > 0, {
        message: 'Choose what to change',
      }),
    run: async (ctx, config) => {
      const patch: UpdateContactInput = {};
      for (const key of ['firstName', 'lastName', 'jobTitle'] as const) {
        const value = config[key];
        if (value === undefined) continue;
        const rendered = renderTemplate(value, ctx.context).trim();
        if (rendered) patch[key] = rendered;
      }
      if (config.lifecycleStage) patch.lifecycleStage = config.lifecycleStage;
      if (config.status) patch.status = config.status;
      const result = await updateContact(ctx.tx, ctx.crm, contactOf(ctx), patch);
      return { output: { changedFields: result.changedFields } };
    },
  }),
  'contact.add_tag': define({
    requires: 'contact',
    schema: z.object({ tagId: z.uuid() }),
    run: async (ctx, config) => {
      const contactId = contactOf(ctx);
      const added = await addTags(
        ctx.tx,
        ctx.crm.organizationId,
        'contact',
        [contactId],
        [config.tagId],
      );
      for (const pair of added) {
        await emitEvent(ctx.tx, {
          ...eventMeta(ctx.crm),
          type: 'contact.tag_added',
          subject: { type: 'contact', id: contactId },
          payload: { contactId, tagId: pair.tagId },
        });
      }
      return { output: { added: added.length > 0 } };
    },
  }),
  'contact.remove_tag': define({
    requires: 'contact',
    schema: z.object({ tagId: z.uuid() }),
    run: async (ctx, config) => {
      const contactId = contactOf(ctx);
      const removed = await removeTags(
        ctx.tx,
        ctx.crm.organizationId,
        'contact',
        [contactId],
        [config.tagId],
      );
      for (const pair of removed) {
        await emitEvent(ctx.tx, {
          ...eventMeta(ctx.crm),
          type: 'contact.tag_removed',
          subject: { type: 'contact', id: contactId },
          payload: { contactId, tagId: pair.tagId },
        });
      }
      return { output: { removed: removed.length > 0 } };
    },
  }),
  'contact.assign_owner': define({
    requires: 'contact',
    schema: z.object({ userId: z.uuid() }),
    run: async (ctx, config) => {
      const result = await updateContact(ctx.tx, ctx.crm, contactOf(ctx), {
        ownerUserId: config.userId,
      });
      return { output: { changedFields: result.changedFields } };
    },
  }),
  'deal.create': define({
    requires: null,
    schema: z.object({
      pipelineId: z.uuid(),
      stageId: z.uuid().nullable().default(null),
      name: template(200).refine((value) => value.trim() !== '', 'Enter a deal name'),
      /** A fixed value set by staff (never taken from trigger data). */
      value: z
        .object({
          amount: z.string().regex(/^\d{1,15}(\.\d{1,3})?$/),
          currency: currencyCodeSchema,
        })
        .nullable()
        .default(null),
    }),
    run: async (ctx, config) => {
      const name = renderTemplate(config.name, ctx.context, 200).trim() || 'New deal';
      const deal = await createDeal(ctx.tx, ctx.crm, {
        name,
        pipelineId: config.pipelineId,
        ...(config.stageId ? { stageId: config.stageId } : {}),
        contactId: ctx.context.contact?.id ?? null,
        ownerUserId: ctx.context.contact?.ownerUserId ?? null,
        ...(config.value ? { value: config.value } : {}),
      });
      return { output: { dealId: deal.id }, dealId: deal.id };
    },
  }),
  'deal.move': define({
    requires: 'deal',
    schema: z.object({ pipelineId: z.uuid(), stageId: z.uuid() }),
    run: async (ctx, config) => {
      const { after } = await moveDeal(ctx.tx, ctx.crm, dealOf(ctx), {
        pipelineId: config.pipelineId,
        stageId: config.stageId,
      });
      return { output: { stageId: after.stageId, status: after.status } };
    },
  }),
  'task.create': define({
    requires: null,
    schema: z
      .object({
        title: template(300).refine((value) => value.trim() !== '', 'Enter a title'),
        description: template(5_000).default(''),
        dueInDays: z.number().int().min(0).max(365).nullable().default(null),
        priority: z.enum(TASK_PRIORITIES).default('normal'),
        assignee: z.enum(['contact_owner', 'deal_owner', 'user', 'none']).default('contact_owner'),
        userId: z.uuid().nullable().default(null),
      })
      .refine((config) => config.assignee !== 'user' || config.userId !== null, {
        message: 'Choose who gets the task',
        path: ['userId'],
      }),
    run: async (ctx, config) => {
      const assigneeUserId =
        config.assignee === 'user'
          ? config.userId
          : config.assignee === 'contact_owner'
            ? (ctx.context.contact?.ownerUserId ?? null)
            : config.assignee === 'deal_owner'
              ? (ctx.context.deal?.ownerUserId ?? null)
              : null;
      const description = renderTemplate(config.description, ctx.context, 5_000).trim();
      const task = await createTask(ctx.tx, ctx.crm, {
        title: renderTemplate(config.title, ctx.context, 300).trim() || 'Follow up',
        ...(description ? { description } : {}),
        dueAt:
          config.dueInDays === null
            ? null
            : new Date(ctx.now.getTime() + config.dueInDays * DAY_MS).toISOString(),
        priority: config.priority,
        assigneeUserId,
        contactId: ctx.context.contact?.id ?? null,
        dealId: ctx.context.deal?.id ?? null,
      });
      return { output: { taskId: task.id } };
    },
  }),
  'message.email': define({
    requires: 'contact',
    schema: z.object({
      connectionId: z.uuid(),
      subject: template(300).refine((value) => value.trim() !== '', 'Enter a subject'),
      body: template(10_000).refine((value) => value.trim() !== '', 'Write the message'),
    }),
    run: (ctx, config) =>
      sendMessage(ctx, config.connectionId, {
        subject: renderTemplate(config.subject, ctx.context, 300).trim(),
        text: renderTemplate(config.body, ctx.context),
      }),
  }),
  'message.sms': define({
    requires: 'contact',
    schema: z.object({
      connectionId: z.uuid(),
      body: template(1_600).refine((value) => value.trim() !== '', 'Write the message'),
    }),
    run: (ctx, config) =>
      sendMessage(ctx, config.connectionId, {
        text: renderTemplate(config.body, ctx.context, 1_600),
      }),
  }),
  'message.whatsapp': define({
    requires: 'contact',
    schema: z.object({
      connectionId: z.uuid(),
      templateName: z.string().regex(/^[a-z0-9_]{1,512}$/),
      language: z.string().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/),
      parameters: z.array(template(1_000)).max(20).default([]),
    }),
    run: (ctx, config) =>
      sendMessage(ctx, config.connectionId, {
        template: {
          name: config.templateName,
          language: config.language,
          parameters: config.parameters.map((value) => renderTemplate(value, ctx.context, 1_000)),
        },
      }),
  }),
  'http.request': define({
    requires: null,
    external: true,
    schema: z.object({
      url: z.string().trim().min(1).max(2_000),
      includeContact: z.boolean().default(true),
    }),
    runExternal: async (ctx, config) => {
      const result = await postJson(
        config.url,
        {
          workflowId: ctx.run.workflowId,
          runId: ctx.run.id,
          trigger: { type: ctx.run.triggerType, data: ctx.run.triggerData },
          contact: config.includeContact ? ctx.context.contact : undefined,
          deal: ctx.context.deal,
        },
        {
          allowPrivateNetwork: ctx.allowPrivateNetwork,
          ownHosts: ctx.ownHosts,
          headers: {
            // Receivers deduplicate retries with this key.
            'idempotency-key': `${ctx.run.id}:${ctx.nodeKey}`,
            'x-businessos-workflow-id': ctx.run.workflowId,
            'x-businessos-run-id': ctx.run.id,
          },
        },
      );
      return { output: { status: result.status } };
    },
  }),
} as const;

export type ActionType = keyof typeof ACTIONS;
export const ACTION_TYPES = Object.keys(ACTIONS) as ActionType[];

export function isActionType(value: string): value is ActionType {
  return Object.hasOwn(ACTIONS, value);
}
