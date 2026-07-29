import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { z } from 'zod';

const principalSchema = z.discriminatedUnion('actorKind', [
  z.object({
    actorKind: z.literal('user'),
    issuer: z.url(),
    subject: z.string().startsWith('user_'),
    organizationExternalId: z.string().startsWith('org_').optional(),
    oauthClientId: z.string().min(1),
  }),
  z.object({
    actorKind: z.literal('service'),
    issuer: z.url(),
    subject: z.string().startsWith('client_'),
    organizationExternalId: z.string().startsWith('org_'),
    oauthClientId: z.string().min(1),
  }),
]);

export type AuthenticatedMcpPrincipal = z.infer<typeof principalSchema>;

export function authenticatedMcpPrincipalFromAuthInfo(
  authInfo: AuthInfo | undefined,
): AuthenticatedMcpPrincipal {
  return principalSchema.parse(authInfo?.extra?.['principal']);
}
