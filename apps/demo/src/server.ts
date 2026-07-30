import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

import express, { type Request, type Response } from 'express';
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
} from '@editor-mcp/core';
import { TiptapDocumentService } from '@editor-mcp/document-service';
import { createEditorMcpServer } from '@editor-mcp/mcp-server';
import { documentIdentitySchema } from '@editor-mcp/protocol';
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
      apiServer.closeAllConnections();
    }),
    collaborationServer.destroy(),
  ]);
};

const requestShutdown = (): void => {
  // A browser may retain a collaboration socket while the local demo is being stopped.
  const forceExit = setTimeout(() => process.exit(0), 1500);
  void shutdown().finally(() => {
    clearTimeout(forceExit);
    process.exit(0);
  });
};

process.once('SIGINT', requestShutdown);
process.once('SIGTERM', requestShutdown);
