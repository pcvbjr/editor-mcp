import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { spawn } from 'node:child_process';
import { createServer as createNodeServer, type AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import { createHttpApp } from '../../src/http/app.js';
import { createHttpServerConfig } from '../../src/http/config.js';
import { createHttpServerRuntime } from '../../src/http/runtime.js';
import type { InternalErrorReporter } from '../../src/diagnostics.js';
import { registerProbeTool } from '../support/register-probe-tool.js';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const compiledHttpCli = fileURLToPath(new URL('../../dist/http/cli.js', import.meta.url));

async function runCompiledHttpCliToExit(
  environment: Record<string, string>,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string; stdout: string }> {
  const child = spawn(process.execPath, [compiledHttpCli], {
    cwd: repositoryRoot,
    env: { ...process.env, ...environment },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  let stdout = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`compiled HTTP binary did not exit: ${stderr}`));
    }, 5_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr, stdout });
    });
  });
}

describe('Streamable HTTP MCP integration', () => {
  it('completes a real SDK handshake and keeps capabilities per request', async () => {
    let registrations = 0;
    const config = createHttpServerConfig({ port: 0 });
    const app = createHttpApp({
      config,
      register: (server) => {
        registrations += 1;
        registerProbeTool(server, () => undefined);
      },
    });
    const runtime = createHttpServerRuntime(app, config);
    const address = await runtime.start();
    const clients = [
      new Client({ name: 'streamable-http-client-a', version: '1.0.0' }),
      new Client({ name: 'streamable-http-client-b', version: '1.0.0' }),
    ];

    try {
      await Promise.all(
        clients.map((client) =>
          client.connect(
            // The SDK's published Transport declaration predates exactOptionalPropertyTypes.
            new StreamableHTTPClientTransport(
              new URL(`http://127.0.0.1:${String(address.port)}/mcp`),
            ) as Transport,
          ),
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
        ).toMatchObject({
          content: [{ type: 'text', text: '{"echo":"hello"}' }],
        });
      }
      expect(registrations).toBeGreaterThan(2);
    } finally {
      await Promise.all(
        clients.map(async (client) => {
          await client.close();
        }),
      );
      await runtime.close();
    }
  });

  it('binds with Node IPv6 syntax and accepts bracketed IPv6 Host authority', async () => {
    const config = createHttpServerConfig({
      host: '::1',
      port: 0,
      allowedHosts: ['[::1]'],
    });
    const runtime = createHttpServerRuntime(createHttpApp({ config }), config);
    const address = await runtime.start();
    const client = new Client({ name: 'ipv6-http-client', version: '1.0.0' });

    try {
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://[::1]:${String(address.port)}/mcp`),
        ) as Transport,
      );
      expect(client.getServerVersion()).toMatchObject({ name: '@editor-mcp/mcp-server' });
    } finally {
      await client.close();
      await runtime.close();
    }
  });

  it('never returns raw tool exceptions over HTTP', async () => {
    const reportError = vi.fn<InternalErrorReporter>();
    const config = createHttpServerConfig({ port: 0 });
    const app = createHttpApp({
      config,
      reportError,
      register: (server) => {
        server.registerTool('test.secret-error', {}, () => {
          throw new Error('TOP_SECRET_HTTP_INTERNAL');
        });
      },
    });
    const runtime = createHttpServerRuntime(app, config);
    const address = await runtime.start();
    const client = new Client({ name: 'safe-error-http-client', version: '1.0.0' });

    try {
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${String(address.port)}/mcp`),
        ) as Transport,
      );
      const result = await client.callTool({ name: 'test.secret-error' });
      expect(result).toMatchObject({
        content: [{ type: 'text', text: 'Tool execution failed' }],
        isError: true,
      });
      expect(JSON.stringify(result)).not.toContain('TOP_SECRET_HTTP_INTERNAL');
      expect(reportError.mock.calls[0]?.[0]).toEqual({
        phase: 'tool',
        operation: 'test.secret-error',
        error: new Error('TOP_SECRET_HTTP_INTERNAL'),
      });
    } finally {
      await client.close();
      await runtime.close();
    }
  });

  it('drains an active tool request before listener shutdown completes', async () => {
    let markStarted: (() => void) | undefined;
    let finishTool: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const toolGate = new Promise<void>((resolve) => {
      finishTool = resolve;
    });
    const config = createHttpServerConfig({ port: 0 });
    const app = createHttpApp({
      config,
      register: (server) => {
        server.registerTool('test.slow', {}, async () => {
          markStarted?.();
          await toolGate;
          return { content: [{ type: 'text' as const, text: 'finished' }] };
        });
      },
    });
    const runtime = createHttpServerRuntime(app, config);
    const address = await runtime.start();
    const client = new Client({ name: 'drain-http-client', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${String(address.port)}/mcp`),
      ) as Transport,
    );

    try {
      const call = client.callTool({ name: 'test.slow' });
      await started;
      const close = runtime.close();
      let closeSettled = false;
      void close.then(
        () => {
          closeSettled = true;
        },
        () => {
          closeSettled = true;
        },
      );
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(closeSettled).toBe(false);

      finishTool?.();
      await expect(call).resolves.toMatchObject({
        content: [{ type: 'text', text: 'finished' }],
      });
      await expect(close).resolves.toBeUndefined();
    } finally {
      finishTool?.();
      await client.close();
      await runtime.close().catch(() => undefined);
    }
  });

  it('starts the compiled HTTP binary and exits cleanly on SIGTERM', async () => {
    const child = spawn(process.execPath, [compiledHttpCli], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        EDITOR_MCP_HTTP_HOST: '127.0.0.1',
        EDITOR_MCP_HTTP_PORT: '0',
        EDITOR_MCP_HTTP_ALLOWED_HOSTS: '127.0.0.1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    const ready = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('HTTP server did not become ready'));
      }, 5_000);
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
        const match = /MCP HTTP server listening at (http:\/\/[^/]+)\/mcp/u.exec(stderr);
        if (match?.[1] !== undefined) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('exit', (code, signal) => {
        resolve({ code, signal });
      });
    });
    const client = new Client({ name: 'compiled-http-client', version: '1.0.0' });

    try {
      const baseUrl = await ready;
      // The SDK's published Transport declaration predates exactOptionalPropertyTypes.
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)) as Transport,
      );
      expect(client.getServerCapabilities()?.tools).toBeUndefined();
    } finally {
      await client.close();
      child.kill('SIGTERM');
    }

    await expect(exit).resolves.toEqual({ code: 0, signal: null });
    expect(stdout).toBe('');
    expect(stderr).toContain('/mcp');
  });

  it('exits cleanly with concise diagnostics for invalid configuration', async () => {
    const result = await runCompiledHttpCliToExit({ EDITOR_MCP_HTTP_PORT: '' });

    expect(result.code).toBe(1);
    expect(result.signal).toBeNull();
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('MCP HTTP server failed to initialize:');
    expect(result.stderr).not.toContain('\n    at ');
  });

  it('closes and exits after a real address-in-use startup failure', async () => {
    const blocker = createNodeServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(0, '127.0.0.1', resolve);
    });
    const blockedAddress = blocker.address() as AddressInfo;

    try {
      const result = await runCompiledHttpCliToExit({
        EDITOR_MCP_HTTP_HOST: '127.0.0.1',
        EDITOR_MCP_HTTP_PORT: String(blockedAddress.port),
        EDITOR_MCP_HTTP_ALLOWED_HOSTS: '127.0.0.1',
      });

      expect(result.code).toBe(1);
      expect(result.signal).toBeNull();
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('MCP HTTP server failed to start:');
      expect(result.stderr).toContain('EADDRINUSE');
      expect(result.stderr).not.toContain('\n    at ');
    } finally {
      await new Promise<void>((resolve, reject) => {
        blocker.close((error) => {
          if (error !== undefined) reject(error);
          else resolve();
        });
      });
    }
  });
});
