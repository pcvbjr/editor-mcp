import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import {
  DomainError,
  assertChangeModeAllowed,
  toErrorEnvelope,
  type ApplyContext,
  type ApplyEditsResult,
  type AuthorizationContext,
  type DocumentReadResultV1,
  type ReadContext,
} from '@editor-mcp/core';
import {
  applyEditsRequestV1Schema,
  applyEditsResultSchema,
  documentReadRequestSchema,
  documentReadResultV1Schema,
  type DocumentReadRequest,
} from '@editor-mcp/protocol';

export interface ReferenceEditorService {
  readDocumentV1(input: unknown, context: ReadContext): Promise<DocumentReadResultV1>;
  applyEdits(input: unknown, context: ApplyContext): Promise<ApplyEditsResult>;
}

export interface AuthenticateInput {
  readonly authorizationHeader: string | undefined;
  readonly method: string;
  readonly pathname: string;
}

export type Authenticator = (input: AuthenticateInput) => Promise<AuthorizationContext | undefined>;

export interface ReferenceServerOptions {
  readonly service: ReferenceEditorService;
  readonly authenticate: Authenticator;
  readonly maxBodyBytes?: number;
  readonly requestTimeoutMs?: number;
}

export interface ReferenceServer {
  readonly server: Server;
  readonly requestHandler: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
}

const DEFAULT_BODY_LIMIT = 1_000_000;
const DEFAULT_TIMEOUT_MS = 10_000;

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

function statusFor(error: DomainError): number {
  switch (error.code) {
    case 'INVALID_REQUEST':
    case 'INVALID_CONTENT':
    case 'UNSUPPORTED_CONTENT':
    case 'PATCH_TOO_LARGE':
      return 400;
    case 'UNAUTHENTICATED':
      return 401;
    case 'PERMISSION_DENIED':
      return 403;
    case 'DOCUMENT_NOT_FOUND':
    case 'TARGET_NOT_FOUND':
      return 404;
    case 'DOCUMENT_INCARNATION_MISMATCH':
    case 'SCHEMA_VERSION_MISMATCH':
    case 'TARGET_AMBIGUOUS':
    case 'TARGET_CHANGED':
    case 'IDEMPOTENCY_MISMATCH':
      return 409;
    case 'DEADLINE_EXCEEDED':
      return 408;
    case 'DOCUMENT_UNAVAILABLE':
      return 503;
    case 'INTERNAL':
      return 500;
  }
}

async function readBody(
  request: IncomingMessage,
  maxBodyBytes: number,
  signal: AbortSignal,
): Promise<unknown> {
  const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim();
  if (contentType !== 'application/json') {
    throw new DomainError('INVALID_REQUEST', 'Content-Type must be application/json', false);
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  let tooLarge = false;
  for await (const incoming of request) {
    if (signal.aborted) {
      throw deadlineError();
    }
    const value: unknown = incoming;
    const chunk =
      typeof value === 'string'
        ? Buffer.from(value)
        : value instanceof Uint8Array
          ? Buffer.from(value)
          : Buffer.from(String(value));
    bytes += chunk.byteLength;
    if (bytes > maxBodyBytes) {
      tooLarge = true;
    } else {
      chunks.push(chunk);
    }
  }
  if (signal.aborted) {
    throw deadlineError();
  }
  if (tooLarge) {
    throw new DomainError(
      'PATCH_TOO_LARGE',
      'The request body exceeds the configured limit',
      false,
      { maxBodyBytes },
    );
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (error) {
    throw new DomainError(
      'INVALID_REQUEST',
      'The request body is not valid JSON',
      false,
      undefined,
      { cause: error },
    );
  }
}

function deadlineError(): DomainError {
  return new DomainError('DEADLINE_EXCEEDED', 'The request deadline elapsed', true);
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    throw deadlineError();
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(deadlineError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(
          error instanceof Error
            ? error
            : new Error('Asynchronous request operation failed', {
                cause: error,
              }),
        );
      },
    );
  });
}

function parseDocumentPath(
  pathname: string,
): { documentId: string; operation: 'apply' | 'read' } | undefined {
  const match = /^\/v1\/documents\/([^/]+?)(?::applyEdits|\/edits)?$/u.exec(pathname);
  if (match === null) {
    return undefined;
  }
  let documentId: string;
  try {
    documentId = decodeURIComponent(match[1] ?? '');
  } catch {
    return undefined;
  }
  if (documentId.length === 0 || documentId.length > 256) {
    return undefined;
  }
  return {
    documentId,
    operation: pathname.endsWith(':applyEdits') || pathname.endsWith('/edits') ? 'apply' : 'read',
  };
}

function queryFrom(documentId: string, url: URL, tenantId: string): DocumentReadRequest {
  const blockIds = url.searchParams.getAll('blockId');
  const raw: Record<string, unknown> = {
    protocolVersion: 1,
    tenantId,
    documentId,
    documentIncarnation: url.searchParams.get('documentIncarnation'),
    collaborationField: url.searchParams.get('collaborationField') ?? 'default',
    schemaId: url.searchParams.get('schemaId') ?? 'editor-mcp/mvp',
    schemaVersion: Number(url.searchParams.get('schemaVersion') ?? '1'),
    selection: blockIds.length === 0 ? { kind: 'document' } : { kind: 'blocks', blockIds },
    representationProfile: url.searchParams.get('representationProfile') ?? 'agent-html/v1',
  };
  const ifRevision = url.searchParams.get('ifRevision');
  if (ifRevision !== null) {
    raw['ifRevision'] = ifRevision;
  }
  const maxBytes = url.searchParams.get('maxBytes');
  if (maxBytes !== null) {
    raw['maxBytes'] = Number(maxBytes);
  }
  const parsed = documentReadRequestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DomainError('INVALID_REQUEST', 'The document read query is invalid', false, {
      issueCount: parsed.error.issues.length,
    });
  }
  return parsed.data;
}

function withDocumentId(input: unknown, documentId: string): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return input;
  }
  const body = input as Record<string, unknown>;
  if (body['documentId'] !== undefined && body['documentId'] !== documentId) {
    throw new DomainError('INVALID_REQUEST', 'The path and body document IDs do not match', false);
  }
  return { ...body, documentId };
}

export function createReferenceServer(options: ReferenceServerOptions): ReferenceServer {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_BODY_LIMIT;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) {
    throw new TypeError('maxBodyBytes must be a positive integer');
  }
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
    throw new TypeError('requestTimeoutMs must be a positive integer');
  }

  const requestHandler = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const controller = new AbortController();
    const deadline = new Date(Date.now() + requestTimeoutMs);
    const timeout = setTimeout(() => {
      controller.abort();
    }, requestTimeoutMs);
    const abort = (): void => {
      controller.abort();
    };
    request.once('aborted', abort);
    try {
      const host = request.headers.host ?? 'localhost';
      const url = new URL(request.url ?? '/', `http://${host}`);
      if (request.method === 'GET' && url.pathname === '/healthz') {
        sendJson(response, 200, { status: 'ok' });
        return;
      }
      const path = parseDocumentPath(url.pathname);
      if (path === undefined) {
        sendJson(response, 404, {
          version: 1,
          error: {
            code: 'DOCUMENT_NOT_FOUND',
            message: 'Route not found',
            retryable: false,
          },
        });
        return;
      }
      const authorization = await abortable(
        options.authenticate({
          authorizationHeader: request.headers.authorization,
          method: request.method ?? 'GET',
          pathname: url.pathname,
        }),
        controller.signal,
      );
      if (authorization === undefined) {
        throw new DomainError('UNAUTHENTICATED', 'A valid bearer credential is required', false);
      }

      if (request.method === 'GET' && path.operation === 'read') {
        const result = await abortable(
          options.service.readDocumentV1(queryFrom(path.documentId, url, authorization.tenantId), {
            authorization,
            signal: controller.signal,
            deadline,
          }),
          controller.signal,
        );
        sendJson(response, 200, documentReadResultV1Schema.parse(result));
        return;
      }
      if (request.method === 'POST' && path.operation === 'apply') {
        const body = withDocumentId(
          await abortable(readBody(request, maxBodyBytes, controller.signal), controller.signal),
          path.documentId,
        );
        const parsedBody = applyEditsRequestV1Schema.safeParse(body);
        if (!parsedBody.success) {
          throw new DomainError(
            'INVALID_REQUEST',
            'The versioned edit request is invalid',
            false,
            { issueCount: parsedBody.error.issues.length },
            { cause: parsedBody.error },
          );
        }
        assertChangeModeAllowed(parsedBody.data.changeMode, authorization);
        /*
         * A mutation owns its commit boundary. Racing it against the transport
         * signal could return 408 while a durable commit completes afterward.
         * The service receives the same signal and absolute deadline so it can
         * stop before commit, or return the committed result once commit starts.
         */
        const result = await options.service.applyEdits(parsedBody.data, {
          authorization,
          signal: controller.signal,
          deadline,
        });
        const parsedResult = applyEditsResultSchema.parse(result);
        sendJson(response, parsedResult.status === 'conflict' ? 409 : 200, parsedResult);
        return;
      }
      throw new DomainError(
        'INVALID_REQUEST',
        'The HTTP method is not supported for this route',
        false,
      );
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const domainError =
        error instanceof DomainError
          ? error
          : new DomainError('INTERNAL', 'The request could not be completed', false, undefined, {
              cause: error,
            });
      if (domainError.code === 'UNAUTHENTICATED') {
        response.setHeader('www-authenticate', 'Bearer');
      }
      sendJson(response, statusFor(domainError), toErrorEnvelope(domainError));
    } finally {
      clearTimeout(timeout);
      request.off('aborted', abort);
    }
  };
  return {
    server: createServer((request, response) => {
      void requestHandler(request, response);
    }),
    requestHandler,
  };
}

export {
  createReferenceStack,
  type ReferenceStack,
  type ReferenceStackOptions,
} from './composition.js';
