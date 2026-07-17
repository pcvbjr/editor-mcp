import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';

import { createMcpServer, type CapabilityRegistrar } from '../../src/server.js';
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
});
