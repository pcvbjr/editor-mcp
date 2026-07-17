import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';

import { loadWorkosOAuthMetadata, type MetadataFetch } from './auth/oauth-metadata.js';
import { createWorkosTokenVerifier } from './auth/workos-token-verifier.js';
import { createHttpApp } from './app.js';
import { parseHttpServerConfig, type HttpServerConfig } from './config.js';
import { runHttpServerProcess } from './process.js';
import { createReadinessController } from './readiness.js';
import { createActiveRequestRegistry } from './request-registry.js';
import { createHttpServerRuntime, type ServeFunction } from './runtime.js';
import { createNodeProcessControl, type ProcessControl } from '../process.js';
import type { CapabilityRegistrar } from '../server.js';
import { createStderrErrorReporter, type InternalErrorReporter } from '../diagnostics.js';

export interface HttpMainOptions {
  readonly config?: HttpServerConfig;
  readonly processControl?: ProcessControl;
  readonly serveFunction?: ServeFunction;
  readonly register?: CapabilityRegistrar;
  readonly reportError?: InternalErrorReporter;
  readonly oauthMetadata?: OAuthMetadata;
  readonly tokenVerifier?: OAuthTokenVerifier;
  readonly fetchMetadata?: MetadataFetch;
}

export async function main({
  config = parseHttpServerConfig(),
  processControl = createNodeProcessControl(),
  serveFunction,
  register,
  reportError = createStderrErrorReporter(processControl.writeStderr),
  oauthMetadata,
  tokenVerifier,
  fetchMetadata,
}: HttpMainOptions = {}): Promise<void> {
  const metadata = oauthMetadata ?? (await loadWorkosOAuthMetadata(config, fetchMetadata ?? fetch));
  const introspectionEndpoint = metadata.introspection_endpoint;
  if (introspectionEndpoint === undefined) {
    throw new Error('WorkOS metadata does not advertise token introspection');
  }
  const verifier =
    tokenVerifier ??
    createWorkosTokenVerifier({
      config,
      introspectionEndpoint: new URL(introspectionEndpoint),
    });
  const readiness = createReadinessController();
  const activeRequests = createActiveRequestRegistry();
  const app = register
    ? createHttpApp({
        config,
        oauthMetadata: metadata,
        tokenVerifier: verifier,
        readiness,
        activeRequests,
        register,
        reportError,
      })
    : createHttpApp({
        config,
        oauthMetadata: metadata,
        tokenVerifier: verifier,
        readiness,
        activeRequests,
        reportError,
      });
  const runtime = createHttpServerRuntime(
    app,
    config,
    readiness,
    activeRequests,
    serveFunction,
    reportError,
  );

  await runHttpServerProcess({ runtime, processControl });
}
