import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode, UrlElicitationRequiredError } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';

import { createMcpServer, type CapabilityRegistrar } from '../../src/server.js';
import type { InternalErrorReporter } from '../../src/diagnostics.js';
import { registerProbeTool } from '../support/register-probe-tool.js';

const serverInfo = {
  name: '@editor-mcp/mcp-server-test',
  version: '1.2.3-test',
} as const;

describe('MCP server factory', () => {
  it('constructs an unconnected server without performing I/O', () => {
    const server = createMcpServer(serverInfo);

    expect(server.isConnected()).toBe(false);
  });

  it('negotiates metadata without advertising product capabilities', async () => {
    const server = createMcpServer(serverInfo);
    const client = new Client({ name: 'contract-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      expect(client.getServerVersion()).toMatchObject(serverInfo);
      expect(client.getServerCapabilities()?.tools).toBeUndefined();
      expect(client.getServerCapabilities()?.resources).toBeUndefined();
      expect(client.getServerCapabilities()?.prompts).toBeUndefined();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('registers the internal test capability once and returns SDK validation errors', async () => {
    let registrationCount = 0;
    let handlerCallCount = 0;
    const register: CapabilityRegistrar = (server) => {
      registrationCount += 1;
      registerProbeTool(server, () => {
        handlerCallCount += 1;
      });
    };
    const server = createMcpServer({ ...serverInfo, register });
    const client = new Client({ name: 'contract-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      expect(registrationCount).toBe(1);
      await expect(client.listTools()).resolves.toMatchObject({
        tools: [{ name: 'test.probe' }],
      });

      const invalidResult = await client.callTool({
        name: 'test.probe',
        arguments: { message: 'hello', unexpected: true },
      });
      expect(invalidResult.isError).toBe(true);
      expect(handlerCallCount).toBe(0);

      const validResult = await client.callTool({
        name: 'test.probe',
        arguments: { message: 'hello' },
      });
      expect(validResult).toMatchObject({
        content: [{ type: 'text', text: '{"echo":"hello"}' }],
        structuredContent: { echo: 'hello' },
      });
      expect(handlerCallCount).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('maps unexpected tool exceptions to a safe result and reports the internal cause', async () => {
    const reportError = vi.fn<InternalErrorReporter>();
    const server = createMcpServer({
      ...serverInfo,
      reportError,
      register: (registry) => {
        registry.registerTool('test.secret-error', {}, () => {
          throw new Error('TOP_SECRET_INTERNAL');
        });
      },
    });
    const client = new Client({ name: 'contract-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const result = await client.callTool({ name: 'test.secret-error' });
      expect(result).toMatchObject({
        content: [{ type: 'text', text: 'Tool execution failed' }],
        isError: true,
      });
      expect(JSON.stringify(result)).not.toContain('TOP_SECRET_INTERNAL');
      const event = reportError.mock.calls[0]?.[0];
      expect(event).toEqual({
        phase: 'tool',
        operation: 'test.secret-error',
        error: new Error('TOP_SECRET_INTERNAL'),
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('preserves the SDK URL-elicitation control-flow error', async () => {
    const reportError = vi.fn<InternalErrorReporter>();
    const server = createMcpServer({
      ...serverInfo,
      reportError,
      register: (registry) => {
        registry.registerTool('test.url-elicitation', {}, () => {
          throw new UrlElicitationRequiredError([
            {
              mode: 'url',
              message: 'Authentication is required',
              url: 'https://example.com/authorize',
              elicitationId: 'test-elicitation',
            },
          ]);
        });
      },
    });
    const client = new Client({ name: 'contract-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      await expect(client.callTool({ name: 'test.url-elicitation' })).rejects.toMatchObject({
        code: ErrorCode.UrlElicitationRequired,
      });
      expect(reportError).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('exposes only the supported capability registration surface', () => {
    const register = vi.fn<CapabilityRegistrar>();

    createMcpServer({ ...serverInfo, register });

    const registry = register.mock.calls[0]?.[0];
    expect(registry).toBeDefined();
    if (registry === undefined) throw new Error('Capability registry was not provided');
    expect(Object.keys(registry)).toEqual(['registerTool', 'registerResource']);
    expect('tool' in registry).toBe(false);
  });
});
