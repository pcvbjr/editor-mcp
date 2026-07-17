import { z } from 'zod';

import {
  changeModeSchema,
  collaborationFieldSchema,
  documentIdSchema,
  documentIncarnationSchema,
  idempotencyKeySchema,
  protocolVersionSchema,
  revisionSchema,
  schemaIdSchema,
  schemaVersionSchema,
  tenantIdSchema,
} from './base.js';
import { documentIdentitySchema } from './identity.js';
import { editOperationSchema } from './operations.js';

interface OperationContainer {
  operations: readonly { operationId: string }[];
}

const reportDuplicateOperationIds = (
  request: OperationContainer,
  context: z.RefinementCtx,
): void => {
  const operationIds = new Set<string>();

  for (const [index, operation] of request.operations.entries()) {
    if (operationIds.has(operation.operationId)) {
      context.addIssue({
        code: 'custom',
        message: 'Operation IDs must be unique within a batch',
        path: ['operations', index, 'operationId'],
      });
    }
    operationIds.add(operation.operationId);
  }
};

/**
 * Backward-compatible request schema from the initial package baseline.
 *
 * The optional identity/envelope fields let existing callers migrate without
 * changing the required legacy input. Production transport boundaries should
 * use {@link applyEditsRequestV1Schema}, where those fields are mandatory.
 */
export const applyEditsRequestSchema = z
  .object({
    protocolVersion: protocolVersionSchema.optional(),
    tenantId: tenantIdSchema.optional(),
    documentId: documentIdSchema,
    documentIncarnation: documentIncarnationSchema,
    collaborationField: collaborationFieldSchema.optional(),
    schemaId: schemaIdSchema,
    schemaVersion: schemaVersionSchema,
    idempotencyKey: idempotencyKeySchema,
    readRevision: revisionSchema.optional(),
    atomic: z.literal(true).optional(),
    changeMode: changeModeSchema.default('suggest'),
    operations: z.array(editOperationSchema).min(1).max(100),
  })
  .strict()
  .superRefine(reportDuplicateOperationIds);

export const applyEditsRequestV1Schema = z
  .object({
    protocolVersion: protocolVersionSchema,
    ...documentIdentitySchema.shape,
    idempotencyKey: idempotencyKeySchema,
    readRevision: revisionSchema,
    atomic: z.literal(true),
    changeMode: changeModeSchema,
    operations: z.array(editOperationSchema).min(1).max(100).readonly(),
  })
  .strict()
  .superRefine(reportDuplicateOperationIds);

export type ApplyEditsRequest = z.infer<typeof applyEditsRequestSchema>;
export type ApplyEditsRequestV1 = z.infer<typeof applyEditsRequestV1Schema>;
