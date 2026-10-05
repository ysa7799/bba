import type { ActivityProjector, ProjectorMap } from '@businessos/activities';
import { forms } from '@businessos/database';
import type { EventPayload } from '@businessos/events';
import { and, eq } from 'drizzle-orm';

const submitted: ActivityProjector = async (tx, event) => {
  const payload = event.payload as EventPayload<'form.submitted'>;
  if (!payload.contactId) return null;
  const [form] = await tx
    .select({ name: forms.name })
    .from(forms)
    .where(and(eq(forms.id, payload.formId), eq(forms.organizationId, event.organizationId ?? '')));
  const formName = form?.name ?? 'a form';
  return {
    type: 'form.submitted',
    subject: { type: 'form_submission', id: payload.submissionId },
    contactId: payload.contactId,
    dealId: payload.dealId,
    summary: `Submitted ${formName}`,
    metadata: { formId: payload.formId, formName, submissionId: payload.submissionId },
  };
};

/** Form submissions on the contact (and deal) timeline (visible with `forms.submission.read`). */
export const formsTimelineProjectors: ProjectorMap = {
  'form.submitted': submitted,
};
