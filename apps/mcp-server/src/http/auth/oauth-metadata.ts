import { OAuthMetadataSchema, type OAuthMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';

import type { HttpServerConfig } from '../config.js';

export type MetadataFetch = typeof fetch;

export async function loadWorkosOAuthMetadata(
  config: Pick<HttpServerConfig, 'issuerUrl' | 'authTimeoutMs'>,
  fetchMetadata: MetadataFetch = fetch,
): Promise<OAuthMetadata> {
  const metadataUrl = new URL('/.well-known/oauth-authorization-server', config.issuerUrl);
  const response = await fetchMetadata(metadataUrl, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(config.authTimeoutMs),
    redirect: 'error',
  });
  if (!response.ok) {
    throw new Error(`WorkOS metadata request failed with status ${String(response.status)}`);
  }

  const metadata = OAuthMetadataSchema.parse(await response.json());
  if (metadata.issuer !== config.issuerUrl.href.replace(/\/$/u, '')) {
    throw new Error('WorkOS metadata issuer does not match configuration');
  }
  if (!metadata.code_challenge_methods_supported?.includes('S256')) {
    throw new Error('WorkOS metadata does not advertise PKCE S256');
  }
  if (metadata.introspection_endpoint === undefined) {
    throw new Error('WorkOS metadata does not advertise token introspection');
  }
  const introspectionEndpoint = new URL(metadata.introspection_endpoint);
  if (
    introspectionEndpoint.origin !== config.issuerUrl.origin ||
    (config.issuerUrl.protocol === 'https:' && introspectionEndpoint.protocol !== 'https:')
  ) {
    throw new Error('WorkOS introspection endpoint must use the configured issuer origin');
  }
  return metadata;
}
