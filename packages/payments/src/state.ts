import type { NormalizedPaymentStatus } from './types';

/**
 * Allowed transitions. Payment state only moves forward, so late or out-of-order notifications
 * (e.g. "pending" after "captured") can never regress a payment.
 */
const TRANSITIONS: Record<NormalizedPaymentStatus, readonly NormalizedPaymentStatus[]> = {
  pending: ['requires_action', 'authorized', 'captured', 'failed', 'canceled'],
  requires_action: ['authorized', 'captured', 'failed', 'canceled'],
  authorized: ['captured', 'failed', 'canceled'],
  captured: ['partially_refunded', 'refunded'],
  partially_refunded: ['partially_refunded', 'refunded'],
  failed: [],
  canceled: [],
  refunded: [],
};

export function canTransition(from: NormalizedPaymentStatus, to: NormalizedPaymentStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export function isTerminal(status: NormalizedPaymentStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

export function isPaid(status: NormalizedPaymentStatus): boolean {
  return status === 'captured' || status === 'partially_refunded' || status === 'refunded';
}
