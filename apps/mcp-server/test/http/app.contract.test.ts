import { describe, expect, it } from 'vitest';

import { createHttpApp } from '../../src/http/app.js';
import { createHttpServerConfig } from '../../src/http/config.js';

describe('HTTP application contract', () => {
  it('keeps the health endpoint separate from MCP routing', async () => {
    const app = createHttpApp({ config: createHttpServerConfig() });

    expect((await app.request('http://127.0.0.1/healthz')).status).toBe(200);
    expect((await app.request('http://127.0.0.1/unknown')).status).toBe(404);
  });

  it('returns method-not-allowed for stateless GET and DELETE requests', async () => {
    const app = createHttpApp({ config: createHttpServerConfig() });

    const headers = { accept: 'text/event-stream' };
    const getResponse = await app.request('http://127.0.0.1/mcp', { method: 'GET', headers });
    const deleteResponse = await app.request('http://127.0.0.1/mcp', { method: 'DELETE', headers });

    expect(getResponse.status).toBe(405);
    expect(deleteResponse.status).toBe(405);
  });

  it('does not advertise product capabilities by default', async () => {
    const app = createHttpApp({ config: createHttpServerConfig() });
    const response = await app.request('http://127.0.0.1/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'http-contract-client', version: '1.0.0' },
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    const payload = (await response.json()) as {
      result: { serverInfo: unknown; capabilities: unknown };
    };
    expect(payload.result.serverInfo).toMatchObject({
      name: '@editor-mcp/mcp-server',
      version: '0.0.0',
    });
    expect(payload.result.capabilities).toEqual({});
  });
});
