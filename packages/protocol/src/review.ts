import { z } from 'zod';

import {
  blockIdSchema,
  changeGroupIdSchema,
  changeIdSchema,
  changeSetIdSchema,
  operationIdSchema,
  protocolVersionSchema,
  revisionSchema,
  timestampSchema,
} from './base.js';
import { actorReferenceSchema } from './auth.js';

export const changeKindSchema = z.enum(['insert', 'delete', 'replace', 'format', 'table']);

export const changeStatusSchema = z.enum([
  'proposed',
  'pending',
  'grouped',
  'accepted',
  'rejected',
  'resolved',
]);

export const changeResolutionSchema = z
  .object({
    outcome: z.enum(['accepted', 'rejected']),
    operationId: operationIdSchema,
    resolvedBy: actorReferenceSchema,
    resolvedAt: timestampSchema,
    beforeRevision: revisionSchema,
    afterRevision: revisionSchema,
  })
  .strict();

export const changeMetadataSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    changeId: changeIdSchema,
    changeSetId: changeSetIdSchema,
    kind: changeKindSchema,
    status: changeStatusSchema,
    author: actorReferenceSchema,
    createdAt: timestampSchema,
    proposedAt: timestampSchema.optional(),
    pendingAt: timestampSchema.optional(),
    groupId: changeGroupIdSchema.optional(),
    memberChangeIds: z.array(changeIdSchema).min(1).readonly().optional(),
    affectedBlockIds: z.array(blockIdSchema).min(1).readonly(),
    resolution: changeResolutionSchema.optional(),
  })
  .strict()
  .superRefine((change, context) => {
    if (
      change.status === 'grouped' &&
      change.groupId === undefined &&
      change.memberChangeIds === undefined
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Grouped changes require a group or group members',
        path: ['groupId'],
      });
    }

    if (
      (change.status === 'proposed' ||
        change.status === 'pending' ||
        change.status === 'grouped') &&
      change.resolution !== undefined
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Unresolved changes cannot include resolution metadata',
        path: ['resolution'],
      });
    }

    if (
      (change.status === 'accepted' ||
        change.status === 'rejected' ||
        change.status === 'resolved') &&
      change.resolution === undefined
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Resolved change states require resolution metadata',
        path: ['resolution'],
      });
    }

    if (change.status === 'accepted' && change.resolution?.outcome !== 'accepted') {
      context.addIssue({
        code: 'custom',
        message: 'Accepted changes require an accepted resolution',
        path: ['resolution', 'outcome'],
      });
    }

    if (change.status === 'rejected' && change.resolution?.outcome !== 'rejected') {
      context.addIssue({
        code: 'custom',
        message: 'Rejected changes require a rejected resolution',
        path: ['resolution', 'outcome'],
      });
    }

    if (new Set(change.affectedBlockIds).size !== change.affectedBlockIds.length) {
      context.addIssue({
        code: 'custom',
        message: 'Affected block IDs must be unique',
        path: ['affectedBlockIds'],
      });
    }

    if (
      change.memberChangeIds !== undefined &&
      new Set(change.memberChangeIds).size !== change.memberChangeIds.length
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Grouped member change IDs must be unique',
        path: ['memberChangeIds'],
      });
    }
  });

export const changeSetMetadataSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    changeSetId: changeSetIdSchema,
    author: actorReferenceSchema,
    changeIds: z.array(changeIdSchema).min(1).readonly(),
    createdAt: timestampSchema,
  })
  .strict()
  .refine(({ changeIds }) => new Set(changeIds).size === changeIds.length, {
    message: 'Change set member IDs must be unique',
    path: ['changeIds'],
  });

export type ChangeKind = z.infer<typeof changeKindSchema>;
export type ChangeStatus = z.infer<typeof changeStatusSchema>;
export type ChangeResolution = z.infer<typeof changeResolutionSchema>;
export type ChangeMetadata = z.infer<typeof changeMetadataSchema>;
export type ChangeSetMetadata = z.infer<typeof changeSetMetadataSchema>;
