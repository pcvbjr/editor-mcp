import { z } from 'zod';

import {
  blockIdSchema,
  changeIdSchema,
  digestSchema,
  operationIdSchema,
  opaqueIdSchema,
  protocolVersionSchema,
  revisionSchema,
  traceIdSchema,
} from './base.js';

export const DOMAIN_ERROR_CODES = [
  'INVALID_REQUEST',
  'UNAUTHENTICATED',
  'PERMISSION_DENIED',
  'DOCUMENT_NOT_FOUND',
  'DOCUMENT_INCARNATION_MISMATCH',
  'SCHEMA_VERSION_MISMATCH',
  'TARGET_NOT_FOUND',
  'TARGET_AMBIGUOUS',
  'TARGET_CHANGED',
  'INVALID_CONTENT',
  'UNSUPPORTED_CONTENT',
  'PATCH_TOO_LARGE',
  'IDEMPOTENCY_MISMATCH',
  'DOCUMENT_UNAVAILABLE',
  'DEADLINE_EXCEEDED',
  'INTERNAL',
] as const;

export const domainErrorCodeSchema = z.enum(DOMAIN_ERROR_CODES);

export const conflictTargetSchema = z
  .object({
    targetType: z.enum(['block', 'table', 'change', 'document']),
    targetId: opaqueIdSchema,
    expectedDigest: digestSchema.optional(),
    currentDigest: digestSchema.optional(),
    currentBlockId: blockIdSchema.optional(),
    currentChangeId: changeIdSchema.optional(),
  })
  .strict();

export const conflictRecoverySchema = z
  .object({
    action: z.enum([
      'reread_target',
      'reread_document',
      'retry_same_key',
      'retry_new_key',
      'do_not_retry',
    ]),
    currentRevision: revisionSchema.optional(),
    retryAfterMs: z.number().int().nonnegative().max(300_000).optional(),
  })
  .strict();

export const editConflictSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    code: z.enum([
      'DOCUMENT_INCARNATION_MISMATCH',
      'SCHEMA_VERSION_MISMATCH',
      'TARGET_NOT_FOUND',
      'TARGET_AMBIGUOUS',
      'TARGET_CHANGED',
      'IDEMPOTENCY_MISMATCH',
    ]),
    operationId: operationIdSchema.optional(),
    target: conflictTargetSchema.optional(),
    message: z.string().trim().min(1).max(1_024),
    recovery: conflictRecoverySchema,
  })
  .strict();

export const publicErrorSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    code: domainErrorCodeSchema,
    message: z.string().trim().min(1).max(1_024),
    retryable: z.boolean(),
    traceId: traceIdSchema.optional(),
    errorId: opaqueIdSchema.optional(),
    recovery: conflictRecoverySchema.optional(),
  })
  .strict();

export type DomainErrorCode = z.infer<typeof domainErrorCodeSchema>;
export type ConflictTarget = z.infer<typeof conflictTargetSchema>;
export type ConflictRecovery = z.infer<typeof conflictRecoverySchema>;
export type EditConflict = z.infer<typeof editConflictSchema>;
export type PublicError = z.infer<typeof publicErrorSchema>;
