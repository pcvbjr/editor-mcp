import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import pino from 'pino';

import { createHttpApp, type HttpAppOptions } from '../../src/http/app.js';
import { createHttpServerConfig, type HttpServerConfig } from '../../src/http/config.js';
import { createReadinessController } from '../../src/http/readiness.js';
import { createActiveRequestRegistry } from '../../src/http/request-registry.js';
import { createHttpServerRuntime } from '../../src/http/runtime.js';

export const testOAuthMetadata: OAuthMetadata = {
  issuer: 'https://authkit.example.test',
  authorization_endpoint: 'https://authkit.example.test/oauth2/authorize',
  token_endpoint: 'https://authkit.example.test/oauth2/token',
  introspection_endpoint: 'https://authkit.example.test/oauth2/introspection',
  response_types_supported: ['code'],
  code_challenge_methods_supported: ['S256'],
};

export const testTokenVerifier: OAuthTokenVerifier = {
  verifyAccessToken(token) {
    if (token !== 'test-token') return Promise.reject(new Error('unexpected test token'));
    return Promise.resolve({
      token,
      clientId: 'client_test',
      scopes: [],
      expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
      resource: new URL('http://127.0.0.1/mcp'),
      extra: {
        principal: {
          actorKind: 'user',
          issuer: testOAuthMetadata.issuer,
          subject: 'user_test',
          organizationExternalId: 'org_test',
          oauthClientId: 'client_test',
        },
      },
    });
  },
};

export interface TestHttpHarnessOptions extends Partial<
  Omit<
    HttpAppOptions,
    'config' | 'oauthMetadata' | 'tokenVerifier' | 'readiness' | 'activeRequests'
  >
> {
  readonly config?: HttpServerConfig;
  readonly oauthMetadata?: OAuthMetadata;
  readonly tokenVerifier?: OAuthTokenVerifier;
}

export function createTestHttpHarness(options: TestHttpHarnessOptions = {}) {
  const config = options.config ?? createHttpServerConfig({ port: 0 });
  const readiness = createReadinessController();
  const activeRequests = createActiveRequestRegistry();
  const app = createHttpApp({
    config,
    oauthMetadata: options.oauthMetadata ?? testOAuthMetadata,
    tokenVerifier: options.tokenVerifier ?? testTokenVerifier,
    readiness,
    activeRequests,
    logger: options.logger ?? pino({ level: 'silent' }),
    ...(options.register === undefined ? {} : { register: options.register }),
    ...(options.reportError === undefined ? {} : { reportError: options.reportError }),
    ...(options.createServer === undefined ? {} : { createServer: options.createServer }),
  });
  const runtime = createHttpServerRuntime(app, config, readiness, activeRequests);

  return {
    activeRequests,
    app,
    config,
    readiness,
    runtime,
    async start() {
      const address = await runtime.start();
      return new URL(`http://127.0.0.1:${String(address.port)}`);
    },
    close: () => runtime.close(),
  };
}

export function createAuthenticatedTransport(url: URL): Transport {
  return new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: 'Bearer test-token' } },
  }) as Transport;
}
