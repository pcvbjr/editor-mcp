import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';

import { mvpSchema, type ProseMirrorNodeJson } from '@editor-mcp/adapter-tiptap-hocuspocus';
import {
  EditorService,
  MemoryAuditSink,
  MemoryIdempotencyLedger,
  PermissionAuthorizationPolicy,
  type AuthorizationContext,
  type DocumentIdentity,
} from '@editor-mcp/core';
import { TiptapDocumentService } from '@editor-mcp/document-service';
import {
  applyEditsResultSchema,
  createDocumentResultV1Schema,
  documentReadResultV1Schema,
} from '@editor-mcp/protocol';
import {
  HocuspocusRuntime,
  MemoryYjsPersistence,
  ProseMirrorYjsDocumentCodec,
} from '@editor-mcp/runtime-hocuspocus';

import {
  APPLY_TOOL_NAME,
  CREATE_TOOL_NAME,
  READ_TOOL_NAME,
  createEditorMcpServer,
} from '../../src/index.js';

const blockId = '00000000-0000-4000-8000-000000000001';
const identity: DocumentIdentity = {
  tenantId: 'tenant-1',
  documentId: 'doc-1',
  documentIncarnation: 'inc-1',
  collaborationField: 'default',
  schemaId: 'editor-mcp/mvp',
  schemaVersion: 1,
};
const authorization: AuthorizationContext = {
  tenantId: identity.tenantId,
  principalId: 'agent-1',
  principalType: 'agent',
  permissions: new Set(['documents:create', 'documents:read', 'documents:suggest']),
  agentRunId: 'run-1',
  traceId: 'trace-1',
};
const document: ProseMirrorNodeJson = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      attrs: { blockId, diffChangeId: null, diffChangeKind: null },
      content: [{ type: 'text', text: 'Before' }],
    },
  ],
};

describe('editor MCP vertical slice', () => {
  it('commits a suggested text replacement through the MCP tool boundary', async () => {
    const persistence = new MemoryYjsPersistence();
    const runtime = new HocuspocusRuntime({
      persistence,
      documentCodec: new ProseMirrorYjsDocumentCodec(mvpSchema),
    });
    const documents = new TiptapDocumentService({ runtime });
    const editor = new EditorService({
      documents,
      authorization: new PermissionAuthorizationPolicy(),
      idempotency: new MemoryIdempotencyLedger(),
      audit: new MemoryAuditSink(),
    });
    await documents.seed({ identity, document });

    const authInfo = {
      token: 'test-token',
      clientId: 'test-client',
      scopes: ['documents:read', 'documents:suggest'],
    };
    const server = createEditorMcpServer({
      service: editor,
      authorization: async (_signal, receivedAuthInfo) => {
        expect(receivedAuthInfo).toBe(authInfo);
        return authorization;
      },
    });
    const client = new Client({ name: 'editor-integration-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const send = clientTransport.send.bind(clientTransport);
    clientTransport.send = (message, options) =>
      send(message, {
        ...options,
        authInfo,
      });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const created = createDocumentResultV1Schema.parse(
        (
          await client.callTool({
            name: CREATE_TOOL_NAME,
            arguments: {
              protocolVersion: 1,
              tenantId: identity.tenantId,
              collaborationField: 'default',
              schemaId: 'editor-mcp/mvp',
              schemaVersion: 1,
              idempotencyKey: 'mcp-create-integration',
            },
          })
        ).structuredContent,
      );
      expect(created).toMatchObject({
        status: 'created',
        tenantId: identity.tenantId,
      });
      expect(created.editorUrl).toContain(created.documentId);

      const readRequest = {
        protocolVersion: 1 as const,
        ...identity,
        selection: { kind: 'document' as const },
        representationProfile: 'agent-html/v1' as const,
      };
      const before = documentReadResultV1Schema.parse(
        (await client.callTool({ name: READ_TOOL_NAME, arguments: readRequest })).structuredContent,
      );
      const digest = before.blocks.find(({ id }) => id === blockId)?.contentDigest;
      if (digest === undefined) throw new Error('Seeded block digest is missing');

      const applied = applyEditsResultSchema.parse(
        (
          await client.callTool({
            name: APPLY_TOOL_NAME,
            arguments: {
              protocolVersion: 1,
              ...identity,
              idempotencyKey: 'mcp-editor-integration',
              readRevision: before.revision,
              atomic: true,
              changeMode: 'suggest',
              suggestionGroupName: 'Rewrite opening line',
              operations: [
                {
                  operationId: 'replace-text-1',
                  kind: 'replace_text',
                  blockId,
                  expectedBlockDigest: digest,
                  range: { from: 0, to: 6 },
                  text: 'After',
                },
              ],
            },
          })
        ).structuredContent,
      );
      expect(applied).toMatchObject({
        status: 'applied',
        affectedBlockIds: [blockId],
        acknowledgement: { level: 'document_and_audit' },
      });
      expect(applied.generatedChangeIds).toHaveLength(1);

      const after = documentReadResultV1Schema.parse(
        (await client.callTool({ name: READ_TOOL_NAME, arguments: readRequest })).structuredContent,
      );
      if (after.representation.profile !== 'agent-html/v1') {
        throw new Error('Unexpected read representation');
      }
      expect(after.revision).toBe(applied.committedRevision);
      expect(after.representation.html).toContain('data-diff-change-kind="delete">Before');
      expect(after.representation.html).toContain('data-diff-change-kind="insert">After');
      expect(after.representation.html).toContain(applied.generatedChangeIds[0]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
