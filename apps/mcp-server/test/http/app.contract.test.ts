import { describe, expect, it, vi } from 'vitest';

import { createHttpApp } from '../../src/http/app.js';
import { createHttpServerConfig } from '../../src/http/config.js';
import type { InternalErrorReporter } from '../../src/diagnostics.js';
import { createMcpServer } from '../../src/server.js';
import { initializeBody, mcpHeaders } from '../support/mcp-http-fixture.js';

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
      headers: mcpHeaders,
      body: initializeBody,
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

  it('sanitizes request failures and reports request and cleanup causes internally', async () => {
    const reportError = vi.fn<InternalErrorReporter>();
    const app = createHttpApp({
      config: createHttpServerConfig(),
      reportError,
      createServer: () => ({
        connect: () => Promise.reject(new Error('TOP_SECRET_REQUEST')),
        close: () => Promise.reject(new Error('TOP_SECRET_CLOSE')),
      }),
    });
    const response = await app.request('http://127.0.0.1/mcp', {
      method: 'POST',
      headers: mcpHeaders,
      body: '{}',
    });

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain('Internal server error');
    expect(body).not.toContain('TOP_SECRET');
    expect(reportError.mock.calls.map(([event]) => event)).toEqual([
      { phase: 'request', error: new Error('TOP_SECRET_REQUEST') },
      { phase: 'close', error: new Error('TOP_SECRET_CLOSE') },
    ]);
  });

  it('sanitizes synchronous server construction failures through the reporter', async () => {
    const reportError = vi.fn<InternalErrorReporter>();
    const app = createHttpApp({
      config: createHttpServerConfig(),
      reportError,
      createServer: () => {
        throw new Error('TOP_SECRET_FACTORY');
      },
    });

    const response = await app.request('http://127.0.0.1/mcp', {
      method: 'POST',
      headers: mcpHeaders,
      body: initializeBody,
    });

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('TOP_SECRET_FACTORY');
    expect(reportError).toHaveBeenCalledWith({
      phase: 'request',
      error: new Error('TOP_SECRET_FACTORY'),
    });
  });

  it('sanitizes unexpected failures outside the MCP route boundary', async () => {
    const reportError = vi.fn<InternalErrorReporter>();
    const app = createHttpApp({ config: createHttpServerConfig(), reportError });
    app.get('/test-unexpected-failure', () => {
      throw new Error('TOP_SECRET_GLOBAL');
    });

    const response = await app.request('http://127.0.0.1/test-unexpected-failure');

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('TOP_SECRET_GLOBAL');
    expect(reportError).toHaveBeenCalledWith({
      phase: 'request',
      error: new Error('TOP_SECRET_GLOBAL'),
    });
  });

  it('closes each successfully constructed server exactly once', async () => {
    const close = vi.fn<() => void>();
    const app = createHttpApp({
      config: createHttpServerConfig(),
      createServer: (options) => {
        const server = createMcpServer(options);
        return {
          connect: server.connect.bind(server),
          close: async () => {
            close();
            await server.close();
          },
        };
      },
    });

    const response = await app.request('http://127.0.0.1/mcp', {
      method: 'POST',
      headers: mcpHeaders,
      body: initializeBody,
    });

    expect(response.status).toBe(200);
    expect(close).toHaveBeenCalledOnce();
  });

  it('isolates and closes every concurrent stateless request', async () => {
    const servers = new Set<ReturnType<typeof createMcpServer>>();
    const close = vi.fn<() => void>();
    const app = createHttpApp({
      config: createHttpServerConfig(),
      createServer: (options) => {
        const server = createMcpServer(options);
        servers.add(server);
        return {
          connect: server.connect.bind(server),
          close: async () => {
            close();
            await server.close();
          },
        };
      },
    });

    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, id) =>
        Promise.resolve().then(() =>
          app.request('http://127.0.0.1/mcp', {
            method: 'POST',
            headers: mcpHeaders,
            body: JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' }),
          }),
        ),
      ),
    );

    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(servers.size).toBe(10);
    expect(close).toHaveBeenCalledTimes(10);
  });

  it('rejects routing, security, headers, and malformed JSON before server construction', async () => {
    const createServer = vi.fn(() => {
      throw new Error('server must not be constructed');
    });
    const app = createHttpApp({ config: createHttpServerConfig(), createServer });

    const responses = await Promise.all([
      app.request('http://127.0.0.1/mcp', { method: 'GET' }),
      app.request('http://evil.example/mcp', {
        method: 'POST',
        headers: mcpHeaders,
        body: initializeBody,
      }),
      app.request('http://127.0.0.1/mcp', {
        method: 'POST',
        headers: {
          accept: 'application/jsonp, text/event-streaming',
          'content-type': 'application/json',
        },
        body: initializeBody,
      }),
      app.request('http://127.0.0.1/mcp', {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'text/plain; note=application/json',
        },
        body: initializeBody,
      }),
      app.request('http://127.0.0.1/mcp', {
        method: 'POST',
        headers: mcpHeaders,
        body: '{',
      }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([405, 403, 406, 415, 400]);
    expect(createServer).not.toHaveBeenCalled();
  });
});
