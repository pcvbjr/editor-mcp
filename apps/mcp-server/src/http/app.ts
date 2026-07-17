import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { Hono } from 'hono';

import packageManifest from '../../package.json' with { type: 'json' };

import type { HttpServerConfig } from './config.js';
import { createJsonRpcErrorResponse, prepareMcpPostRequest } from './mcp-request.js';
import { createSecurityMiddleware } from './security.js';
import { reportInternalError, type InternalErrorReporter } from '../diagnostics.js';
import {
  createMcpServer,
  type CapabilityRegistrar,
  type CreateMcpServerOptions,
} from '../server.js';

export type McpServerFactory = (
  options: CreateMcpServerOptions,
) => Pick<ReturnType<typeof createMcpServer>, 'connect' | 'close'>;

export interface HttpAppOptions {
  readonly config: HttpServerConfig;
  readonly register?: CapabilityRegistrar;
  readonly serverName?: string;
  readonly serverVersion?: string;
  readonly reportError?: InternalErrorReporter;
  readonly createServer?: McpServerFactory;
}

export function createHttpApp({
  config,
  register,
  serverName = packageManifest.name,
  serverVersion = packageManifest.version,
  reportError,
  createServer = createMcpServer,
}: HttpAppOptions): Hono {
  const app = new Hono();

  app.onError((error) => {
    reportInternalError(reportError, { phase: 'request', error });
    return createJsonRpcErrorResponse(500, ErrorCode.InternalError, 'Internal server error');
  });

  app.use('*', createSecurityMiddleware(config));

  app.get('/healthz', (context) => context.json({ status: 'ok' }));

  app.all('/mcp', async (context) => {
    if (context.req.method !== 'POST') {
      return context.text('Method Not Allowed', 405, { Allow: 'POST' });
    }

    const preparedRequest = await prepareMcpPostRequest(context.req.raw);
    if (preparedRequest instanceof Response) return preparedRequest;

    let server: ReturnType<McpServerFactory> | undefined;

    try {
      const transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse: true,
      });
      const serverOptions = reportError
        ? { name: serverName, version: serverVersion, reportError }
        : { name: serverName, version: serverVersion };
      server = register
        ? createServer({ ...serverOptions, register })
        : createServer(serverOptions);
      await server.connect(transport);
      return await transport.handleRequest(preparedRequest.request, {
        parsedBody: preparedRequest.body,
      });
    } catch (error: unknown) {
      reportInternalError(reportError, { phase: 'request', error });
      return createJsonRpcErrorResponse(500, ErrorCode.InternalError, 'Internal server error');
    } finally {
      if (server !== undefined) {
        try {
          await server.close();
        } catch (error: unknown) {
          reportInternalError(reportError, { phase: 'close', error });
        }
      }
    }
  });

  return app;
}
