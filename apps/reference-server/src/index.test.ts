import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DomainError,
  type ApplyContext,
  type ApplyEditsResult,
  type AuthorizationContext,
  type DocumentReadResultV1,
  type ReadContext,
} from '@editor-mcp/core';

import { createReferenceServer, type Authenticator, type ReferenceEditorService } from './index.js';

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

const appliedResult: ApplyEditsResult = {
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
  conflicts: [],
  acknowledgement: {
    protocolVersion: 1,
    level: 'document_and_audit',
    idempotencyReceiptDurable: true,
    documentStateDurable: true,
    auditDurableOrQueued: true,
    acknowledgedAt: '2026-07-17T00:00:00.000Z',
    persistenceRevision: 'rev-2',
  },
};

const editBody = {
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
} as const;

const servers: ReturnType<typeof createReferenceServer>[] = [];

async function start(
  service: ReferenceEditorService,
  authenticate: Authenticator = async () => authorization,
  maxBodyBytes?: number,
  requestTimeoutMs?: number,
): Promise<string> {
  const server = createReferenceServer({
    service,
    authenticate,
    ...(maxBodyBytes === undefined ? {} : { maxBodyBytes }),
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
  });
  servers.push(server);
  server.server.listen(0, '127.0.0.1');
  await once(server.server, 'listening');
  const address = server.server.address() as AddressInfo;
  return `http://127.0.0.1:${String(address.port)}`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (entry) =>
        new Promise<void>((resolve, reject) => {
          entry.server.close((error) => {
            if (error === undefined) {
              resolve();
            } else {
              reject(error);
            }
          });
        }),
    ),
  );
});

describe('reference REST server', () => {
  it('serves bounded document reads through the core', async () => {
    const readDocumentV1 = vi.fn(async (_input: unknown, _context: ReadContext) => readResult);
    const origin = await start({
      readDocumentV1,
      applyEdits: async () => appliedResult,
    });
    const response = await fetch(
      `${origin}/v1/documents/doc-1?documentIncarnation=inc-1&blockId=550e8400-e29b-41d4-a716-446655440000`,
      { headers: { authorization: 'Bearer test' } },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(readResult);
    expect(readDocumentV1).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: 'doc-1',
        documentIncarnation: 'inc-1',
        selection: {
          kind: 'blocks',
          blockIds: ['550e8400-e29b-41d4-a716-446655440000'],
        },
      }),
      expect.objectContaining({ authorization }),
    );
  });

  it('applies edits and binds the document ID from the path', async () => {
    const applyEdits = vi.fn(async (_input: unknown, _context: ApplyContext) => appliedResult);
    const origin = await start({
      readDocumentV1: async () => readResult,
      applyEdits,
    });
    const response = await fetch(`${origin}/v1/documents/doc-1:applyEdits`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test',
        'content-type': 'application/json',
      },
      body: JSON.stringify(editBody),
    });
    expect(response.status).toBe(200);
    expect(applyEdits).toHaveBeenCalledWith(editBody, expect.objectContaining({ authorization }));
  });

  it('rejects direct edits from agent principals before calling the service', async () => {
    const applyEdits = vi.fn(async (_input: unknown, _context: ApplyContext) => appliedResult);
    const origin = await start({
      readDocumentV1: async () => readResult,
      applyEdits,
    });
    const response = await fetch(`${origin}/v1/documents/doc-1:applyEdits`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...editBody, changeMode: 'direct' }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: {
        code: 'PERMISSION_DENIED',
        message: 'Agent principals may only submit suggested edits',
      },
    });
    expect(applyEdits).not.toHaveBeenCalled();
  });

  it('rejects missing authentication before calling the service', async () => {
    const readDocumentV1 = vi.fn(async () => readResult);
    const origin = await start(
      {
        readDocumentV1,
        applyEdits: async () => appliedResult,
      },
      async () => undefined,
    );
    const response = await fetch(`${origin}/v1/documents/doc-1?documentIncarnation=inc-1`);
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
    expect(readDocumentV1).not.toHaveBeenCalled();
  });

  it('maps safe conflicts and never exposes internal errors', async () => {
    const origin = await start({
      readDocumentV1: async () => {
        throw new Error('secret storage path');
      },
      applyEdits: async () => {
        throw new DomainError('TARGET_CHANGED', 'Target changed', false);
      },
    });
    const internal = await fetch(`${origin}/v1/documents/doc-1?documentIncarnation=inc-1`, {
      headers: { authorization: 'Bearer test' },
    });
    expect(internal.status).toBe(500);
    expect(JSON.stringify(await internal.json())).not.toContain('secret');

    const conflict = await fetch(`${origin}/v1/documents/doc-1/edits`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test',
        'content-type': 'application/json',
      },
      body: JSON.stringify(editBody),
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      error: { code: 'TARGET_CHANGED' },
    });
  });

  it('enforces one deadline across authentication and service execution', async () => {
    const origin = await start(
      {
        readDocumentV1: async () => new Promise(() => undefined),
        applyEdits: async () => appliedResult,
      },
      async () => authorization,
      undefined,
      20,
    );
    const response = await fetch(`${origin}/v1/documents/doc-1?documentIncarnation=inc-1`, {
      headers: { authorization: 'Bearer test' },
    });
    expect(response.status).toBe(408);
    expect(await response.json()).toMatchObject({
      error: { code: 'DEADLINE_EXCEEDED', retryable: true },
    });
  });

  it('does not report a timeout while a mutation returns its committed result', async () => {
    let observedAbort = false;
    const origin = await start(
      {
        readDocumentV1: async () => readResult,
        applyEdits: async (_input, applyContext) => {
          if (applyContext.signal?.aborted !== true) {
            await new Promise<void>((resolve) => {
              applyContext.signal?.addEventListener(
                'abort',
                () => {
                  resolve();
                },
                { once: true },
              );
            });
          }
          observedAbort = applyContext.signal?.aborted === true;
          return appliedResult;
        },
      },
      async () => authorization,
      undefined,
      20,
    );

    const response = await fetch(`${origin}/v1/documents/doc-1:applyEdits`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test',
        'content-type': 'application/json',
      },
      body: JSON.stringify(editBody),
    });

    expect(observedAbort).toBe(true);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(appliedResult);
  });

  it('enforces body limits and path/body identity consistency', async () => {
    const applyEdits = vi.fn(async () => appliedResult);
    const origin = await start(
      { readDocumentV1: async () => readResult, applyEdits },
      async () => authorization,
      50,
    );
    const tooLarge = await fetch(`${origin}/v1/documents/doc-1:applyEdits`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ payload: 'x'.repeat(100) }),
    });
    expect(tooLarge.status).toBe(400);

    const mismatch = await fetch(`${origin}/v1/documents/doc-1:applyEdits`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ documentId: 'doc-2' }),
    });
    expect(mismatch.status).toBe(400);
    expect(applyEdits).not.toHaveBeenCalled();
  });

  it('handles health, routing, query, media-type, and JSON failures safely', async () => {
    const origin = await start({
      readDocumentV1: async () => readResult,
      applyEdits: async () => appliedResult,
    });
    expect((await fetch(`${origin}/healthz`)).status).toBe(200);
    expect((await fetch(`${origin}/missing`)).status).toBe(404);
    expect(
      (
        await fetch(`${origin}/v1/documents/%E0%A4%A`, {
          headers: { authorization: 'Bearer test' },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(`${origin}/v1/documents/doc-1`, {
          headers: { authorization: 'Bearer test' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${origin}/v1/documents/doc-1`, {
          method: 'PUT',
          headers: { authorization: 'Bearer test' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${origin}/v1/documents/doc-1:applyEdits`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer test',
            'content-type': 'text/plain',
          },
          body: '{}',
        })
      ).status,
    ).toBe(400);
    const malformed = await fetch(`${origin}/v1/documents/doc-1:applyEdits`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test',
        'content-type': 'application/json',
      },
      body: '{',
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({
      error: { code: 'INVALID_REQUEST' },
    });
  });
});
