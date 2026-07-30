import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

import express, { type Request, type Response } from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import { mvpSchema } from '@editor-mcp/adapter-tiptap-hocuspocus';
import {
  EditorService,
  MemoryAuditSink,
  MemoryIdempotencyLedger,
  PermissionAuthorizationPolicy,
  toErrorEnvelope,
  type AuthorizationContext,
  type DocumentIdentity,
} from '@editor-mcp/core';
import { TiptapDocumentService } from '@editor-mcp/document-service';
import {
  APPLY_TOOL_NAME,
  CREATE_TOOL_NAME,
  READ_TOOL_NAME,
  createEditorMcpServer,
} from '@editor-mcp/mcp-server';
import {
  applyEditsResultSchema,
  createDocumentResultV1Schema,
  documentIdentitySchema,
  documentReadResultV1Schema,
} from '@editor-mcp/protocol';
import { createReferenceServer } from '@editor-mcp/reference-server';
import {
  HocuspocusRuntime,
  MemoryYjsPersistence,
  ProseMirrorYjsDocumentCodec,
  documentNameFor,
} from '@editor-mcp/runtime-hocuspocus';

const apiHost = process.env['DEMO_HOST'] ?? '127.0.0.1';
const apiPort = parsePort(process.env['DEMO_PORT'], 3030, 'DEMO_PORT');
const collaborationPort = parsePort(
  process.env['DEMO_COLLABORATION_PORT'],
  1234,
  'DEMO_COLLABORATION_PORT',
);
const publicOrigin =
  process.env['DEMO_PUBLIC_ORIGIN'] ??
  (process.env['NODE_ENV'] === 'production'
    ? `http://${apiHost}:${String(apiPort)}`
    : 'http://127.0.0.1:5173');
const collaborationUrl =
  process.env['DEMO_COLLABORATION_URL'] ?? `ws://${apiHost}:${String(collaborationPort)}`;

function parsePort(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new TypeError(`${name} must be an integer between 1 and 65535`);
  }
  return parsed;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function agentDraft(message: string, initial: boolean): string {
  const prompt = escapeHtml(message.trim());
  if (!initial) {
    return `<h2>Agent revision</h2><p>${prompt}</p>`;
  }
  return [
    '<h1>Collaborative working brief</h1>',
    `<p>This document was created from the request: <strong>${prompt}</strong></p>`,
    '<h2>Purpose</h2>',
    '<p>Create a shared working surface where a person and an agent can develop the document together while the person remains in control.</p>',
    '<h2>Working principles</h2>',
    '<ul><li><p>Agent contributions arrive as reviewable suggestions.</p></li><li><p>Human edits are collaborative and immediately visible.</p></li><li><p>Accepted state is durable and safe to reload.</p></li></ul>',
    '<h2>Open questions</h2>',
    '<p>What should we sharpen, remove, or expand next?</p>',
  ].join('');
}

function structuredToolContent(result: unknown): unknown {
  if (
    typeof result !== 'object' ||
    result === null ||
    !('structuredContent' in result) ||
    result.structuredContent === undefined
  ) {
    const content =
      typeof result === 'object' && result !== null && 'content' in result
        ? result.content
        : result;
    throw new Error(`MCP tool failed: ${JSON.stringify(content)}`);
  }
  return result.structuredContent;
}

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
  editorUrl: (identity) =>
    `${publicOrigin}/documents/${encodeURIComponent(identity.documentId)}?incarnation=${encodeURIComponent(identity.documentIncarnation)}`,
});

const humanAuthorization: AuthorizationContext = {
  tenantId: 'demo',
  principalId: 'demo-human',
  principalType: 'human',
  permissions: new Set([
    'documents:create',
    'documents:read',
    'documents:write',
    'suggestions:review',
  ]),
  traceId: 'demo-human-session',
};
const agentAuthorization: AuthorizationContext = {
  tenantId: 'demo',
  principalId: 'demo-agent',
  principalType: 'agent',
  permissions: new Set(['documents:create', 'documents:read', 'documents:suggest']),
  agentRunId: 'demo-agent-run',
  traceId: 'demo-agent-session',
};

const reference = createReferenceServer({
  service: editor,
  authenticate: ({ authorizationHeader }) =>
    Promise.resolve(authorizationHeader === 'Bearer demo-human' ? humanAuthorization : undefined),
});

async function createDemoMcpClient(): Promise<{
  client: Client;
  close(): Promise<void>;
}> {
  const server = createEditorMcpServer({
    service: editor,
    authorization: () => Promise.resolve(agentAuthorization),
    name: 'editor-mcp-demo',
    version: '0.0.0',
  });
  const client = new Client({ name: 'editor-mcp-demo-chat', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

const demoMcp = await createDemoMcpClient();
const app = express();
app.disable('x-powered-by');

app.use((request, response, next) => {
  if (request.url === '/healthz' || request.url.startsWith('/v1/')) {
    void reference.requestHandler(request, response);
    return;
  }
  next();
});

app.use(express.json({ limit: '1mb' }));

app.post('/mcp', async (request: Request, response: Response) => {
  const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
  const server = createEditorMcpServer({
    service: editor,
    authorization: () => Promise.resolve(agentAuthorization),
    name: 'editor-mcp-demo',
    version: '0.0.0',
  });
  try {
    await server.connect(transport as Transport);
    await transport.handleRequest(request, response, request.body);
  } catch (error) {
    if (!response.headersSent) {
      response.status(500).json(toErrorEnvelope(error));
    }
  } finally {
    await Promise.allSettled([transport.close(), server.close()]);
  }
});

app.get('/api/documents/:documentId/session', async (request: Request, response: Response) => {
  const incarnation =
    typeof request.query['incarnation'] === 'string' ? request.query['incarnation'] : '';
  const parsed = documentIdentitySchema.safeParse({
    tenantId: 'demo',
    documentId: request.params['documentId'],
    documentIncarnation: incarnation,
    collaborationField: 'default',
    schemaId: 'editor-mcp/mvp',
    schemaVersion: 1,
  });
  if (!parsed.success) {
    response.status(400).json({ error: 'Invalid document identity' });
    return;
  }
  try {
    const read = await editor.readDocumentV1(
      {
        protocolVersion: 1,
        ...parsed.data,
        selection: { kind: 'document' },
        representationProfile: 'outline/v1',
      },
      { authorization: humanAuthorization },
    );
    response.json({
      identity: parsed.data,
      revision: read.revision,
      documentName: documentNameFor(parsed.data),
      collaborationUrl,
    });
  } catch (error) {
    response.status(404).json(toErrorEnvelope(error));
  }
});

app.post('/api/chat', async (request: Request, response: Response) => {
  const message =
    typeof request.body === 'object' &&
    request.body !== null &&
    typeof (request.body as Record<string, unknown>)['message'] === 'string'
      ? String((request.body as Record<string, unknown>)['message']).trim()
      : '';
  if (message.length === 0 || message.length > 10_000) {
    response.status(400).json({ error: 'A message between 1 and 10000 characters is required' });
    return;
  }

  try {
    const candidate =
      typeof request.body === 'object' && request.body !== null
        ? (request.body as Record<string, unknown>)['document']
        : undefined;
    let identity: DocumentIdentity;
    let editorUrl: string;
    let initial = false;
    const parsedIdentity = documentIdentitySchema.safeParse(candidate);
    if (parsedIdentity.success) {
      identity = parsedIdentity.data;
      editorUrl = `${publicOrigin}/documents/${encodeURIComponent(identity.documentId)}?incarnation=${encodeURIComponent(identity.documentIncarnation)}`;
    } else {
      initial = true;
      const created = createDocumentResultV1Schema.parse(
        structuredToolContent(
          await demoMcp.client.callTool({
            name: CREATE_TOOL_NAME,
            arguments: {
              protocolVersion: 1,
              tenantId: 'demo',
              collaborationField: 'default',
              schemaId: 'editor-mcp/mvp',
              schemaVersion: 1,
              idempotencyKey: `demo-create-${randomUUID()}`,
            },
          }),
        ),
      );
      identity = documentIdentitySchema.parse({
        tenantId: created.tenantId,
        documentId: created.documentId,
        documentIncarnation: created.documentIncarnation,
        collaborationField: created.collaborationField,
        schemaId: created.schemaId,
        schemaVersion: created.schemaVersion,
      });
      editorUrl = created.editorUrl;
    }

    const read = documentReadResultV1Schema.parse(
      structuredToolContent(
        await demoMcp.client.callTool({
          name: READ_TOOL_NAME,
          arguments: {
            protocolVersion: 1,
            ...identity,
            selection: { kind: 'document' },
            representationProfile: 'agent-html/v1',
          },
        }),
      ),
    );
    const anchor = read.blocks.at(-1);
    if (anchor === undefined) {
      throw new Error('The document has no addressable block');
    }
    const applied = applyEditsResultSchema.parse(
      structuredToolContent(
        await demoMcp.client.callTool({
          name: APPLY_TOOL_NAME,
          arguments: {
            protocolVersion: 1,
            ...identity,
            idempotencyKey: `demo-edit-${randomUUID()}`,
            readRevision: read.revision,
            atomic: true,
            changeMode: 'suggest',
            operations: [
              {
                operationId: `op-${randomUUID()}`,
                kind: 'insert_after',
                anchorBlockId: anchor.id,
                expectedAnchorDigest: anchor.contentDigest,
                html: agentDraft(message, initial),
              },
            ],
          },
        }),
      ),
    );
    const session = {
      identity,
      documentName: documentNameFor(identity),
      collaborationUrl,
    };
    response.json({
      message: initial
        ? 'I created a collaborative document and added the first draft as a suggestion.'
        : 'I reread the live document and added a new tracked suggestion.',
      editorUrl,
      session,
      result: applied,
    });
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : 'Unknown chat error'}\n`,
    );
    response.status(400).json(toErrorEnvelope(error));
  }
});

const clientDirectory = fileURLToPath(new URL('../client', import.meta.url));
if (existsSync(clientDirectory)) {
  app.use(express.static(clientDirectory));
  app.use((request, response, next) => {
    if (request.method === 'GET' && request.accepts('html')) {
      response.sendFile(fileURLToPath(new URL('../client/index.html', import.meta.url)));
      return;
    }
    next();
  });
}

const collaborationServer = runtime.createCollaborationServer({
  address: apiHost,
  port: collaborationPort,
  quiet: true,
  websocketOptions: { maxPayload: 1_000_000 },
});
await collaborationServer.listen(collaborationPort);

const apiServer = createServer(app);
await new Promise<void>((resolve) => apiServer.listen(apiPort, apiHost, resolve));
process.stdout.write(`Editor MCP demo: ${publicOrigin}\n`);
process.stdout.write(`Local MCP endpoint: http://${apiHost}:${String(apiPort)}/mcp\n`);

let shuttingDown = false;
const shutdown = async (): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.allSettled([
    new Promise<void>((resolve, reject) => {
      apiServer.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    }),
    collaborationServer.destroy(),
    demoMcp.close(),
  ]);
};

process.once('SIGINT', () => {
  void shutdown().finally(() => process.exit(0));
});
process.once('SIGTERM', () => {
  void shutdown().finally(() => process.exit(0));
});
