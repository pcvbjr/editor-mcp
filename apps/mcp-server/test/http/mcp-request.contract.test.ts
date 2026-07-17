import { describe, expect, it } from 'vitest';

import { createHttpApp } from '../../src/http/app.js';
import { createHttpServerConfig } from '../../src/http/config.js';
import { initializeBody, mcpHeaders } from '../support/mcp-http-fixture.js';

describe('MCP HTTP request contract', () => {
  it('handles media types case-insensitively and rejects disabled response types', async () => {
    const app = createHttpApp({ config: createHttpServerConfig() });
    const accepted = await app.request('http://127.0.0.1/mcp', {
      method: 'POST',
      headers: {
        accept: 'Application/JSON; q=1, Text/Event-Stream',
        'content-type': 'Application/JSON; charset=utf-8',
      },
      body: initializeBody,
    });
    const disabled = await app.request('http://127.0.0.1/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json; q=0, text/event-stream',
        'content-type': 'application/json',
      },
      body: initializeBody,
    });

    expect(accepted.status).toBe(200);
    expect(disabled.status).toBe(406);
  });

  it('rejects empty, initialization, and post-2025-03-26 JSON-RPC batches', async () => {
    const app = createHttpApp({ config: createHttpServerConfig() });
    const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
    const cases = [
      { body: '[]', headers: mcpHeaders },
      { body: `[${initializeBody}]`, headers: mcpHeaders },
      {
        body: JSON.stringify([ping]),
        headers: { ...mcpHeaders, 'mcp-protocol-version': '2025-06-18' },
      },
    ];

    for (const request of cases) {
      const response = await app.request('http://127.0.0.1/mcp', {
        method: 'POST',
        ...request,
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: -32_600 },
      });
    }

    const legacyResponse = await app.request('http://127.0.0.1/mcp', {
      method: 'POST',
      headers: { ...mcpHeaders, 'mcp-protocol-version': '2025-03-26' },
      body: JSON.stringify([ping]),
    });
    expect(legacyResponse.status).toBe(200);
  });

  it('preserves protocol-correct failures and notification responses', async () => {
    const app = createHttpApp({ config: createHttpServerConfig() });
    const primitive = await app.request('http://127.0.0.1/mcp', {
      method: 'POST',
      headers: mcpHeaders,
      body: '1',
    });
    const unknownMethod = await app.request('http://127.0.0.1/mcp', {
      method: 'POST',
      headers: mcpHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'not-real' }),
    });
    const unsupportedVersion = await app.request('http://127.0.0.1/mcp', {
      method: 'POST',
      headers: { ...mcpHeaders, 'mcp-protocol-version': '1900-01-01' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
    });
    const notification = await app.request('http://127.0.0.1/mcp', {
      method: 'POST',
      headers: mcpHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });

    expect(primitive.status).toBe(400);
    await expect(primitive.json()).resolves.toMatchObject({ error: { code: -32_700 } });
    expect(unknownMethod.status).toBe(200);
    await expect(unknownMethod.json()).resolves.toMatchObject({ error: { code: -32_601 } });
    expect(unsupportedVersion.status).toBe(400);
    await expect(unsupportedVersion.json()).resolves.toMatchObject({ error: { code: -32_000 } });
    expect(notification.status).toBe(202);
    expect(await notification.text()).toBe('');
  });
});
