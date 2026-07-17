import { z } from 'zod';

import { opaqueIdSchema, protocolVersionSchema, revisionSchema, timestampSchema } from './base.js';

export const durableAcknowledgementLevelSchema = z.enum([
  'none',
  'idempotency',
  'document',
  'document_and_audit',
]);

const expectedDurabilityByLevel = {
  none: {
    idempotencyReceiptDurable: false,
    documentStateDurable: false,
    auditDurableOrQueued: false,
  },
  idempotency: {
    idempotencyReceiptDurable: true,
    documentStateDurable: false,
    auditDurableOrQueued: false,
  },
  document: {
    idempotencyReceiptDurable: true,
    documentStateDurable: true,
    auditDurableOrQueued: false,
  },
  document_and_audit: {
    idempotencyReceiptDurable: true,
    documentStateDurable: true,
    auditDurableOrQueued: true,
  },
} as const;

export const persistenceAcknowledgementSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    level: durableAcknowledgementLevelSchema,
    idempotencyReceiptDurable: z.boolean(),
    documentStateDurable: z.boolean(),
    auditDurableOrQueued: z.boolean(),
    acknowledgedAt: timestampSchema,
    persistenceRevision: revisionSchema.optional(),
    receiptReference: opaqueIdSchema.optional(),
  })
  .strict()
  .superRefine((acknowledgement, context) => {
    const expected = expectedDurabilityByLevel[acknowledgement.level];

    for (const field of [
      'idempotencyReceiptDurable',
      'documentStateDurable',
      'auditDurableOrQueued',
    ] as const) {
      if (acknowledgement[field] !== expected[field]) {
        context.addIssue({
          code: 'custom',
          message: `${field} is inconsistent with acknowledgement level`,
          path: [field],
        });
      }
    }

    if (acknowledgement.documentStateDurable && acknowledgement.persistenceRevision === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Durable document state requires a persistence revision',
        path: ['persistenceRevision'],
      });
    }
  });

export type DurableAcknowledgementLevel = z.infer<typeof durableAcknowledgementLevelSchema>;
export type PersistenceAcknowledgement = z.infer<typeof persistenceAcknowledgementSchema>;
