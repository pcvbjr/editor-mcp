import { PassThrough } from 'node:stream';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DomainError,
  type ApplyEditsResult,
  type AuthorizationContext,
  type DocumentReadResultV1,
} from '@editor-mcp/core';

import {
  APPLY_TOOL_NAME,
  READ_TOOL_NAME,
  createEditorMcpServer,
  runStdioServer,
  type McpEditorService,
} from '../../src/index.js';

const authorization: AuthorizationContext = {
  tenantId: 'tenant-1',
  principalId: 'agent-1',
  principalType: 'agent',
  permissions: new Set(['documents:read', 'documents:write']),
  traceId: 'trace-1',
};

const readResult: DocumentReadResultV1 = {
  protocolVersion: 1,
  tenantId: 'tenant-1',
  documentId: 'doc-1',
  documentIncarnation: 'inc-1',
  collaborationField: 'default',
  revision: 'rev-1',
  schemaId: 'editor-mcp/mvp',
  schemaVersion: 1,
  capabilities: {
    reviewModes: ['direct', 'suggest'],
    operations: ['replace_block'],
    representationProfiles: ['agent-html/v1'],
  },
  representation: {
    profile: 'agent-html/v1',
    html: '<p>Hello</p>',
  },
  blocks: [],
  truncated: false,
};

const applyResult: ApplyEditsResult = {
  protocolVersion: 1,
  tenantId: 'tenant-1',
  status: 'applied',
  documentId: 'doc-1',
  documentIncarnation: 'inc-1',
  collaborationField: 'default',
  schemaId: 'editor-mcp/mvp',
  schemaVersion: 1,
  beforeRevision: 'rev-1',
  committedRevision: 'rev-2',
  idempotentReplay: false,
  createdBlockIds: [],
  affectedBlockIds: [],
  generatedChangeIds: [],
  operationResults: [
    {
      operationId: 'op-1',
      status: 'applied',
      affectedBlockIds: [],
      createdBlockIds: [],
      generatedChangeIds: [],
    },
  ],
  acknowledgement: {
    protocolVersion: 1,
    level: 'document_and_audit',
    idempotencyReceiptDurable: true,
    documentStateDurable: true,
    auditDurableOrQueued: true,
    acknowledgedAt: '2026-07-17T00:00:00.000Z',
    persistenceRevision: 'rev-2',
  },
  conflicts: [],
};

const clients: Client[] = [];

function resourceText(
  content: { readonly text: string } | { readonly blob: string } | undefined,
): string {
  return content !== undefined && 'text' in content ? content.text : '{}';
}

async function connect(service: McpEditorService): Promise<Client> {
  const server = createEditorMcpServer({
    service,
    authorization: async () => authorization,
  });
  const client = new Client({ name: 'editor-mcp-test', version: '0.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  clients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map(async (client) => client.close()));
});

describe('local MCP adapter', () => {
  it('registers the exact versioned tools', async () => {
    const client = await connect({
      readDocumentV1: async () => readResult,
      applyEdits: async () => applyResult,
    });
    const tools = await client.listTools();
    expect(tools.tools.map(({ name }) => name)).toEqual([READ_TOOL_NAME, APPLY_TOOL_NAME]);
    expect(tools.tools.every(({ outputSchema }) => outputSchema !== undefined)).toBe(true);
  });

  it('fails closed when the domain returns an invalid tool result', async () => {
    const client = await connect({
      readDocumentV1: async () =>
        ({
          ...readResult,
          schemaVersion: 2,
        }) as unknown as DocumentReadResultV1,
      applyEdits: async () => applyResult,
    });
    const result = await client.callTool({
      name: READ_TOOL_NAME,
      arguments: {
        protocolVersion: 1,
        tenantId: 'tenant-1',
        documentId: 'doc-1',
        documentIncarnation: 'inc-1',
        collaborationField: 'default',
        schemaId: 'editor-mcp/mvp',
        schemaVersion: 1,
        selection: { kind: 'document' },
        representationProfile: 'agent-html/v1',
      },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: 'INTERNAL', retryable: false },
    });
  });

  it('maps a read call one-to-one to the core', async () => {
    const readDocumentV1 = vi.fn(async () => readResult);
    const client = await connect({
      readDocumentV1,
      applyEdits: async () => applyResult,
    });
    const result = await client.callTool({
      name: READ_TOOL_NAME,
      arguments: {
        protocolVersion: 1,
        tenantId: 'tenant-1',
        documentId: 'doc-1',
        documentIncarnation: 'inc-1',
        collaborationField: 'default',
        schemaId: 'editor-mcp/mvp',
        schemaVersion: 1,
        selection: { kind: 'document' },
        representationProfile: 'agent-html/v1',
        maxBytes: 20_000,
      },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      documentId: 'doc-1',
      revision: 'rev-1',
    });
    expect(readDocumentV1).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: 'doc-1', maxBytes: 20_000 }),
      expect.objectContaining({ authorization }),
    );
  });

  it('returns concise structured apply results without a document echo', async () => {
    const applyEdits = vi.fn(async () => applyResult);
    const client = await connect({
      readDocumentV1: async () => readResult,
      applyEdits,
    });
    const result = await client.callTool({
      name: APPLY_TOOL_NAME,
      arguments: {
        protocolVersion: 1,
        tenantId: 'tenant-1',
        documentId: 'doc-1',
        documentIncarnation: 'inc-1',
        collaborationField: 'default',
        schemaId: 'editor-mcp/mvp',
        schemaVersion: 1,
        idempotencyKey: 'idem-12345678',
        readRevision: 'rev-1',
        atomic: true,
        changeMode: 'suggest',
        operations: [
          {
            operationId: 'op-1',
            kind: 'delete_block',
            blockId: '550e8400-e29b-41d4-a716-446655440000',
            expectedBlockDigest: `sha256:${'a'.repeat(64)}`,
          },
        ],
      },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      status: 'applied',
      committedRevision: 'rev-2',
    });
    expect(result.structuredContent).not.toHaveProperty('html');
    expect(applyEdits).toHaveBeenCalledOnce();
  });

  it('rejects direct mutations for agent principals before invoking the service', async () => {
    const applyEdits = vi.fn(async () => applyResult);
    const client = await connect({
      readDocumentV1: async () => readResult,
      applyEdits,
    });
    const result = await client.callTool({
      name: APPLY_TOOL_NAME,
      arguments: {
        protocolVersion: 1,
        tenantId: 'tenant-1',
        documentId: 'doc-1',
        documentIncarnation: 'inc-1',
        collaborationField: 'default',
        schemaId: 'editor-mcp/mvp',
        schemaVersion: 1,
        idempotencyKey: 'idem-direct-agent',
        readRevision: 'rev-1',
        atomic: true,
        changeMode: 'direct',
        operations: [
          {
            operationId: 'op-direct-agent',
            kind: 'delete_block',
            blockId: '550e8400-e29b-41d4-a716-446655440000',
            expectedBlockDigest: `sha256:${'a'.repeat(64)}`,
          },
        ],
      },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: 'PERMISSION_DENIED',
        message: 'Agent principals may only submit suggested edits',
      },
    });
    expect(applyEdits).not.toHaveBeenCalled();
  });

  it('maps domain failures to MCP error results', async () => {
    const client = await connect({
      readDocumentV1: async () => {
        throw new DomainError('TARGET_CHANGED', 'Target changed', false);
      },
      applyEdits: async () => applyResult,
    });
    const result = await client.callTool({
      name: READ_TOOL_NAME,
      arguments: {
        protocolVersion: 1,
        tenantId: 'tenant-1',
        documentId: 'doc-1',
        documentIncarnation: 'inc-1',
        collaborationField: 'default',
        schemaId: 'editor-mcp/mvp',
        schemaVersion: 1,
        selection: { kind: 'document' },
        representationProfile: 'agent-html/v1',
      },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: 'TARGET_CHANGED', retryable: false },
    });
  });

  it('serves bounded block resources and enforces tenant isolation', async () => {
    const readDocumentV1 = vi.fn(async () => readResult);
    const client = await connect({
      readDocumentV1,
      applyEdits: async () => applyResult,
    });
    const blockId = '550e8400-e29b-41d4-a716-446655440000';
    const resource = await client.readResource({
      uri: `editor://tenants/tenant-1/documents/doc-1/incarnations/inc-1/blocks/${blockId}`,
    });
    expect(JSON.parse(resourceText(resource.contents[0]))).toMatchObject({
      documentId: 'doc-1',
    });
    expect(readDocumentV1).toHaveBeenCalledWith(
      expect.objectContaining({
        selection: { kind: 'blocks', blockIds: [blockId] },
        maxBytes: 128_000,
      }),
      expect.anything(),
    );

    const denied = await client.readResource({
      uri: `editor://tenants/tenant-2/documents/doc-1/incarnations/inc-1/blocks/${blockId}`,
    });
    expect(JSON.parse(resourceText(denied.contents[0]))).toMatchObject({
      error: { code: 'PERMISSION_DENIED' },
    });
  });

  it('serves a bounded outline resource and maps resource failures', async () => {
    const readDocumentV1 = vi.fn(async () => readResult);
    const client = await connect({
      readDocumentV1,
      applyEdits: async () => applyResult,
    });
    const outline = await client.readResource({
      uri: 'editor://tenants/tenant-1/documents/doc-1/incarnations/inc-1/outline',
    });
    expect(JSON.parse(resourceText(outline.contents[0]))).toMatchObject({
      documentId: 'doc-1',
    });
    expect(readDocumentV1).toHaveBeenCalledWith(
      expect.objectContaining({
        representationProfile: 'outline/v1',
        selection: { kind: 'document' },
        maxBytes: 128_000,
      }),
      expect.anything(),
    );

    const denied = await client.readResource({
      uri: 'editor://tenants/tenant-2/documents/doc-1/incarnations/inc-1/outline',
    });
    expect(JSON.parse(resourceText(denied.contents[0]))).toMatchObject({
      error: { code: 'PERMISSION_DENIED' },
    });
  });

  it('maps apply failures and creates a stdio transport', async () => {
    const client = await connect({
      readDocumentV1: async () => readResult,
      applyEdits: async () => {
        throw new DomainError('TARGET_CHANGED', 'Target changed', false);
      },
    });
    const failure = await client.callTool({
      name: APPLY_TOOL_NAME,
      arguments: {
        protocolVersion: 1,
        tenantId: 'tenant-1',
        documentId: 'doc-1',
        documentIncarnation: 'inc-1',
        collaborationField: 'default',
        schemaId: 'editor-mcp/mvp',
        schemaVersion: 1,
        idempotencyKey: 'idem-12345678',
        readRevision: 'rev-1',
        atomic: true,
        changeMode: 'suggest',
        operations: [
          {
            operationId: 'op-1',
            kind: 'delete_block',
            blockId: '550e8400-e29b-41d4-a716-446655440000',
            expectedBlockDigest: `sha256:${'a'.repeat(64)}`,
          },
        ],
      },
    });
    expect(failure.isError).toBe(true);

    const connectServer = vi.fn(() => Promise.resolve());
    const transport = await runStdioServer({ connect: connectServer } as unknown as McpServer, {
      input: new PassThrough(),
      output: new PassThrough(),
    });
    expect(connectServer).toHaveBeenCalledWith(transport);
  });
});
