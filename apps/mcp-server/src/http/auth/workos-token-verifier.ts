import { InvalidTokenError, ServerError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from 'jose';
import { z } from 'zod';

import type { HttpServerConfig } from '../config.js';
import { createConcurrencyGate } from '../operations/concurrency-gate.js';
import type { AuthenticatedMcpPrincipal } from './principal.js';

const jwtClaimsSchema = z.object({
  iss: z.url(),
  aud: z.union([z.string(), z.array(z.string())]),
  sub: z.string().min(1),
  exp: z.number().int().positive(),
  org_id: z.string().startsWith('org_').optional(),
});

const activeIntrospectionSchema = z.object({
  active: z.literal(true),
  client_id: z.string().min(1),
  iss: z.url(),
  aud: z.union([z.string(), z.array(z.string())]),
  sub: z.string().min(1),
  exp: z.number().int().positive(),
  org_id: z.string().startsWith('org_').optional(),
});

const introspectionSchema = z.union([
  z.object({ active: z.literal(false) }),
  activeIntrospectionSchema,
]);

function includesAudience(audience: string | string[], resource: string): boolean {
  return Array.isArray(audience) ? audience.includes(resource) : audience === resource;
}

function createPrincipal(
  subject: string,
  issuer: string,
  organizationExternalId: string | undefined,
  oauthClientId: string,
): AuthenticatedMcpPrincipal {
  if (subject.startsWith('user_')) {
    return {
      actorKind: 'user',
      issuer,
      subject,
      oauthClientId,
      ...(organizationExternalId === undefined ? {} : { organizationExternalId }),
    };
  }
  if (subject.startsWith('client_') && organizationExternalId !== undefined) {
    return {
      actorKind: 'service',
      issuer,
      subject,
      organizationExternalId,
      oauthClientId,
    };
  }
  throw new InvalidTokenError('Unsupported WorkOS token subject');
}

export interface WorkosTokenVerifierOptions {
  readonly config: Pick<
    HttpServerConfig,
    | 'issuerUrl'
    | 'publicUrl'
    | 'workosClientId'
    | 'workosClientSecret'
    | 'authTimeoutMs'
    | 'authMaxInFlight'
  >;
  readonly introspectionEndpoint: URL;
  readonly fetchIntrospection?: typeof fetch;
  readonly verifyJwt?: (token: string) => Promise<unknown>;
}

export function createWorkosTokenVerifier({
  config,
  introspectionEndpoint,
  fetchIntrospection = fetch,
  verifyJwt,
}: WorkosTokenVerifierOptions): OAuthTokenVerifier {
  const gate = createConcurrencyGate(config.authMaxInFlight);
  const jwks = createRemoteJWKSet(new URL('/oauth2/jwks', config.issuerUrl), {
    timeoutDuration: config.authTimeoutMs,
  });
  const issuer = config.issuerUrl.href.replace(/\/$/u, '');
  const resource = config.publicUrl.href;
  const verifyJwtToken =
    verifyJwt ??
    (async (token: string): Promise<unknown> => {
      const verified = await jwtVerify(token, jwks, {
        algorithms: ['RS256'],
        audience: resource,
        issuer,
      });
      return verified.payload;
    });

  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      let claims: z.infer<typeof jwtClaimsSchema>;
      try {
        claims = jwtClaimsSchema.parse(await verifyJwtToken(token));
      } catch (error: unknown) {
        if (error instanceof joseErrors.JOSEError || error instanceof z.ZodError) {
          throw new InvalidTokenError('Invalid WorkOS access token');
        }
        throw new ServerError('Token verification unavailable');
      }
      if (claims.iss !== issuer || !includesAudience(claims.aud, resource)) {
        throw new InvalidTokenError('Invalid WorkOS access token');
      }

      const lease = gate.tryAcquire();
      if (lease === undefined) {
        throw new ServerError('Token verification capacity exceeded');
      }

      try {
        const body = new URLSearchParams({
          client_id: config.workosClientId,
          client_secret: config.workosClientSecret,
          token,
          token_type_hint: 'access_token',
        });
        const response = await fetchIntrospection(introspectionEndpoint, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/x-www-form-urlencoded',
          },
          body,
          signal: AbortSignal.timeout(config.authTimeoutMs),
        });
        if (!response.ok) throw new ServerError('Token introspection unavailable');

        const result = introspectionSchema.parse(await response.json());
        if (!result.active) throw new InvalidTokenError('Inactive WorkOS access token');
        if (
          result.iss !== claims.iss ||
          result.sub !== claims.sub ||
          result.exp !== claims.exp ||
          result.org_id !== claims.org_id ||
          !includesAudience(result.aud, resource)
        ) {
          throw new InvalidTokenError('WorkOS token claims do not match introspection');
        }

        const principal = createPrincipal(result.sub, result.iss, result.org_id, result.client_id);
        return {
          token,
          clientId: result.client_id,
          // WorkOS does not expose granted scopes in either its documented access-token
          // claims or introspection response. The audience is the alpha's OAuth grant.
          scopes: [],
          expiresAt: result.exp,
          resource: config.publicUrl,
          extra: { principal },
        };
      } catch (error: unknown) {
        if (error instanceof InvalidTokenError || error instanceof ServerError) throw error;
        if (error instanceof z.ZodError) {
          throw new ServerError('Invalid token introspection response');
        }
        throw new ServerError('Token introspection unavailable');
      } finally {
        lease.release();
      }
    },
  };
}
