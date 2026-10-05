/**
 * Standard application errors. Every error that crosses an HTTP or job boundary should be one
 * of these; anything else is treated as an unexpected internal error and never exposed.
 */

export type ErrorCode =
  | 'bad_request'
  | 'validation_error'
  | 'unauthenticated'
  | 'email_not_verified'
  | 'invalid_token'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'unprocessable'
  | 'payload_too_large'
  | 'rate_limited'
  | 'entitlement_exceeded'
  | 'provider_error'
  | 'internal_error';

export interface ErrorDetail {
  path: string;
  message: string;
}

export abstract class AppError extends Error {
  abstract readonly code: ErrorCode;
  abstract readonly status: number;
  /** Safe, client-facing details (validation issues etc.). Never put secrets here. */
  readonly details: readonly ErrorDetail[] | undefined;

  constructor(message: string, options?: { details?: readonly ErrorDetail[]; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.details = options?.details;
  }
}

export class BadRequestError extends AppError {
  readonly code = 'bad_request';
  readonly status = 400;
}

export class ValidationError extends AppError {
  readonly code = 'validation_error';
  readonly status = 400;

  constructor(message = 'Invalid input', details: readonly ErrorDetail[] = []) {
    super(message, { details });
  }
}

export class UnauthenticatedError extends AppError {
  readonly code = 'unauthenticated';
  readonly status = 401;

  constructor(message = 'Authentication required') {
    super(message);
  }
}

/** Correct credentials, but the account's email address has not been verified yet. */
export class EmailNotVerifiedError extends AppError {
  readonly code = 'email_not_verified';
  readonly status = 403;

  constructor(message = 'Please verify your email address before signing in') {
    super(message);
  }
}

/** A single-use token (verification, reset, invitation) that is unknown, used or expired. */
export class InvalidTokenError extends AppError {
  readonly code = 'invalid_token';
  readonly status = 400;

  constructor(message = 'This link is invalid or has expired') {
    super(message);
  }
}

export class ForbiddenError extends AppError {
  readonly code = 'forbidden';
  readonly status = 403;

  constructor(message = 'You do not have permission to perform this action') {
    super(message);
  }
}

/**
 * Used both for genuinely missing resources and for resources that exist in another tenant,
 * so that IDs cannot be probed across organizations.
 */
export class NotFoundError extends AppError {
  readonly code = 'not_found';
  readonly status = 404;

  constructor(resource = 'Resource') {
    super(`${resource} not found`);
  }
}

export class ConflictError extends AppError {
  readonly code = 'conflict';
  readonly status = 409;
}

export class UnprocessableError extends AppError {
  readonly code = 'unprocessable';
  readonly status = 422;
}

export class PayloadTooLargeError extends AppError {
  readonly code = 'payload_too_large';
  readonly status = 413;
}

export class RateLimitedError extends AppError {
  readonly code = 'rate_limited';
  readonly status = 429;
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number, message = 'Too many requests') {
    super(message);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class EntitlementExceededError extends AppError {
  readonly code = 'entitlement_exceeded';
  readonly status = 402;
  readonly entitlementKey: string;

  constructor(entitlementKey: string, message?: string) {
    super(message ?? `Your plan does not allow this (${entitlementKey})`);
    this.entitlementKey = entitlementKey;
  }
}

export class ProviderError extends AppError {
  readonly code = 'provider_error';
  readonly status = 502;
  readonly provider: string;
  readonly retryable: boolean;

  constructor(
    provider: string,
    message: string,
    options?: { retryable?: boolean; cause?: unknown },
  ) {
    super(message, { cause: options?.cause });
    this.provider = provider;
    this.retryable = options?.retryable ?? false;
  }
}

export class InternalError extends AppError {
  readonly code = 'internal_error';
  readonly status = 500;
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/** Throws an InternalError when an invariant does not hold. */
export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new InternalError(`Invariant violated: ${message}`);
  }
}
