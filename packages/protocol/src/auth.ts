import { z } from 'zod';

import {
  changeModeSchema,
  opaqueIdSchema,
  operationIdSchema,
  operationKindSchema,
  policyVersionSchema,
  principalIdSchema,
  protocolVersionSchema,
  tenantIdSchema,
  timestampSchema,
} from './base.js';
import { documentIdentitySchema } from './identity.js';

export const principalTypeSchema = z.enum([
  'human',
  'mcp_client',
  'agent',
  'service',
  'host_application',
]);

export const permissionSchema = z.enum([
  'documents:read',
  'documents:suggest',
  'documents:write',
  'suggestions:review',
  'comments:read',
  'comments:write',
]);

export const authenticationMethodSchema = z.enum([
  'local',
  'oauth_access_token',
  'service_credential',
  'host_assertion',
]);

export const actorReferenceSchema = z
  .object({
    principalId: principalIdSchema,
    principalType: principalTypeSchema,
    agentRunId: opaqueIdSchema.optional(),
  })
  .strict();

export const authorizationContextSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    tenantId: tenantIdSchema,
    actor: actorReferenceSchema,
    mcpClientId: opaqueIdSchema.optional(),
    authenticationMethod: authenticationMethodSchema,
    authenticatedAt: timestampSchema,
    grantedPermissions: z.array(permissionSchema).readonly(),
  })
  .strict()
  .superRefine((context, refinementContext) => {
    if (new Set(context.grantedPermissions).size !== context.grantedPermissions.length) {
      refinementContext.addIssue({
        code: 'custom',
        message: 'Granted permissions must be unique',
        path: ['grantedPermissions'],
      });
    }

    if (context.actor.principalType === 'agent' && context.actor.agentRunId === undefined) {
      refinementContext.addIssue({
        code: 'custom',
        message: 'Agent principals require an agent run ID',
        path: ['actor', 'agentRunId'],
      });
    }
  });

export const policyOperationSchema = z
  .object({
    operationId: operationIdSchema,
    kind: operationKindSchema,
  })
  .strict();

export const operationPolicyInputSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    authorization: authorizationContextSchema,
    document: documentIdentitySchema,
    changeMode: changeModeSchema,
    operations: z.array(policyOperationSchema).min(1).max(100).readonly(),
    ownsTargetSuggestions: z.boolean(),
  })
  .strict()
  .superRefine((input, refinementContext) => {
    if (input.authorization.actor.principalType === 'agent' && input.changeMode === 'direct') {
      refinementContext.addIssue({
        code: 'custom',
        message: 'Agent principals may only submit suggested edits',
        path: ['changeMode'],
      });
    }
  });

export const policyConstraintsSchema = z
  .object({
    allowedChangeModes: z.array(changeModeSchema).min(1).readonly(),
    allowedOperationKinds: z.array(operationKindSchema).min(1).readonly(),
    maximumOperations: z.number().int().positive().max(100),
    requireTargetDigests: z.boolean(),
    allowReviewOwnSuggestions: z.boolean(),
  })
  .strict();

export const policyDecisionSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    decisionId: opaqueIdSchema,
    policyVersion: policyVersionSchema,
    effect: z.enum(['allow', 'deny']),
    requiredPermissions: z.array(permissionSchema).min(1).readonly(),
    reasonCode: z.string().trim().min(1).max(128),
    constraints: policyConstraintsSchema.optional(),
    decidedAt: timestampSchema,
  })
  .strict()
  .superRefine((decision, context) => {
    if (decision.effect === 'allow' && decision.constraints === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Allowed policy decisions require constraints',
        path: ['constraints'],
      });
    }

    if (decision.effect === 'deny' && decision.constraints !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Denied policy decisions cannot grant constraints',
        path: ['constraints'],
      });
    }
  });

export type PrincipalType = z.infer<typeof principalTypeSchema>;
export type Permission = z.infer<typeof permissionSchema>;
export type AuthenticationMethod = z.infer<typeof authenticationMethodSchema>;
export type ActorReference = z.infer<typeof actorReferenceSchema>;
export type AuthorizationContext = z.infer<typeof authorizationContextSchema>;
export type PolicyOperation = z.infer<typeof policyOperationSchema>;
export type OperationPolicyInput = z.infer<typeof operationPolicyInputSchema>;
export type PolicyConstraints = z.infer<typeof policyConstraintsSchema>;
export type PolicyDecision = z.infer<typeof policyDecisionSchema>;

export type OperationPolicyHook = (
  input: OperationPolicyInput,
) => PolicyDecision | Promise<PolicyDecision>;
