import { UnrecoverableError } from '@businessos/jobs';

export interface RenderedEmail {
  subject: string;
  text: string;
}

type Data = Record<string, string | null>;

function required(data: Data, key: string): string {
  const value = data[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new UnrecoverableError(`Email template data is missing "${key}"`);
  }
  return value;
}

/**
 * Plain-text transactional templates (English). Branded HTML and localized catalogues arrive
 * with the notification system; templates are referenced by name so they can be swapped.
 */
const TEMPLATES: Record<string, (data: Data) => RenderedEmail> = {
  verify_email: (data) => ({
    subject: 'Verify your email address',
    text: `Hi ${required(data, 'name')},\n\nConfirm your email address to finish setting up your account:\n${required(data, 'link')}\n\nThe link expires in 24 hours. If you did not sign up, ignore this email.`,
  }),
  account_exists: (data) => ({
    subject: 'You already have an account',
    text: `Hi ${required(data, 'name')},\n\nSomeone tried to create an account with this email address, but you already have one. If it was you, you can reset your password here:\n${required(data, 'forgotPasswordLink')}\n\nIf it was not you, no action is needed.`,
  }),
  password_reset: (data) => ({
    subject: 'Reset your password',
    text: `Hi ${required(data, 'name')},\n\nUse this link to choose a new password:\n${required(data, 'link')}\n\nThe link expires in 1 hour. If you did not request it, ignore this email.`,
  }),
  password_changed: (data) => ({
    subject: 'Your password was changed',
    text: `Hi ${required(data, 'name')},\n\nYour password was just changed and other sessions were signed out. If this was not you, reset your password immediately.`,
  }),
  invitation: (data) => ({
    subject: `You are invited to ${required(data, 'organizationName')}`,
    text: `${data.inviterName ?? 'Someone'} invited you to join ${required(data, 'organizationName')}.\n\nAccept the invitation:\n${required(data, 'link')}\n\nThe invitation expires in 7 days.`,
  }),
  appointment_confirmed: (data) => ({
    subject: `Confirmed: ${required(data, 'title')} with ${required(data, 'organization')}`,
    text: `${greeting(data)}Your appointment is booked.\n\n${appointmentDetails(data)}${manageLine(data, 'Need to change it? Reschedule or cancel here')}`,
  }),
  appointment_rescheduled: (data) => ({
    subject: `Updated: ${required(data, 'title')} with ${required(data, 'organization')}`,
    text: `${greeting(data)}Your appointment has a new time.\n\n${appointmentDetails(data)}${manageLine(data, 'Manage your booking')}`,
  }),
  appointment_cancelled: (data) => ({
    subject: `Cancelled: ${required(data, 'title')} with ${required(data, 'organization')}`,
    text: `${greeting(data)}Your appointment was cancelled.\n\n${appointmentDetails(data)}`,
  }),
  appointment_reminder: (data) => ({
    subject: `Reminder: ${required(data, 'title')} with ${required(data, 'organization')}`,
    text: `${greeting(data)}This is a reminder of your upcoming appointment.\n\n${appointmentDetails(data)}${manageLine(data, 'Need to change it? Reschedule or cancel here')}`,
  }),
};

function greeting(data: Data): string {
  return data.name ? `Hi ${data.name},\n\n` : 'Hello,\n\n';
}

function appointmentDetails(data: Data): string {
  return `${required(data, 'title')} — ${required(data, 'organization')}\nWhen: ${required(data, 'when')}\nWhere: ${required(data, 'location')}\n`;
}

function manageLine(data: Data, label: string): string {
  return data.manageUrl ? `\n${label}:\n${data.manageUrl}\n` : '';
}

export function renderEmail(template: string, data: Data): RenderedEmail {
  const render = TEMPLATES[template];
  if (!render) throw new UnrecoverableError(`Unknown email template: ${template}`);
  return render(data);
}
