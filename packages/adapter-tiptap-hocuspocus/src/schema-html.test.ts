import { describe, expect, it } from 'vitest';

import {
  ADDRESSABLE_NODE_TYPES,
  AdapterValidationError,
  MVP_CAPABILITIES,
  MVP_MARK_TYPES,
  MVP_NODE_TYPES,
  assignBlockIds,
  assertFreshReplacementBlockIds,
  canonicalJsonString,
  canonicalizeDocument,
  cloneWithFreshBlockIds,
  createJoinBlockIdentity,
  createMvpSchema,
  createSplitBlockIdentity,
  digestCanonicalJson,
  findBlockById,
  insertNodesAdjacentToPath,
  listBlockSummaries,
  parseAgentHtml,
  parseReviewHtml,
  replaceNodeAtPath,
  serializeHtml,
  validateDocument,
} from './index.js';
import type { BlockIdFactory } from './index.js';

function sequentialIds(offset = 1): BlockIdFactory {
  let next = offset;
  return () => {
    const suffix = String(next).padStart(12, '0');
    next += 1;
    return `00000000-0000-4000-8000-${suffix}`;
  };
}

describe('MVP schema and HTML certification', () => {
  it('constructs the exact capability manifest', () => {
    const schema = createMvpSchema();

    expect(Object.keys(schema.nodes)).toEqual([...MVP_NODE_TYPES]);
    expect(Object.keys(schema.marks)).toEqual([...MVP_MARK_TYPES]);
    expect(MVP_CAPABILITIES).toEqual({
      schemaId: 'editor-mcp/mvp',
      schemaVersion: 1,
      nodes: MVP_NODE_TYPES,
      marks: MVP_MARK_TYPES,
      addressableNodes: ADDRESSABLE_NODE_TYPES,
      projections: ['review', 'final', 'original', 'clean'],
    });
  });

  it('round-trips every MVP block family through canonical review HTML', () => {
    const html = [
      '<h2>Overview <em>now</em></h2>',
      '<blockquote><p>A <a href="/relative" title="local">quote</a></p></blockquote>',
      '<ul><li><p>First</p><ol start="3"><li><p>Nested</p></li></ol></li></ul>',
      '<pre data-language="ts"><code>const n = 1;</code></pre>',
      '<hr>',
      '<table><tbody><tr><th><p>Key</p></th><th><p>Value</p></th></tr>',
      '<tr><td colspan="2" data-colwidth="120,180"><p>Both<br>columns</p></td></tr>',
      '</tbody></table>',
    ].join('');
    const document = parseAgentHtml(html, { idFactory: sequentialIds() });
    const reviewHtml = serializeHtml(document, { mode: 'review' });
    const reparsed = parseReviewHtml(reviewHtml);

    expect(canonicalJsonString(reparsed)).toBe(canonicalJsonString(document));
    expect(listBlockSummaries(document).map((block) => block.nodeType)).toEqual([
      'heading',
      'blockquote',
      'paragraph',
      'bulletList',
      'listItem',
      'paragraph',
      'orderedList',
      'listItem',
      'paragraph',
      'codeBlock',
      'horizontalRule',
      'table',
      'tableRow',
      'tableHeader',
      'paragraph',
      'tableHeader',
      'paragraph',
      'tableRow',
      'tableCell',
      'paragraph',
    ]);
    expect(reviewHtml).not.toContain('style=');
  });

  it.each([
    ['unknown elements', '<p>safe</p><img src="x">', 'UNSUPPORTED_ELEMENT'],
    ['unknown attributes', '<p class="unsafe">text</p>', 'UNSUPPORTED_ATTRIBUTE'],
    ['event handlers', '<p onclick="run()">text</p>', 'UNSUPPORTED_ATTRIBUTE'],
    [
      'model block IDs',
      '<p data-block-id="00000000-0000-4000-8000-000000000001">x</p>',
      'MODEL_SUPPLIED_ID',
    ],
    [
      'model tracking',
      '<p data-diff-change-id="c" data-diff-change-kind="insert">x</p>',
      'UNSUPPORTED_ATTRIBUTE',
    ],
    ['unsafe links', '<p><a href="javascript:alert(1)">x</a></p>', 'UNSAFE_LINK'],
    ['protocol-relative links', '<p><a href="//example.test">x</a></p>', 'UNSAFE_LINK'],
    ['invalid nesting', '<p>before<blockquote><p>bad</p></blockquote></p>', 'INVALID_NESTING'],
    ['implicit list paragraphs', '<ul><li>text</li></ul>', 'INVALID_NESTING'],
    ['nested links', '<p><a href="/one">one<a href="/two">two</a></a></p>', 'INVALID_NESTING'],
    ['code-block formatting', '<pre><code><strong>marked</strong></code></pre>', 'INVALID_NESTING'],
    ['comments', '<p>text</p><!-- hidden -->', 'INVALID_HTML'],
  ])('rejects %s without returning a partial document', (_name, html, code) => {
    expect(() => parseAgentHtml(html, { idFactory: sequentialIds() })).toThrow(
      expect.objectContaining({ code }),
    );
  });

  it('rejects duplicate IDs and non-rectangular tables', () => {
    const duplicate =
      '<p data-block-id="00000000-0000-4000-8000-000000000001">one</p>' +
      '<p data-block-id="00000000-0000-4000-8000-000000000001">two</p>';
    expect(() => parseReviewHtml(duplicate)).toThrow(
      expect.objectContaining({ code: 'DUPLICATE_BLOCK_ID' }),
    );

    const uneven =
      '<table data-block-id="00000000-0000-4000-8000-000000000001"><tbody>' +
      '<tr data-block-id="00000000-0000-4000-8000-000000000002">' +
      '<td data-block-id="00000000-0000-4000-8000-000000000003">' +
      '<p data-block-id="00000000-0000-4000-8000-000000000004">a</p></td>' +
      '<td data-block-id="00000000-0000-4000-8000-000000000005">' +
      '<p data-block-id="00000000-0000-4000-8000-000000000006">b</p></td></tr>' +
      '<tr data-block-id="00000000-0000-4000-8000-000000000007">' +
      '<td data-block-id="00000000-0000-4000-8000-000000000008">' +
      '<p data-block-id="00000000-0000-4000-8000-000000000009">c</p></td></tr>' +
      '</tbody></table>';
    expect(() => parseReviewHtml(uneven)).toThrow(
      expect.objectContaining({ code: 'INVALID_DOCUMENT' }),
    );
  });

  it('enforces byte, depth, and node limits before accepting content', () => {
    expect(() =>
      parseAgentHtml('<p>too long</p>', {
        idFactory: sequentialIds(),
        limits: { maxHtmlBytes: 4 },
      }),
    ).toThrow(expect.objectContaining({ code: 'RESOURCE_LIMIT' }));

    expect(() =>
      parseAgentHtml('<blockquote><blockquote><p>x</p></blockquote></blockquote>', {
        idFactory: sequentialIds(),
        limits: { maxDepth: 2 },
      }),
    ).toThrow(expect.objectContaining({ code: 'RESOURCE_LIMIT' }));

    expect(() =>
      parseAgentHtml('<p>one</p><p>two</p>', {
        idFactory: sequentialIds(),
        limits: { maxBlocks: 1 },
      }),
    ).toThrow(expect.objectContaining({ code: 'RESOURCE_LIMIT' }));
  });

  it('rejects unknown JSON fields and invalid schema nesting', () => {
    expect(() =>
      canonicalizeDocument({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            attrs: {
              blockId: '00000000-0000-4000-8000-000000000001',
              unexpected: true,
            },
          },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_DOCUMENT' }));

    expect(() =>
      canonicalizeDocument({
        type: 'doc',
        content: [
          {
            type: 'text',
            text: 'silently dropped',
            content: [],
          },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_DOCUMENT' }));

    expect(() =>
      canonicalizeDocument({
        type: 'doc',
        content: [
          {
            type: 'bulletList',
            attrs: { blockId: '00000000-0000-4000-8000-000000000001' },
            content: [
              {
                type: 'paragraph',
                attrs: { blockId: '00000000-0000-4000-8000-000000000002' },
              },
            ],
          },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_DOCUMENT' }));
  });
});

describe('stable block identities and canonical digests', () => {
  it('preserves existing IDs, generates missing IDs, and refreshes copied IDs', () => {
    const original = parseAgentHtml('<blockquote><p>inside</p></blockquote>', {
      idFactory: sequentialIds(),
    });
    const originalIds = listBlockSummaries(original).map((block) => block.id);
    const assigned = assignBlockIds(original, sequentialIds(20));
    const copied = cloneWithFreshBlockIds(original, sequentialIds(30));

    expect(listBlockSummaries(assigned).map((block) => block.id)).toEqual(originalIds);
    expect(listBlockSummaries(copied).map((block) => block.id)).toEqual([
      '00000000-0000-4000-8000-000000000030',
      '00000000-0000-4000-8000-000000000031',
    ]);
    expect(findBlockById(original, originalIds[1] ?? '').path).toEqual([0, 0]);
  });

  it('inserts certified siblings adjacent to a stable node path', () => {
    const original = parseAgentHtml('<p>one</p><p>three</p>', {
      idFactory: sequentialIds(),
    });
    const middleDocument = parseAgentHtml('<p>two</p>', {
      idFactory: sequentialIds(10),
    });
    const middle = middleDocument.firstChild;
    if (middle === null) {
      throw new Error('Expected a fixture block');
    }
    const result = insertNodesAdjacentToPath(original, [0], [middle], 'after');

    expect(serializeHtml(result, { mode: 'clean' })).toMatch(/one.*two.*three/u);
  });

  it('makes split and join identity policy explicit', () => {
    const paragraphDocument = parseAgentHtml('<p>text</p>', {
      idFactory: sequentialIds(),
    });
    const paragraphId = listBlockSummaries(paragraphDocument)[0]?.id ?? '';
    const split = createSplitBlockIdentity(paragraphId, sequentialIds(20));
    const join = createJoinBlockIdentity(split.retainedBlockId, [split.newBlockId]);

    expect(split).toEqual({
      retainedBlockId: paragraphId,
      newBlockId: '00000000-0000-4000-8000-000000000020',
    });
    expect(join).toEqual({
      retainedBlockId: paragraphId,
      retiredBlockIds: [split.newBlockId],
    });
  });

  it.each([
    {
      name: 'same-type nested replacement',
      beforeHtml: '<blockquote><p>old child</p></blockquote><p>untouched</p>',
      replacementHtml: '<blockquote><p>new child</p></blockquote>',
      expectedIds: [
        '00000000-0000-4000-8000-000000000010',
        '00000000-0000-4000-8000-000000000011',
        '00000000-0000-4000-8000-000000000003',
      ],
      retiredIds: ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'],
    },
    {
      name: 'type-change replacement',
      beforeHtml: '<p>old</p><p>untouched</p>',
      replacementHtml: '<h2>new</h2>',
      expectedIds: ['00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000002'],
      retiredIds: ['00000000-0000-4000-8000-000000000001'],
    },
  ])(
    'retires the old subtree and preserves fresh parsed IDs for a $name',
    ({ beforeHtml, replacementHtml, expectedIds, retiredIds }) => {
      const before = parseAgentHtml(beforeHtml, { idFactory: sequentialIds() });
      const replacementDocument = parseAgentHtml(replacementHtml, {
        idFactory: sequentialIds(10),
      });
      const replacement = replacementDocument.firstChild;
      if (replacement === null) {
        throw new Error('Expected a replacement block');
      }

      assertFreshReplacementBlockIds(before, replacement);
      const result = replaceNodeAtPath(before, [0], replacement);
      const resultIds = listBlockSummaries(result).map(({ id }) => id);

      expect(resultIds).toEqual(expectedIds);
      expect(retiredIds.every((id) => !resultIds.includes(id))).toBe(true);
      validateDocument(result);
    },
  );

  it('uses key-sorted canonical JSON for deterministic SHA-256 digests', () => {
    const left = { z: 1, a: { y: true, b: 'value' } };
    const right = { a: { b: 'value', y: true }, z: 1 };

    expect(canonicalJsonString(left)).toBe('{"a":{"b":"value","y":true},"z":1}');
    expect(digestCanonicalJson(left)).toBe(digestCanonicalJson(right));
    expect(digestCanonicalJson(left)).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it('rejects a non-UUID or colliding server ID factory', () => {
    const json = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { blockId: '00000000-0000-4000-8000-000000000001' },
        },
      ],
    } as const;
    const document = canonicalizeDocument(json);

    expect(() => cloneWithFreshBlockIds(document, () => 'not-a-uuid')).toThrow(
      AdapterValidationError,
    );
  });
});
