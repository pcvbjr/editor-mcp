import {
  AdapterValidationError,
  canonicalizeDocument,
  findBlockById,
  parseAgentHtml,
  type ProseMirrorNodeJson,
} from '@editor-mcp/adapter-tiptap-hocuspocus';
import { applyEditsRequestSchema } from '@editor-mcp/protocol';
import { describe, expect, it } from 'vitest';

import { fixtureCatalog, planCoverage, validatePlanCoverage } from './index.js';

describe('scratch-plan coverage manifest', () => {
  it('resolves every displayed fixture reference to an executable catalog fixture', () => {
    expect(() => {
      validatePlanCoverage();
    }).not.toThrow();
    expect(() => {
      validatePlanCoverage(
        [
          {
            id: 'missing-fixture',
            case: 'test',
            status: 'fixture',
            fixtureIds: ['missing'],
            note: 'test',
          },
        ],
        {},
      );
    }).toThrow(/missing fixture/);
    const fixtureIds = new Set(fixtureCatalog.map(({ id }) => id));
    expect(planCoverage.length).toBeGreaterThan(20);
    expect(
      planCoverage.flatMap(({ fixtureIds: ids }) => ids).every((id) => fixtureIds.has(id)),
    ).toBe(true);
  });

  it('uses stable IDs and digests to disambiguate duplicate content', () => {
    const document = canonicalizeDocument(
      parseAgentHtml('<p>Repeated</p><p>Repeated</p>', {
        idFactory: (() => {
          let index = 0;
          return () => `550e8400-e29b-41d4-a716-44665544000${String(++index)}`;
        })(),
      }).toJSON() as ProseMirrorNodeJson,
    );
    const first = findBlockById(document, '550e8400-e29b-41d4-a716-446655440001');
    const second = findBlockById(document, '550e8400-e29b-41d4-a716-446655440002');
    expect(first.node.textContent).toBe('Repeated');
    expect(second.node.textContent).toBe('Repeated');
    expect(first.node.attrs['blockId']).not.toBe(second.node.attrs['blockId']);
  });

  it('rejects unsupported scratch-plan inputs at the certified boundary', () => {
    for (const html of [
      '<div class="callout">Callout</div>',
      '<p data-anchor="section-1">Anchor</p>',
      '<ul data-bullet-style="square"><li><p>Style</p></li></ul>',
    ]) {
      expect(() => parseAgentHtml(html)).toThrow(AdapterValidationError);
    }
    expect(() => canonicalizeDocument({ type: 'doc', content: [] })).toThrow(
      AdapterValidationError,
    );
    expect(() =>
      canonicalizeDocument({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            attrs: {
              blockId: '550e8400-e29b-41d4-a716-446655440001',
              diffChangeId: null,
              diffChangeKind: null,
            },
            content: [{ type: 'text', text: 'x' }],
          },
          {
            type: 'paragraph',
            attrs: {
              blockId: '550e8400-e29b-41d4-a716-446655440001',
              diffChangeId: null,
              diffChangeKind: null,
            },
            content: [{ type: 'text', text: 'y' }],
          },
        ],
      }),
    ).toThrow(AdapterValidationError);
    expect(() =>
      applyEditsRequestSchema.parse({
        documentId: 'doc_unsupported_move',
        documentIncarnation: 'inc_unsupported_move',
        schemaId: 'editor-mcp/mvp',
        schemaVersion: 1,
        idempotencyKey: 'idem_unsupported_move',
        changeMode: 'suggest',
        operations: [{ operationId: 'op_move', kind: 'move_block' }],
      }),
    ).toThrow();
  });
});
