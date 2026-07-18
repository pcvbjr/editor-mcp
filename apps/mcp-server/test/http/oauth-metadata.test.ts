import { describe, expect, it, vi } from 'vitest';

import { loadWorkosOAuthMetadata } from '../../src/http/auth/oauth-metadata.js';
import { createHttpServerConfig } from '../../src/http/config.js';

const config = createHttpServerConfig();

function metadata(overrides: Record<string, unknown> = {}): Response {
  const issuer = config.issuerUrl.href.replace(/\/$/u, '');
  return Response.json({
    issuer,
    authorization_endpoint: `${issuer}/oauth2/authorize`,
    token_endpoint: `${issuer}/oauth2/token`,
    introspection_endpoint: `${issuer}/oauth2/introspection`,
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
    ...overrides,
  });
}

describe('WorkOS authorization metadata', () => {
  it('validates the issuer, PKCE, and introspection contract', async () => {
    const fetchMetadata = vi.fn(() => Promise.resolve(metadata()));

    await expect(loadWorkosOAuthMetadata(config, fetchMetadata)).resolves.toMatchObject({
      issuer: 'https://authkit.example.test',
      code_challenge_methods_supported: ['S256'],
    });
    expect(fetchMetadata).toHaveBeenCalledExactlyOnceWith(
      new URL('/.well-known/oauth-authorization-server', config.issuerUrl),
      expect.objectContaining({ redirect: 'error' }),
    );
  });

  it.each([
    [metadata({ issuer: 'https://other.example' }), 'issuer'],
    [metadata({ code_challenge_methods_supported: [] }), 'PKCE'],
    [metadata({ introspection_endpoint: undefined }), 'introspection'],
    [
      metadata({ introspection_endpoint: 'https://credentials.example/oauth2/introspection' }),
      'cross-origin introspection',
    ],
  ])('rejects invalid %s metadata (%s)', async (response, _description) => {
    void _description;
    await expect(
      loadWorkosOAuthMetadata(
        config,
        vi.fn(() => Promise.resolve(response)),
      ),
    ).rejects.toThrow();
  });
});
