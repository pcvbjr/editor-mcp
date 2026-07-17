import { z } from 'zod';

import {
  adapterVersionSchema,
  blockIdSchema,
  changeIdSchema,
  changeSetIdSchema,
  digestSchema,
  operationIdSchema,
  operationKindSchema,
  opaqueIdSchema,
  policyVersionSchema,
  protocolVersionSchema,
  revisionSchema,
  timestampSchema,
  traceIdSchema,
} from './base.js';
import { actorReferenceSchema } from './auth.js';
import { domainErrorCodeSchema } from './errors.js';
import { documentIdentitySchema } from './identity.js';
import { persistenceAcknowledgementSchema } from './persistence.js';
import { applyEditsStatusSchema } from './results.js';

export const auditTargetPreconditionSchema = z
  .object({
    operationId: operationIdSchema,
    operationKind: operationKindSchema,
    targetType: z.enum(['block', 'table', 'change', 'document']),
    targetReference: opaqueIdSchema,
    expectedDigest: digestSchema.optional(),
  })
  .strict();

export const auditAuthorizationDecisionSchema = z
  .object({
    decisionId: opaqueIdSchema,
    policyVersion: policyVersionSchema,
    effect: z.enum(['allow', 'deny']),
    reasonCode: z.string().trim().min(1).max(128),
  })
  .strict();

export const auditOutcomeSchema = z
  .object({
    status: applyEditsStatusSchema,
    errorCode: domainErrorCodeSchema.optional(),
  })
  .strict()
  .superRefine((outcome, context) => {
    if (outcome.status === 'failed' && outcome.errorCode === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Failed audit outcomes require an error code',
        path: ['errorCode'],
      });
    }

    if (outcome.status !== 'failed' && outcome.errorCode !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Only failed audit outcomes can include an error code',
        path: ['errorCode'],
      });
    }
  });

export const auditEventSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    auditEventId: opaqueIdSchema,
    eventType: z.literal('document.edit'),
    document: documentIdentitySchema,
    actor: actorReferenceSchema,
    operationIds: z.array(operationIdSchema).min(1).max(100).readonly(),
    changeSetId: changeSetIdSchema.optional(),
    requestHash: digestSchema,
    idempotencyKeyHash: digestSchema,
    adapterVersion: adapterVersionSchema,
    targetPreconditions: z.array(auditTargetPreconditionSchema).max(100).readonly(),
    beforeRevision: revisionSchema,
    afterRevision: revisionSchema.optional(),
    beforeHash: digestSchema,
    afterHash: digestSchema.optional(),
    generatedBlockIds: z.array(blockIdSchema).readonly(),
    generatedChangeIds: z.array(changeIdSchema).readonly(),
    authorizationDecision: auditAuthorizationDecisionSchema,
    outcome: auditOutcomeSchema,
    acknowledgement: persistenceAcknowledgementSchema,
    traceId: traceIdSchema,
    serverTimestamp: timestampSchema,
  })
  .strict()
  .superRefine((event, context) => {
    if (new Set(event.operationIds).size !== event.operationIds.length) {
      context.addIssue({
        code: 'custom',
        message: 'Audited operation IDs must be unique',
        path: ['operationIds'],
      });
    }

    if (
      (event.outcome.status === 'applied' || event.outcome.status === 'duplicate') &&
      (event.afterRevision === undefined || event.afterHash === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Successful audit events require after-state references',
        path: ['afterRevision'],
      });
    }
  });

export type AuditTargetPrecondition = z.infer<typeof auditTargetPreconditionSchema>;
export type AuditAuthorizationDecision = z.infer<typeof auditAuthorizationDecisionSchema>;
export type AuditOutcome = z.infer<typeof auditOutcomeSchema>;
export type AuditEvent = z.infer<typeof auditEventSchema>;
