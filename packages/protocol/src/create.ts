import { z } from 'zod';

import {
  collaborationFieldSchema,
  idempotencyKeySchema,
  protocolVersionSchema,
  revisionSchema,
  schemaIdSchema,
  schemaVersionSchema,
  tenantIdSchema,
  timestampSchema,
} from './base.js';
import { documentIdentitySchema } from './identity.js';

export const createDocumentRequestV1Schema = z
  .object({
    protocolVersion: protocolVersionSchema,
    tenantId: tenantIdSchema,
    collaborationField: collaborationFieldSchema.default('default'),
    schemaId: schemaIdSchema,
    schemaVersion: schemaVersionSchema,
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();

export const createDocumentResultV1Schema = z
  .object({
    protocolVersion: protocolVersionSchema,
    ...documentIdentitySchema.shape,
    status: z.enum(['created', 'existing']),
    idempotentReplay: z.boolean(),
    revision: revisionSchema,
    editorUrl: z.url(),
    acknowledgement: z
      .object({
        level: z.literal('snapshot'),
        sequence: z.number().int().positive(),
        storedAt: timestampSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.status === 'created' && result.idempotentReplay) {
      context.addIssue({
        code: 'custom',
        message: 'A newly created document cannot be an idempotent replay',
        path: ['idempotentReplay'],
      });
    }
    if (result.status === 'existing' && !result.idempotentReplay) {
      context.addIssue({
        code: 'custom',
        message: 'An existing document must be an idempotent replay',
        path: ['idempotentReplay'],
      });
    }
  });

export type CreateDocumentRequestV1 = z.infer<typeof createDocumentRequestV1Schema>;
export type CreateDocumentResultV1 = z.infer<typeof createDocumentResultV1Schema>;
