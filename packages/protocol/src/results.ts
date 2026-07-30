import { z } from 'zod';

import {
  blockIdSchema,
  changeIdSchema,
  changeSetIdSchema,
  operationIdSchema,
  protocolVersionSchema,
  revisionSchema,
} from './base.js';
import { editConflictSchema, publicErrorSchema } from './errors.js';
import { documentIdentitySchema } from './identity.js';
import { persistenceAcknowledgementSchema } from './persistence.js';

export const applyEditsStatusSchema = z.enum(['applied', 'conflict', 'duplicate', 'failed']);

export const operationResultSchema = z
  .object({
    operationId: operationIdSchema,
    status: z.enum(['applied', 'conflict', 'replayed', 'failed']),
    affectedBlockIds: z.array(blockIdSchema).readonly(),
    createdBlockIds: z.array(blockIdSchema).readonly(),
    generatedChangeIds: z.array(changeIdSchema).readonly(),
    conflict: editConflictSchema.optional(),
    error: publicErrorSchema.optional(),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.status === 'conflict' && result.conflict === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Conflicted operations require conflict metadata',
        path: ['conflict'],
      });
    }
    if (result.status === 'conflict' && result.error !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Conflicted operations cannot include a public error',
        path: ['error'],
      });
    }

    if (result.status === 'failed' && result.error === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Failed operations require a public error',
        path: ['error'],
      });
    }
    if (result.status === 'failed' && result.conflict !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Failed operations cannot include conflict metadata',
        path: ['conflict'],
      });
    }

    if (result.status === 'applied' || result.status === 'replayed') {
      if (result.conflict !== undefined || result.error !== undefined) {
        context.addIssue({
          code: 'custom',
          message: 'Successful operations cannot include errors or conflicts',
        });
      }
    }
  });

export const applyEditsResultSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    ...documentIdentitySchema.shape,
    status: applyEditsStatusSchema,
    beforeRevision: revisionSchema,
    committedRevision: revisionSchema.optional(),
    changeSetId: changeSetIdSchema.optional(),
    idempotentReplay: z.boolean(),
    createdBlockIds: z.array(blockIdSchema).readonly(),
    affectedBlockIds: z.array(blockIdSchema).readonly(),
    generatedChangeIds: z.array(changeIdSchema).readonly(),
    operationResults: z.array(operationResultSchema).min(1).max(100).readonly(),
    conflicts: z.array(editConflictSchema).max(100).readonly(),
    acknowledgement: persistenceAcknowledgementSchema,
    error: publicErrorSchema.optional(),
  })
  .strict()
  .superRefine((result, context) => {
    const successful = result.status === 'applied' || result.status === 'duplicate';

    if (successful && result.committedRevision === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Successful edit results require a committed revision',
        path: ['committedRevision'],
      });
    }

    if (successful && result.acknowledgement.level !== 'document_and_audit') {
      context.addIssue({
        code: 'custom',
        message: 'Successful edit results require durable document and audit acknowledgement',
        path: ['acknowledgement', 'level'],
      });
    }

    if (result.status === 'conflict' && result.conflicts.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'Conflict results require at least one conflict',
        path: ['conflicts'],
      });
    }

    if (result.status === 'failed' && result.error === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Failed edit results require a public error',
        path: ['error'],
      });
    }

    if (result.status !== 'failed' && result.error !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Only failed edit results can include a top-level error',
        path: ['error'],
      });
    }

    if (result.status === 'duplicate' && !result.idempotentReplay) {
      context.addIssue({
        code: 'custom',
        message: 'Duplicate results must be marked as idempotent replays',
        path: ['idempotentReplay'],
      });
    }
    if (result.status === 'applied' && result.idempotentReplay) {
      context.addIssue({
        code: 'custom',
        message: 'Applied results cannot be marked as idempotent replays',
        path: ['idempotentReplay'],
      });
    }

    if (
      result.status === 'applied' &&
      (result.conflicts.length > 0 ||
        result.operationResults.some(({ status }) => status !== 'applied'))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Applied results require only applied operation outcomes and no conflicts',
        path: ['operationResults'],
      });
    }

    if (
      result.status === 'duplicate' &&
      (result.conflicts.length > 0 ||
        result.operationResults.some(({ status }) => status !== 'replayed'))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Duplicate results require only replayed operation outcomes and no conflicts',
        path: ['operationResults'],
      });
    }

    if (
      result.status === 'conflict' &&
      !result.operationResults.some(({ status }) => status === 'conflict')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Conflict results require at least one conflicted operation outcome',
        path: ['operationResults'],
      });
    }

    if (
      (result.status === 'conflict' || result.status === 'failed') &&
      result.committedRevision !== undefined
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Uncommitted results cannot include a committed revision',
        path: ['committedRevision'],
      });
    }

    const uniqueArrays = [
      ['createdBlockIds', result.createdBlockIds],
      ['affectedBlockIds', result.affectedBlockIds],
      ['generatedChangeIds', result.generatedChangeIds],
      ['operationResults', result.operationResults.map(({ operationId }) => operationId)],
    ] as const;

    for (const [field, values] of uniqueArrays) {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: 'custom',
          message: `${field} entries must be unique`,
          path: [field],
        });
      }
    }
  });

export type ApplyEditsStatus = z.infer<typeof applyEditsStatusSchema>;
export type OperationResult = z.infer<typeof operationResultSchema>;
export type ApplyEditsResult = z.infer<typeof applyEditsResultSchema>;
