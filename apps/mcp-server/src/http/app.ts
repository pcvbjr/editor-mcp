import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';

import packageManifest from '../../package.json' with { type: 'json' };

import type { HttpServerConfig } from './config.js';
import { createSecurityMiddleware } from './security.js';
import { createMcpServer, type CapabilityRegistrar } from '../server.js';

export interface HttpAppOptions {
  readonly config: HttpServerConfig;
  readonly register?: CapabilityRegistrar;
  readonly serverName?: string;
  readonly serverVersion?: string;
}

export function createHttpApp({
  config,
  register,
  serverName = packageManifest.name,
  serverVersion = packageManifest.version,
}: HttpAppOptions): Hono {
  const app = new Hono();

  app.use('*', createSecurityMiddleware(config));

  app.get('/healthz', (context) => context.json({ status: 'ok' }));

  app.all('/mcp', async (context) => {
    if (context.req.method !== 'POST') {
      return context.text('Method Not Allowed', 405, { Allow: 'POST' });
    }

    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    const serverOptions = { name: serverName, version: serverVersion };
    const server = register
      ? createMcpServer({ ...serverOptions, register })
      : createMcpServer(serverOptions);

    try {
      await server.connect(transport);
      return await transport.handleRequest(context.req.raw);
    } catch {
      return context.json(
        {
          jsonrpc: '2.0',
          error: { code: -32_603, message: 'Internal server error' },
          id: null,
        },
        500,
      );
    } finally {
      await server.close().catch(() => undefined);
    }
  });

  return app;
}
