import { InvalidTokenError, ServerError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { describe, expect, it, vi } from 'vitest';

import { authenticatedMcpPrincipalFromAuthInfo } from '../../src/http/auth/principal.js';
import { createWorkosTokenVerifier } from '../../src/http/auth/workos-token-verifier.js';
import { createHttpServerConfig } from '../../src/http/config.js';

const config = createHttpServerConfig();
const issuer = config.issuerUrl.href.replace(/\/$/u, '');
const resource = config.publicUrl.href;
const now = Math.floor(Date.now() / 1_000);
const jwtClaims = {
  iss: issuer,
  aud: resource,
  sub: 'user_test',
  org_id: 'org_test',
  exp: now + 3_600,
};

function introspectionResponse(overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    active: true,
    client_id: 'client_agent',
    ...jwtClaims,
    ...overrides,
  });
}

function createVerifier(response: Response) {
  return createWorkosTokenVerifier({
    config,
    introspectionEndpoint: new URL('/oauth2/introspection', config.issuerUrl),
    verifyJwt: () => Promise.resolve(jwtClaims),
    fetchIntrospection: vi.fn(() => Promise.resolve(response)),
  });
}

describe('WorkOS token verifier', () => {
  it('combines local JWT validation and introspection into SDK auth context', async () => {
    const authInfo = await createVerifier(introspectionResponse()).verifyAccessToken('opaque');

    expect(authInfo).toMatchObject({
      clientId: 'client_agent',
      scopes: [],
      expiresAt: jwtClaims.exp,
      resource: config.publicUrl,
    });
    expect(authenticatedMcpPrincipalFromAuthInfo(authInfo)).toEqual({
      actorKind: 'user',
      issuer,
      subject: 'user_test',
      organizationExternalId: 'org_test',
      oauthClientId: 'client_agent',
    });
  });

  it.each([
    [Response.json({ active: false }), 'inactive token'],
    [introspectionResponse({ sub: 'user_other' }), 'subject mismatch'],
    [introspectionResponse({ aud: 'https://other.example/mcp' }), 'audience mismatch'],
  ])('fails closed for %s (%s)', async (response) => {
    await expect(createVerifier(response).verifyAccessToken('opaque')).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
  });

  it('distinguishes provider failure from an invalid credential', async () => {
    const verifier = createWorkosTokenVerifier({
      config,
      introspectionEndpoint: new URL('/oauth2/introspection', config.issuerUrl),
      verifyJwt: () => Promise.resolve(jwtClaims),
      fetchIntrospection: vi.fn(() => Promise.reject(new Error('TOP_SECRET_PROVIDER'))),
    });

    const outcome = verifier.verifyAccessToken('TOP_SECRET_TOKEN').catch((error: unknown) => error);
    await expect(outcome).resolves.toBeInstanceOf(ServerError);
    await expect(outcome).resolves.not.toHaveProperty(
      'message',
      expect.stringContaining('TOP_SECRET'),
    );
  });

  it('represents M2M tokens as service principals', async () => {
    const serviceClaims = { ...jwtClaims, sub: 'client_machine' };
    const verifier = createWorkosTokenVerifier({
      config,
      introspectionEndpoint: new URL('/oauth2/introspection', config.issuerUrl),
      verifyJwt: () => Promise.resolve(serviceClaims),
      fetchIntrospection: vi.fn(() =>
        Promise.resolve(introspectionResponse({ sub: 'client_machine' })),
      ),
    });

    const authInfo = await verifier.verifyAccessToken('opaque');
    expect(authenticatedMcpPrincipalFromAuthInfo(authInfo).actorKind).toBe('service');
  });

  it('bounds concurrent provider calls', async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<Response>((resolve) => {
      release = () => {
        resolve(introspectionResponse());
      };
    });
    const verifier = createWorkosTokenVerifier({
      config: createHttpServerConfig({ authMaxInFlight: 1 }),
      introspectionEndpoint: new URL('/oauth2/introspection', config.issuerUrl),
      verifyJwt: () => Promise.resolve(jwtClaims),
      fetchIntrospection: vi.fn(() => pending),
    });

    const first = verifier.verifyAccessToken('first');
    await vi.waitFor(() => {
      expect(release).toBeTypeOf('function');
    });
    await expect(verifier.verifyAccessToken('second')).rejects.toBeInstanceOf(ServerError);
    if (release !== undefined) release();
    await expect(first).resolves.toMatchObject({ clientId: 'client_agent' });
  });
});
