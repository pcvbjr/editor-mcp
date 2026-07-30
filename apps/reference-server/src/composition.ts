import {
  EditorService,
  PermissionAuthorizationPolicy,
  type AuditSink,
  type AuthorizationPolicy,
  type IdempotencyLedger,
  type OperationPolicy,
} from '@editor-mcp/core';
import { TiptapDocumentService } from '@editor-mcp/document-service';
import { mvpSchema } from '@editor-mcp/adapter-tiptap-hocuspocus';
import {
  DurableYjsAuditSink,
  DurableYjsIdempotencyLedger,
  HocuspocusRuntime,
  ProseMirrorYjsDocumentCodec,
  type YjsPersistence,
} from '@editor-mcp/runtime-hocuspocus';

import { createReferenceServer, type Authenticator, type ReferenceServer } from './index.js';

export interface ReferenceStackOptions {
  readonly persistence: YjsPersistence;
  readonly authenticate: Authenticator;
  readonly authorizationPolicy?: AuthorizationPolicy;
  readonly operationPolicy?: OperationPolicy;
  readonly idempotency?: IdempotencyLedger;
  readonly audit?: AuditSink;
  readonly maxBodyBytes?: number;
  readonly requestTimeoutMs?: number;
}

export interface ReferenceStack {
  readonly runtime: HocuspocusRuntime;
  readonly documents: TiptapDocumentService;
  readonly editor: EditorService;
  readonly http: ReferenceServer;
}

/**
 * Production composition root for the vertical slice. The same durable store
 * owns Yjs document snapshots, idempotency receipts, and append-only audit
 * events; transports remain thin wrappers around one EditorService instance.
 */
export function createReferenceStack(options: ReferenceStackOptions): ReferenceStack {
  const runtime = new HocuspocusRuntime({
    persistence: options.persistence,
    documentCodec: new ProseMirrorYjsDocumentCodec(mvpSchema),
  });
  const documents = new TiptapDocumentService({ runtime });
  const editor = new EditorService({
    documents,
    authorization: options.authorizationPolicy ?? new PermissionAuthorizationPolicy(),
    ...(options.operationPolicy === undefined ? {} : { operationPolicy: options.operationPolicy }),
    idempotency:
      options.idempotency ??
      new DurableYjsIdempotencyLedger({
        persistence: options.persistence,
      }),
    audit: options.audit ?? new DurableYjsAuditSink({ persistence: options.persistence }),
  });
  const http = createReferenceServer({
    service: editor,
    authenticate: options.authenticate,
    ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
  });
  return { runtime, documents, editor, http };
}
