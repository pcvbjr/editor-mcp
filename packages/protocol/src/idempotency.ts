import { z } from 'zod';

import {
  blockIdSchema,
  changeIdSchema,
  changeSetIdSchema,
  digestSchema,
  documentIdSchema,
  documentIncarnationSchema,
  idempotencyKeySchema,
  opaqueIdSchema,
  principalIdSchema,
  protocolVersionSchema,
  revisionSchema,
  tenantIdSchema,
  timestampSchema,
} from './base.js';
import { publicErrorSchema } from './errors.js';
import { applyEditsResultSchema, applyEditsStatusSchema } from './results.js';

export const idempotencyScopeSchema = z
  .object({
    tenantId: tenantIdSchema,
    principalId: principalIdSchema,
    documentId: documentIdSchema,
    documentIncarnation: documentIncarnationSchema,
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();

export const idempotencyReceiptSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    receiptId: opaqueIdSchema,
    scope: idempotencyScopeSchema,
    requestHash: digestSchema,
    beforeRevision: revisionSchema,
    afterRevision: revisionSchema.optional(),
    generatedBlockIds: z.array(blockIdSchema).readonly(),
    generatedChangeIds: z.array(changeIdSchema).readonly(),
    changeSetId: changeSetIdSchema.optional(),
    finalOutcome: applyEditsStatusSchema,
    result: applyEditsResultSchema,
    createdAt: timestampSchema,
    finalizedAt: timestampSchema,
  })
  .strict()
  .superRefine((receipt, context) => {
    if (
      receipt.scope.tenantId !== receipt.result.tenantId ||
      receipt.scope.documentId !== receipt.result.documentId ||
      receipt.scope.documentIncarnation !== receipt.result.documentIncarnation
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Receipt scope must match its stored result',
        path: ['scope'],
      });
    }

    if (receipt.finalOutcome !== receipt.result.status) {
      context.addIssue({
        code: 'custom',
        message: 'Receipt outcome must match its stored result',
        path: ['finalOutcome'],
      });
    }

    if (
      (receipt.finalOutcome === 'applied' || receipt.finalOutcome === 'duplicate') &&
      receipt.afterRevision === undefined
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Successful receipts require an after revision',
        path: ['afterRevision'],
      });
    }
  });

const idempotencyReplayBaseShape = {
  protocolVersion: protocolVersionSchema,
  scope: idempotencyScopeSchema,
};

export const idempotencyReplayDecisionSchema = z.discriminatedUnion('disposition', [
  z
    .object({
      ...idempotencyReplayBaseShape,
      disposition: z.literal('execute'),
      reservationId: opaqueIdSchema,
    })
    .strict(),
  z
    .object({
      ...idempotencyReplayBaseShape,
      disposition: z.literal('replay'),
      receipt: idempotencyReceiptSchema,
    })
    .strict(),
  z
    .object({
      ...idempotencyReplayBaseShape,
      disposition: z.literal('mismatch'),
      existingRequestHash: digestSchema,
      incomingRequestHash: digestSchema,
      error: publicErrorSchema.refine(
        ({ code }) => code === 'IDEMPOTENCY_MISMATCH',
        'A mismatch decision requires IDEMPOTENCY_MISMATCH',
      ),
    })
    .strict()
    .refine(
      ({ existingRequestHash, incomingRequestHash }) => existingRequestHash !== incomingRequestHash,
      {
        message: 'Mismatched requests must have different request hashes',
        path: ['incomingRequestHash'],
      },
    ),
  z
    .object({
      ...idempotencyReplayBaseShape,
      disposition: z.literal('in_progress'),
      reservationId: opaqueIdSchema,
      retryAfterMs: z.number().int().positive().max(300_000),
    })
    .strict(),
]);

export const idempotencyDecisionSchema = idempotencyReplayDecisionSchema;

export type IdempotencyScope = z.infer<typeof idempotencyScopeSchema>;
export type IdempotencyReceipt = z.infer<typeof idempotencyReceiptSchema>;
export type IdempotencyReplayDecision = z.infer<typeof idempotencyReplayDecisionSchema>;
export type IdempotencyDecision = IdempotencyReplayDecision;
