import {
  isAppError,
  RateLimitedError,
  ValidationError,
  type ErrorCode,
  type ErrorDetail,
} from '@businessos/shared';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { zodIssuesToDetails } from '../lib/validation';

export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    details?: readonly ErrorDetail[];
    requestId: string;
  };
}

function send(
  reply: FastifyReply,
  request: FastifyRequest,
  status: number,
  code: ErrorCode,
  message: string,
  details?: readonly ErrorDetail[],
): FastifyReply {
  const body: ErrorEnvelope = {
    error: {
      code,
      message,
      ...(details && details.length > 0 ? { details } : {}),
      requestId: request.id,
    },
  };
  return reply.status(status).type('application/json').send(body);
}

/** Maps framework (non-AppError) client errors to safe, generic messages. */
function frameworkClientError(statusCode: number): { code: ErrorCode; message: string } {
  switch (statusCode) {
    case 413:
      return { code: 'payload_too_large', message: 'Request body is too large' };
    case 415:
      return { code: 'bad_request', message: 'Unsupported media type' };
    case 404:
      return { code: 'not_found', message: 'Route not found' };
    case 429:
      return { code: 'rate_limited', message: 'Too many requests' };
    default:
      return { code: 'bad_request', message: 'Malformed request' };
  }
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    return send(reply, request, 404, 'not_found', 'Route not found');
  });

  app.setErrorHandler((rawError: unknown, request, reply) => {
    const error =
      rawError instanceof ZodError
        ? new ValidationError('Invalid input', zodIssuesToDetails(rawError.issues))
        : rawError;

    if (isAppError(error)) {
      if (error.status >= 500) {
        request.log.error({ err: error }, 'request failed');
      } else {
        request.log.info({ code: error.code, status: error.status }, 'request rejected');
      }
      if (error instanceof RateLimitedError) {
        void reply.header('retry-after', String(error.retryAfterSeconds));
      }
      // Internal errors never expose their message.
      const message =
        error.status >= 500 && error.code === 'internal_error'
          ? 'An unexpected error occurred'
          : error.message;
      return send(reply, request, error.status, error.code, message, error.details);
    }

    const fastifyError = error as Partial<FastifyError>;
    const statusCode = fastifyError.statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      request.log.info({ code: fastifyError.code, statusCode }, 'request rejected by framework');
      const mapped = frameworkClientError(statusCode);
      return send(reply, request, statusCode, mapped.code, mapped.message);
    }

    request.log.error({ err: error }, 'unhandled error');
    return send(reply, request, 500, 'internal_error', 'An unexpected error occurred');
  });
}
