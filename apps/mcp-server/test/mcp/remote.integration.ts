import assert from 'node:assert/strict';

import { ClientCredentialsProvider } from '@modelcontextprotocol/sdk/client/auth-extensions.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';

import packageManifest from '../../package.json' with { type: 'json' };

const environmentSchema = z.object({
  MCP_SERVER_URL: z.url().refine((value) => new URL(value).protocol === 'https:'),
  MCP_SMOKE_CLIENT_ID: z.string().min(1),
  MCP_SMOKE_CLIENT_SECRET: z.string().min(1),
});

const environment = environmentSchema.parse(process.env);
const serverUrl = new URL(environment.MCP_SERVER_URL);

const missingToken = await fetch(serverUrl, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
});
assert.equal(missingToken.status, 401);
assert.match(missingToken.headers.get('www-authenticate') ?? '', /resource_metadata=/u);

const malformedToken = await fetch(serverUrl, {
  method: 'POST',
  headers: {
    authorization: 'Bearer malformed-smoke-token',
    'content-type': 'application/json',
  },
  body: '{}',
});
assert.equal(malformedToken.status, 401);

const provider = new ClientCredentialsProvider({
  clientId: environment.MCP_SMOKE_CLIENT_ID,
  clientSecret: environment.MCP_SMOKE_CLIENT_SECRET,
  clientName: 'Editor MCP production smoke',
});
const transport = new StreamableHTTPClientTransport(serverUrl, {
  authProvider: provider,
}) as Transport;
const client = new Client({ name: 'editor-mcp-production-smoke', version: '1.0.0' });

try {
  await client.connect(transport, { timeout: 10_000 });
  assert.deepEqual(client.getServerVersion(), {
    name: packageManifest.name,
    version: packageManifest.version,
  });
  await client.ping();
  await client.listTools();
} finally {
  await client.close();
}

process.stdout.write('Authenticated remote MCP smoke passed\n');
