import { describe, expect, it } from 'vitest';

import {
  InMemoryDiffChangesMetadataStore,
  assignBlockIds,
  assertFreshReplacementBlockIds,
  canonicalJsonString,
  canonicalizeDocument,
  createJoinBlockIdentity,
  createSplitBlockIdentity,
  findBlockById,
  insertNodesAdjacentToPath,
  isAllowedHref,
  mvpSchema,
  parseAgentHtml,
  replaceNodeAtPath,
  resolveResourceLimits,
  validateChangeMetadata,
} from './index.js';
import type { ChangeMetadata, ProseMirrorNodeJson } from './index.js';

const BLOCK_1 = '20000000-0000-4000-8000-000000000001';
const BLOCK_2 = '20000000-0000-4000-8000-000000000002';
const BLOCK_3 = '20000000-0000-4000-8000-000000000003';

const paragraph = (blockId: string, text = 'text'): ProseMirrorNodeJson => ({
  type: 'paragraph',
  attrs: { blockId },
  content: [{ type: 'text', text }],
});

const documentJson = (content: readonly ProseMirrorNodeJson[]): ProseMirrorNodeJson => ({
  type: 'doc',
  content,
});

const pendingMetadata: ChangeMetadata = {
  id: 'change-1',
  status: 'pending',
  operation: 'insert',
  authorId: 'agent-1',
  authorType: 'agent',
  createdAt: '2026-07-17T12:00:00.000Z',
  baseBlockId: BLOCK_1,
};

describe('defensive canonical validation', () => {
  it.each([
    ['non-object node', null],
    ['unknown node property', { type: 'doc', unexpected: true }],
    ['non-string node type', { type: 1 }],
    ['unsupported node type', { type: 'video' }],
    ['non-object attributes', { type: 'paragraph', attrs: [] }],
    ['unknown attribute', { type: 'paragraph', attrs: { unexpected: true } }],
    ['non-string text', { type: 'text', text: 1 }],
    ['empty text', { type: 'text', text: '' }],
    ['text attributes', { type: 'text', text: 'x', attrs: {} }],
    ['text on a non-text node', { type: 'paragraph', text: 'x' }],
    ['leaf content', { type: 'horizontalRule', content: [] }],
    ['marks on a block', { type: 'paragraph', marks: [] }],
    ['non-array content', { type: 'paragraph', content: {} }],
    ['non-array marks', { type: 'text', text: 'x', marks: {} }],
    ['non-object mark', { type: 'text', text: 'x', marks: [null] }],
    ['unknown mark property', { type: 'text', text: 'x', marks: [{ type: 'strong', x: 1 }] }],
    ['non-string mark type', { type: 'text', text: 'x', marks: [{ type: 1 }] }],
    ['unsupported mark', { type: 'text', text: 'x', marks: [{ type: 'rainbow' }] }],
    [
      'non-object mark attributes',
      { type: 'text', text: 'x', marks: [{ type: 'strong', attrs: [] }] },
    ],
    [
      'unknown mark attribute',
      { type: 'text', text: 'x', marks: [{ type: 'strong', attrs: { extra: true } }] },
    ],
  ])('rejects %s', (_name, input) => {
    expect(() => canonicalizeDocument(input as ProseMirrorNodeJson)).toThrow();
  });

  it('enforces every JSON resource limit and validates limit configuration', () => {
    const one = documentJson([paragraph(BLOCK_1, 'xx')]);
    const two = documentJson([paragraph(BLOCK_1), paragraph(BLOCK_2)]);

    expect(() => resolveResourceLimits({ maxBlocks: 0 })).toThrow(/positive integers/i);
    expect(() => resolveResourceLimits({ maxDepth: 1.5 })).toThrow(/positive integers/i);
    expect(() => canonicalizeDocument(one, { maxNodes: 2 })).toThrow(/resource limit/i);
    expect(() => canonicalizeDocument(one, { maxDepth: 1 })).toThrow(/resource limit/i);
    expect(() => canonicalizeDocument(one, { maxTextBytes: 1 })).toThrow(/resource limit/i);
    expect(() => canonicalizeDocument(two, { maxBlocks: 1 })).toThrow(/resource limit/i);
  });

  it('rejects invalid IDs, tracking attributes, block attributes, and links', () => {
    expect(() => canonicalizeDocument(documentJson([paragraph('bad-id')]))).toThrow(
      /blockId must be a UUID/i,
    );
    expect(() =>
      canonicalizeDocument(documentJson([paragraph(BLOCK_1), paragraph(BLOCK_1)])),
    ).toThrow(/unique/i);
    expect(() =>
      canonicalizeDocument(
        documentJson([
          {
            ...paragraph(BLOCK_1),
            attrs: { blockId: BLOCK_1, diffChangeId: 'change-1' },
          },
        ]),
      ),
    ).toThrow(/both be set/i);
    expect(() =>
      canonicalizeDocument(
        documentJson([
          {
            ...paragraph(BLOCK_1),
            attrs: {
              blockId: BLOCK_1,
              diffChangeId: '',
              diffChangeKind: 'insert',
            },
          },
        ]),
      ),
    ).toThrow(/tracking attributes/i);
    expect(() =>
      canonicalizeDocument({
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: { blockId: BLOCK_1, level: 7 },
            content: [{ type: 'text', text: 'heading' }],
          },
        ],
      }),
    ).toThrow(/heading level/i);
    expect(() =>
      canonicalizeDocument({
        type: 'doc',
        content: [
          {
            type: 'orderedList',
            attrs: { blockId: BLOCK_1, start: 0 },
            content: [
              {
                type: 'listItem',
                attrs: { blockId: BLOCK_2 },
                content: [paragraph(BLOCK_3)],
              },
            ],
          },
        ],
      }),
    ).toThrow(/start/i);
    expect(() =>
      canonicalizeDocument(
        documentJson([
          {
            ...paragraph(BLOCK_1),
            content: [
              {
                type: 'text',
                text: 'unsafe',
                marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
              },
            ],
          },
        ]),
      ),
    ).toThrow(/href/i);
    expect(() =>
      canonicalizeDocument(
        documentJson([
          {
            ...paragraph(BLOCK_1),
            content: [
              {
                type: 'text',
                text: 'tracked',
                marks: [{ type: 'diffChange', attrs: { changeId: '', kind: 'insert' } }],
              },
            ],
          },
        ]),
      ),
    ).toThrow(/tracking mark/i);
  });

  it('classifies safe and unsafe hrefs and canonical JSON values', () => {
    expect(
      [
        '',
        ' https://example.test',
        'https://example.test\n',
        '//example.test',
        '\\\\example.test',
        'javascript:alert(1)',
      ].every((href) => !isAllowedHref(href)),
    ).toBe(true);
    expect(
      [
        '/relative',
        '#fragment',
        'http://example.test',
        'https://example.test',
        'mailto:a@b.test',
      ].every(isAllowedHref),
    ).toBe(true);

    expect(canonicalJsonString([true, null, 1, 'x'])).toBe('[true,null,1,"x"]');
    expect(() => canonicalJsonString(undefined)).toThrow(/canonical JSON/i);
    expect(() => canonicalJsonString(Number.NaN)).toThrow(/canonical JSON/i);
    expect(() => canonicalJsonString({ value: undefined })).toThrow(/undefined/i);
  });
});

describe('defensive metadata behavior', () => {
  it.each([
    ['empty ID', { ...pendingMetadata, id: '' }],
    ['empty group ID', { ...pendingMetadata, groupId: '' }],
    ['group name without ID', { ...pendingMetadata, suggestionGroupName: 'Named group' }],
    ['group ID without name', { ...pendingMetadata, suggestionGroupId: 'set-1' }],
    [
      'empty suggestion group name',
      { ...pendingMetadata, suggestionGroupId: 'set-1', suggestionGroupName: ' ' },
    ],
    ['empty operation ID', { ...pendingMetadata, operationId: '' }],
    ['invalid status', { ...pendingMetadata, status: 'open' }],
    ['invalid operation', { ...pendingMetadata, operation: 'move' }],
    ['empty author ID', { ...pendingMetadata, authorId: '' }],
    ['invalid author type', { ...pendingMetadata, authorType: 'service' }],
    ['invalid creation time', { ...pendingMetadata, createdAt: 'not-a-date' }],
    ['invalid base block ID', { ...pendingMetadata, baseBlockId: 'bad-id' }],
    ['pending resolution fields', { ...pendingMetadata, resolvedAt: pendingMetadata.createdAt }],
    ['missing resolved fields', { ...pendingMetadata, status: 'accepted' }],
    [
      'invalid resolution time',
      { ...pendingMetadata, status: 'accepted', resolvedAt: 'bad', resolvedBy: 'reviewer' },
    ],
    [
      'empty resolver',
      {
        ...pendingMetadata,
        status: 'rejected',
        resolvedAt: pendingMetadata.createdAt,
        resolvedBy: '',
      },
    ],
    [
      'empty previous mark type',
      { ...pendingMetadata, previousFormatting: { marks: [{ type: '' }] } },
    ],
    [
      'tracking previous mark',
      { ...pendingMetadata, previousFormatting: { marks: [{ type: 'diffChange' }] } },
    ],
    ['empty previous node type', { ...pendingMetadata, previousNode: { type: '' } }],
    [
      'invalid nested previous node',
      {
        ...pendingMetadata,
        previousNode: { type: 'paragraph', content: [{ type: '' }] },
      },
    ],
  ])('rejects %s', (_name, value) => {
    expect(() => {
      validateChangeMetadata(value as ChangeMetadata);
    }).toThrow();
  });

  it('sorts and clones records, rejects identity reuse, and rolls transactions back', () => {
    const second = { ...pendingMetadata, id: 'change-2' };
    const store = new InMemoryDiffChangesMetadataStore([second, pendingMetadata]);

    expect(store.list().map((record) => record.id)).toEqual(['change-1', 'change-2']);
    expect(store.get('missing')).toBeUndefined();
    expect(store.get('change-1')).not.toBe(pendingMetadata);
    expect(() => {
      store.set({ ...pendingMetadata, authorId: 'other' });
    }).toThrow(/reused/i);

    expect(() =>
      store.transact('test-rollback', () => {
        store.set({ ...pendingMetadata, id: 'change-3' });
        throw new Error('rollback');
      }),
    ).toThrow('rollback');
    expect(store.get('change-3')).toBeUndefined();
    expect(
      store.transact('test-commit', () => {
        store.set({ ...pendingMetadata, id: 'change-4' });
        return 'committed';
      }),
    ).toBe('committed');
    expect(store.get('change-4')?.status).toBe('pending');
  });

  it('makes resolved records immutable', () => {
    const resolved: ChangeMetadata = {
      ...pendingMetadata,
      status: 'accepted',
      resolvedAt: '2026-07-17T13:00:00.000Z',
      resolvedBy: 'reviewer',
    };
    const store = new InMemoryDiffChangesMetadataStore([resolved]);

    store.set({ ...resolved });
    expect(() => {
      store.set({
        ...resolved,
        status: 'rejected',
      });
    }).toThrow(/immutable/i);
  });
});

describe('defensive block identity and path behavior', () => {
  it('rejects invalid split and join identities', () => {
    expect(() => createSplitBlockIdentity('bad')).toThrow(/retained UUID/i);
    expect(() => createSplitBlockIdentity(BLOCK_1, () => BLOCK_1)).toThrow(/duplicate/i);
    expect(() => createJoinBlockIdentity('bad', [])).toThrow(/retained UUID/i);
    expect(() => createJoinBlockIdentity(BLOCK_1, ['bad'])).toThrow(/distinct valid UUIDs/i);
    expect(() => createJoinBlockIdentity(BLOCK_1, [BLOCK_1])).toThrow(/distinct valid UUIDs/i);
    expect(() => createJoinBlockIdentity(BLOCK_1, [BLOCK_2, BLOCK_2])).toThrow(
      /distinct valid UUIDs/i,
    );
    expect(createJoinBlockIdentity(BLOCK_1, [])).toEqual({
      retainedBlockId: BLOCK_1,
      retiredBlockIds: [],
    });
  });

  it('assigns missing IDs and rejects malformed existing identities', () => {
    const missing = mvpSchema.node('doc', undefined, [
      mvpSchema.node('paragraph', undefined, [mvpSchema.text('missing')]),
    ]);
    expect(assignBlockIds(missing, () => BLOCK_1).firstChild?.attrs['blockId']).toBe(BLOCK_1);

    const invalid = mvpSchema.node('doc', undefined, [
      mvpSchema.node('paragraph', { blockId: 'bad' }, [mvpSchema.text('invalid')]),
    ]);
    expect(() => assignBlockIds(invalid)).toThrow(/not a UUID/i);

    const duplicated = mvpSchema.node('doc', undefined, [
      mvpSchema.node('paragraph', { blockId: BLOCK_1 }, [mvpSchema.text('one')]),
      mvpSchema.node('paragraph', { blockId: BLOCK_1 }, [mvpSchema.text('two')]),
    ]);
    expect(() => assignBlockIds(duplicated)).toThrow(/duplicated/i);
  });

  it('rejects non-addressable replacements, missing blocks, and stale paths', () => {
    const document = parseAgentHtml('<p>one</p><p>two</p>', {
      idFactory: (() => {
        const ids = [BLOCK_1, BLOCK_2];
        return () => ids.shift() ?? BLOCK_3;
      })(),
    });
    const first = document.firstChild;
    if (first === null) {
      throw new Error('Expected a paragraph');
    }

    expect(() => {
      assertFreshReplacementBlockIds(document, mvpSchema.text('inline'));
    }).toThrow(/addressable/i);
    const invalidReplacement = mvpSchema.node(
      'paragraph',
      { ...first.attrs, blockId: 'bad' },
      first.content,
    );
    expect(() => {
      assertFreshReplacementBlockIds(document, invalidReplacement);
    }).toThrow(/valid server-owned block ID/i);
    expect(() => {
      assertFreshReplacementBlockIds(document, first);
    }).toThrow(/must be fresh/i);
    expect(() => findBlockById(document, BLOCK_3)).toThrow(/no block/i);

    expect(replaceNodeAtPath(document, [], document)).toBe(document);
    expect(() => replaceNodeAtPath(document, [], null)).toThrow(/doc root/i);
    expect(() => replaceNodeAtPath(document, [99], first)).toThrow(/path/i);
    expect(() => insertNodesAdjacentToPath(document, [], [first], 'before')).toThrow(/doc root/i);
    expect(insertNodesAdjacentToPath(document, [0], [], 'before')).toBe(document);
    expect(() => insertNodesAdjacentToPath(document, [99], [first], 'after')).toThrow(/path/i);
  });
});
