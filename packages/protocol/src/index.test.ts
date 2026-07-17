import { describe, expect, it } from 'vitest';

import {
  applyEditsRequestSchema,
  documentReadResultSchema,
  mvpSchemaCapabilitySchema,
} from './index.js';

describe('MVP schema capability', () => {
  it('publishes the exact versioned MVP profile', () => {
    expect(
      mvpSchemaCapabilitySchema.parse({
        schemaId: 'editor-mcp/mvp',
        schemaVersion: 1,
        nodes: ['paragraph', 'table', 'tableRow', 'tableCell'],
        marks: ['bold', 'diffChange'],
      }),
    ).toEqual({
      schemaId: 'editor-mcp/mvp',
      schemaVersion: 1,
      nodes: ['paragraph', 'table', 'tableRow', 'tableCell'],
      marks: ['bold', 'diffChange'],
    });
  });

  it('rejects unknown capability fields', () => {
    expect(() =>
      mvpSchemaCapabilitySchema.parse({
        schemaId: 'editor-mcp/mvp',
        schemaVersion: 1,
        nodes: [],
        marks: [],
        unsafeHtml: true,
      }),
    ).toThrow();
  });
});

describe('document read contract', () => {
  it('requires target digests and an opaque revision', () => {
    expect(
      documentReadResultSchema.parse({
        documentId: 'doc_123',
        documentIncarnation: 'inc_1',
        revision: 'rev_opaque',
        schemaId: 'editor-mcp/mvp',
        schemaVersion: 1,
        html: '<p data-block-id="550e8400-e29b-41d4-a716-446655440000">Hello</p>',
        blocks: [
          {
            id: '550e8400-e29b-41d4-a716-446655440000',
            nodeType: 'paragraph',
            contentDigest: `sha256:${'a'.repeat(64)}`,
          },
        ],
      }).blocks,
    ).toHaveLength(1);
  });
});

describe('atomic edit contract', () => {
  it('accepts table operations in an atomic, idempotent batch', () => {
    const result = applyEditsRequestSchema.parse({
      documentId: 'doc_123',
      documentIncarnation: 'inc_1',
      schemaId: 'editor-mcp/mvp',
      schemaVersion: 1,
      idempotencyKey: 'idem_12345678',
      changeMode: 'suggest',
      operations: [
        {
          operationId: 'op_1',
          kind: 'insert_table_row',
          tableId: '550e8400-e29b-41d4-a716-446655440000',
          rowIndex: 1,
          expectedTableDigest: `sha256:${'b'.repeat(64)}`,
          position: 'after',
        },
      ],
    });

    expect(result.operations[0]?.kind).toBe('insert_table_row');
  });

  it('rejects model-supplied block IDs in inserted HTML', () => {
    expect(() =>
      applyEditsRequestSchema.parse({
        documentId: 'doc_123',
        documentIncarnation: 'inc_1',
        schemaId: 'editor-mcp/mvp',
        schemaVersion: 1,
        idempotencyKey: 'idem_12345678',
        changeMode: 'suggest',
        operations: [
          {
            operationId: 'op_1',
            kind: 'insert_after',
            anchorBlockId: '550e8400-e29b-41d4-a716-446655440000',
            html: '<p data-block-id="550e8400-e29b-41d4-a716-446655440001">Injected ID</p>',
          },
        ],
      }),
    ).toThrow(/block IDs/i);
  });

  it('rejects duplicate operation IDs within a batch', () => {
    expect(() =>
      applyEditsRequestSchema.parse({
        documentId: 'doc_123',
        documentIncarnation: 'inc_1',
        schemaId: 'editor-mcp/mvp',
        schemaVersion: 1,
        idempotencyKey: 'idem_12345678',
        changeMode: 'suggest',
        operations: [
          {
            operationId: 'op_duplicate',
            kind: 'delete_block',
            blockId: '550e8400-e29b-41d4-a716-446655440000',
            expectedBlockDigest: `sha256:${'c'.repeat(64)}`,
          },
          {
            operationId: 'op_duplicate',
            kind: 'delete_block',
            blockId: '550e8400-e29b-41d4-a716-446655440001',
            expectedBlockDigest: `sha256:${'d'.repeat(64)}`,
          },
        ],
      }),
    ).toThrow(/unique/i);
  });
});
