import { z } from 'zod';

const editorErrorCodes = [
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

export const editorErrorCodeSchema = z.enum(editorErrorCodes);

export const editorErrorEnvelopeSchema = z
  .object({
    errorVersion: z.literal(1),
    code: editorErrorCodeSchema,
    message: z.string().trim().min(1).max(1_000),
    retryable: z.boolean(),
    correlationId: z.string().trim().min(1).max(256).optional(),
  })
  .strict();

export type EditorErrorCode = z.infer<typeof editorErrorCodeSchema>;
export type EditorErrorEnvelope = z.infer<typeof editorErrorEnvelopeSchema>;
