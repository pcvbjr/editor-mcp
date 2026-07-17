import { z } from 'zod';

import {
  collaborationFieldSchema,
  documentIdSchema,
  documentIncarnationSchema,
  schemaIdSchema,
  schemaVersionSchema,
  tenantIdSchema,
} from './base.js';

export const documentIdentitySchema = z
  .object({
    tenantId: tenantIdSchema,
    documentId: documentIdSchema,
    documentIncarnation: documentIncarnationSchema,
    collaborationField: collaborationFieldSchema,
    schemaId: schemaIdSchema,
    schemaVersion: schemaVersionSchema,
  })
  .strict();

export type DocumentIdentity = z.infer<typeof documentIdentitySchema>;
