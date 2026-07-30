import { describe, expect, it } from 'vitest';

import { createDocumentRequestV1Schema, createDocumentResultV1Schema } from './create.js';

describe('document creation contracts', () => {
  it('defaults the collaboration field without accepting unknown fields', () => {
    expect(
      createDocumentRequestV1Schema.parse({
        protocolVersion: 1,
        tenantId: 'tenant-1',
        schemaId: 'editor-mcp/mvp',
        schemaVersion: 1,
        idempotencyKey: 'create-document-1',
      }),
    ).toMatchObject({ collaborationField: 'default' });

    expect(
      createDocumentRequestV1Schema.safeParse({
        protocolVersion: 1,
        tenantId: 'tenant-1',
        schemaId: 'editor-mcp/mvp',
        schemaVersion: 1,
        idempotencyKey: 'create-document-1',
        documentId: 'model-owned-id',
      }).success,
    ).toBe(false);
  });

  it('requires replay status and replay metadata to agree', () => {
    const result = {
      protocolVersion: 1,
      tenantId: 'tenant-1',
      documentId: 'doc-1',
      documentIncarnation: 'inc-1',
      collaborationField: 'default',
      schemaId: 'editor-mcp/mvp',
      schemaVersion: 1,
      status: 'created',
      idempotentReplay: false,
      revision: 'sha256:revision',
      editorUrl: 'http://127.0.0.1:3030/documents/doc-1',
      acknowledgement: {
        level: 'snapshot',
        sequence: 1,
        storedAt: '2026-07-30T12:00:00.000Z',
      },
    } as const;

    expect(createDocumentResultV1Schema.parse(result)).toEqual(result);
    expect(
      createDocumentResultV1Schema.safeParse({
        ...result,
        status: 'existing',
      }).success,
    ).toBe(false);
  });
});
