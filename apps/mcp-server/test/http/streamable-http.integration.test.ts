import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import { createHttpServerConfig } from '../../src/http/config.js';
import type { InternalErrorReporter } from '../../src/diagnostics.js';
import { registerProbeTool } from '../support/register-probe-tool.js';
import {
  createAuthenticatedTransport,
  createTestHttpHarness,
} from '../support/http-test-harness.js';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const compiledHttpCli = fileURLToPath(new URL('../../dist/http/cli.js', import.meta.url));

describe('Streamable HTTP MCP integration', () => {
  it('completes authenticated SDK handshakes and keeps capabilities per request', async () => {
    let registrations = 0;
    const harness = createTestHttpHarness({
      register: (server) => {
        registrations += 1;
        registerProbeTool(server, () => undefined);
      },
    });
    const baseUrl = await harness.start();
    const clients = [
      new Client({ name: 'streamable-http-client-a', version: '1.0.0' }),
      new Client({ name: 'streamable-http-client-b', version: '1.0.0' }),
    ];

    try {
      await Promise.all(
        clients.map((client) =>
          client.connect(createAuthenticatedTransport(new URL('/mcp', baseUrl))),
        ),
      );
      for (const client of clients) {
        expect(client.getServerVersion()).toMatchObject({
          name: '@editor-mcp/mcp-server',
          version: '0.0.0',
        });
        expect(await client.listTools()).toMatchObject({ tools: [{ name: 'test.probe' }] });
        expect(
          await client.callTool({ name: 'test.probe', arguments: { message: 'hello' } }),
        ).toMatchObject({ content: [{ type: 'text', text: '{"echo":"hello"}' }] });
      }
      expect(registrations).toBeGreaterThan(2);
    } finally {
      await Promise.all(clients.map((client) => client.close()));
      await harness.close();
    }
  });

  it('binds with Node IPv6 syntax and accepts bracketed IPv6 Host authority', async () => {
    const harness = createTestHttpHarness({
      config: createHttpServerConfig({
        host: '::1',
        port: 0,
        publicUrl: new URL('http://[::1]/mcp'),
        allowedHosts: ['[::1]'],
      }),
    });
    const address = await harness.runtime.start();
    const client = new Client({ name: 'ipv6-http-client', version: '1.0.0' });

    try {
      await client.connect(
        createAuthenticatedTransport(new URL(`http://[::1]:${String(address.port)}/mcp`)),
      );
      expect(client.getServerVersion()).toMatchObject({ name: '@editor-mcp/mcp-server' });
    } finally {
      await client.close();
      await harness.close();
    }
  });

  it('never returns raw tool exceptions over authenticated HTTP', async () => {
    const reportError = vi.fn<InternalErrorReporter>();
    const harness = createTestHttpHarness({
      reportError,
      register: (server) => {
        server.registerTool('test.secret-error', {}, () => {
          throw new Error('TOP_SECRET_HTTP_INTERNAL');
        });
      },
    });
    const baseUrl = await harness.start();
    const client = new Client({ name: 'safe-error-http-client', version: '1.0.0' });

    try {
      await client.connect(createAuthenticatedTransport(new URL('/mcp', baseUrl)));
      const result = await client.callTool({ name: 'test.secret-error' });
      expect(result).toMatchObject({
        content: [{ type: 'text', text: 'Tool execution failed' }],
        isError: true,
      });
      expect(JSON.stringify(result)).not.toContain('TOP_SECRET_HTTP_INTERNAL');
    } finally {
      await client.close();
      await harness.close();
    }
  });

  it('aborts timed-out tools and retains bookkeeping until the callback settles', async () => {
    let observedAbort = false;
    const harness = createTestHttpHarness({
      config: createHttpServerConfig({ port: 0, requestTimeoutMs: 50 }),
      register: (server) => {
        server.registerTool('test.wait-for-abort', {}, (extra) => {
          return new Promise((_resolve, reject) => {
            extra.signal.addEventListener(
              'abort',
              () => {
                observedAbort = true;
                reject(new Error('expected test abort'));
              },
              { once: true },
            );
          });
        });
      },
    });
    const baseUrl = await harness.start();
    const client = new Client({ name: 'timeout-http-client', version: '1.0.0' });

    try {
      await client.connect(createAuthenticatedTransport(new URL('/mcp', baseUrl)));
      await expect(client.callTool({ name: 'test.wait-for-abort' })).rejects.toMatchObject({
        code: 504,
      });
      await vi.waitFor(() => {
        expect(observedAbort).toBe(true);
        expect(harness.activeRequests.size).toBe(0);
      });
    } finally {
      await client.close();
      await harness.close();
    }
  });

  it('starts the compiled production HTTP binary and exits cleanly on SIGTERM', async () => {
    const metadataServer = createServer((request, response) => {
      if (request.url !== '/.well-known/oauth-authorization-server') {
        response.writeHead(404).end();
        return;
      }
      const address = metadataServer.address();
      if (address === null || typeof address === 'string')
        throw new Error('metadata server address');
      const issuer = `http://127.0.0.1:${String(address.port)}`;
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          issuer,
          authorization_endpoint: `${issuer}/oauth2/authorize`,
          token_endpoint: `${issuer}/oauth2/token`,
          introspection_endpoint: `${issuer}/oauth2/introspection`,
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
        }),
      );
    });
    await new Promise<void>((resolve) => metadataServer.listen(0, '127.0.0.1', resolve));
    const metadataAddress = metadataServer.address();
    if (metadataAddress === null || typeof metadataAddress === 'string') {
      throw new Error('metadata server failed to bind');
    }

    const child = spawn(process.execPath, [compiledHttpCli], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        EDITOR_MCP_PUBLIC_URL: 'http://127.0.0.1/mcp',
        EDITOR_MCP_AUTH_ISSUER_URL: `http://127.0.0.1:${String(metadataAddress.port)}`,
        EDITOR_MCP_WORKOS_CLIENT_ID: 'client_test',
        EDITOR_MCP_WORKOS_CLIENT_SECRET: 'secret_test',
        EDITOR_MCP_HTTP_HOST: '127.0.0.1',
        EDITOR_MCP_HTTP_PORT: '0',
        EDITOR_MCP_HTTP_ALLOWED_HOSTS: '127.0.0.1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`HTTP server not ready: ${stderr}`));
      }, 5_000);
      child.stdout.on('data', () => {
        if (stdout.includes('/mcp')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once('error', reject);
    });
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('exit', (code, signal) => {
        resolve({ code, signal });
      });
    });

    try {
      await ready;
      child.kill('SIGTERM');
      await expect(exit).resolves.toEqual({ code: 0, signal: null });
    } finally {
      child.kill('SIGKILL');
      await new Promise<void>((resolve, reject) => {
        metadataServer.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  });
});
