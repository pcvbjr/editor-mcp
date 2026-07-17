import { describe, expect, it } from 'vitest';

import {
  AdapterValidationError,
  InMemoryDiffChangesMetadataStore,
  canonicalJsonString,
  collectDocumentChangeIds,
  listBlockSummaries,
  parseAgentHtml,
  parseReviewHtml,
  planChangeResolution,
  projectDocument,
  proposeBlockReplacement,
  resolveChangeInMemory,
  serializeHtml,
  validateDocument,
  validateTrackingMetadata,
} from './index.js';
import type { BlockIdFactory, ChangeMetadata } from './index.js';

function ids(offset = 1): BlockIdFactory {
  let next = offset;
  return () => {
    const result = `10000000-0000-4000-8000-${String(next).padStart(12, '0')}`;
    next += 1;
    return result;
  };
}

function pendingReplace(id = 'change-replace'): ChangeMetadata {
  return {
    id,
    groupId: 'group-replace',
    status: 'pending',
    operation: 'replace',
    authorId: 'agent-editor',
    authorType: 'agent',
    createdAt: '2026-07-17T12:00:00.000Z',
    summary: 'Replace the opening block',
  };
}

describe('review projections and resolution', () => {
  it('projects inline insertions and deletions as review, final, and original siblings', () => {
    const review = parseReviewHtml(
      '<p data-block-id="10000000-0000-4000-8000-000000000001">' +
        'The <span data-diff-change-id="delete-1" data-diff-change-kind="delete">old</span>' +
        '<span data-diff-change-id="insert-1" data-diff-change-kind="insert">new</span> text.' +
        '</p>',
    );
    const records = new InMemoryDiffChangesMetadataStore([
      {
        id: 'delete-1',
        groupId: 'replacement-1',
        status: 'pending',
        operation: 'replace',
        authorId: 'agent',
        authorType: 'agent',
        createdAt: '2026-07-17T12:00:00.000Z',
      },
      {
        id: 'insert-1',
        groupId: 'replacement-1',
        status: 'pending',
        operation: 'replace',
        authorId: 'agent',
        authorType: 'agent',
        createdAt: '2026-07-17T12:00:00.000Z',
      },
    ]);

    validateTrackingMetadata(review, records);
    expect(serializeHtml(review, { mode: 'review' })).toContain('data-diff-change-kind="delete"');
    expect(serializeHtml(review, { mode: 'final' })).toContain('The new text.');
    expect(serializeHtml(review, { mode: 'final' })).not.toContain('The old');
    expect(serializeHtml(review, { mode: 'original' })).toContain('The old text.');
    expect(serializeHtml(review, { mode: 'original' })).not.toContain('oldnew');
    expect(() => serializeHtml(review, { mode: 'clean' })).toThrow(
      expect.objectContaining({ code: 'INVALID_TRACKING' }),
    );
    expect(serializeHtml(review, { mode: 'clean', unresolvedCleanPolicy: 'accept' })).toBe(
      serializeHtml(review, { mode: 'final' }),
    );
  });

  it.each([
    {
      name: 'same-type nested',
      beforeHtml: '<blockquote><p>Before nested</p></blockquote><p>Untouched</p>',
      replacementHtml: '<blockquote><p>After nested</p></blockquote>',
      oldIds: ['10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002'],
      newIds: ['10000000-0000-4000-8000-000000000020', '10000000-0000-4000-8000-000000000021'],
      untouchedId: '10000000-0000-4000-8000-000000000003',
    },
    {
      name: 'type-change',
      beforeHtml: '<p>Before</p><p>Untouched</p>',
      replacementHtml: '<h2>After</h2>',
      oldIds: ['10000000-0000-4000-8000-000000000001'],
      newIds: ['10000000-0000-4000-8000-000000000020'],
      untouchedId: '10000000-0000-4000-8000-000000000002',
    },
  ])(
    'tracks a $name replacement as one delete/insert change with fresh block identities',
    ({ beforeHtml, replacementHtml, oldIds, newIds, untouchedId }) => {
      const before = parseAgentHtml(beforeHtml, { idFactory: ids() });
      const replacement = parseAgentHtml(replacementHtml, { idFactory: ids(20) });
      const proposed = proposeBlockReplacement(
        before,
        oldIds[0] ?? '',
        replacement,
        pendingReplace(),
      );
      const store = new InMemoryDiffChangesMetadataStore([proposed.metadata]);
      const deleted = proposed.document.child(0);
      const inserted = proposed.document.child(1);
      const reviewHtml = serializeHtml(proposed.document, { mode: 'review' });

      expect(deleted.attrs['blockId']).toBe(oldIds[0]);
      expect(deleted.attrs['diffChangeId']).toBe('change-replace');
      expect(deleted.attrs['diffChangeKind']).toBe('delete');
      expect(inserted.attrs['blockId']).toBe(newIds[0]);
      expect(inserted.attrs['diffChangeId']).toBe('change-replace');
      expect(inserted.attrs['diffChangeKind']).toBe('insert');
      expect(reviewHtml.match(/data-diff-change-id="change-replace"/gu)).toHaveLength(2);
      expect(collectDocumentChangeIds(proposed.document)).toEqual(['change-replace']);
      expect(proposed.metadata.baseBlockId).toBe(oldIds[0]);
      expect(proposed.metadata.previousNode).toBeUndefined();
      validateDocument(proposed.document);
      validateTrackingMetadata(proposed.document, store);

      const finalProjection = projectDocument(proposed.document, 'final', { metadata: store });
      const originalProjection = projectDocument(proposed.document, 'original', {
        metadata: store,
      });
      expect(listBlockSummaries(finalProjection).map(({ id }) => id)).toEqual([
        ...newIds,
        untouchedId,
      ]);
      expect(listBlockSummaries(originalProjection).map(({ id }) => id)).toEqual([
        ...oldIds,
        untouchedId,
      ]);
      expect(canonicalJsonString(originalProjection)).toBe(canonicalJsonString(before));

      const accepted = planChangeResolution(proposed.document, 'change-replace', 'accept', store, {
        resolvedAt: '2026-07-17T13:00:00.000Z',
        resolvedBy: 'reviewer',
      });
      const rejected = planChangeResolution(proposed.document, 'change-replace', 'reject', store, {
        resolvedAt: '2026-07-17T13:00:00.000Z',
        resolvedBy: 'reviewer',
      });

      expect(listBlockSummaries(accepted.document).map(({ id }) => id)).toEqual([
        ...newIds,
        untouchedId,
      ]);
      expect(listBlockSummaries(rejected.document).map(({ id }) => id)).toEqual([
        ...oldIds,
        untouchedId,
      ]);
      expect(canonicalJsonString(rejected.document)).toBe(canonicalJsonString(before));
      expect(accepted.metadataUpdates).toHaveLength(1);
      expect(accepted.metadataUpdates[0]?.status).toBe('accepted');
      expect(rejected.metadataUpdates).toHaveLength(1);
      expect(rejected.metadataUpdates[0]?.status).toBe('rejected');
      validateDocument(accepted.document);
      validateDocument(rejected.document);
    },
  );

  it('rejects replacement IDs that reuse a retired target or descendant ID', () => {
    const before = parseAgentHtml('<blockquote><p>Before</p></blockquote>', {
      idFactory: ids(),
    });
    const reusedRoot = parseAgentHtml('<blockquote><p>After</p></blockquote>', {
      idFactory: ids(),
    });
    const replacementIds = [
      '10000000-0000-4000-8000-000000000020',
      '10000000-0000-4000-8000-000000000002',
    ];
    const reusedDescendant = parseAgentHtml('<blockquote><p>After</p></blockquote>', {
      idFactory: () => replacementIds.shift() ?? '',
    });

    expect(() =>
      proposeBlockReplacement(
        before,
        '10000000-0000-4000-8000-000000000001',
        reusedRoot,
        pendingReplace(),
      ),
    ).toThrow(expect.objectContaining({ code: 'DUPLICATE_BLOCK_ID' }));
    expect(() =>
      proposeBlockReplacement(
        before,
        '10000000-0000-4000-8000-000000000001',
        reusedDescendant,
        pendingReplace(),
      ),
    ).toThrow(expect.objectContaining({ code: 'DUPLICATE_BLOCK_ID' }));
  });

  it('updates the in-memory metadata port idempotently without hiding replay state', () => {
    const before = parseAgentHtml('<p>Before</p>', { idFactory: ids() });
    const replacement = parseAgentHtml('<p>After</p>', { idFactory: ids(10) });
    const proposed = proposeBlockReplacement(
      before,
      '10000000-0000-4000-8000-000000000001',
      replacement,
      pendingReplace('change-once'),
    );
    const store = new InMemoryDiffChangesMetadataStore([proposed.metadata]);
    const resolved = resolveChangeInMemory(proposed.document, 'change-once', 'accept', store, {
      resolvedAt: '2026-07-17T13:00:00.000Z',
      resolvedBy: 'reviewer',
    });

    expect(store.get('change-once')?.status).toBe('accepted');
    expect(collectDocumentChangeIds(resolved.document)).toEqual([]);
    expect(() =>
      planChangeResolution(proposed.document, 'change-once', 'accept', store, {
        resolvedAt: '2026-07-17T13:00:00.000Z',
        resolvedBy: 'reviewer',
      }),
    ).toThrow(expect.objectContaining({ code: 'ALREADY_RESOLVED' }));
  });

  it('resolves all pending members of a group together', () => {
    const review = parseReviewHtml(
      '<p data-block-id="10000000-0000-4000-8000-000000000001">' +
        '<span data-diff-change-id="one" data-diff-change-kind="insert">A</span>' +
        '<span data-diff-change-id="two" data-diff-change-kind="insert">B</span></p>',
    );
    const common = {
      groupId: 'group',
      status: 'pending',
      operation: 'insert',
      authorId: 'agent',
      authorType: 'agent',
      createdAt: '2026-07-17T12:00:00.000Z',
    } as const;
    const store = new InMemoryDiffChangesMetadataStore([
      { id: 'one', ...common },
      { id: 'two', ...common },
    ]);
    const plan = planChangeResolution(review, 'one', 'accept', store, {
      resolvedAt: '2026-07-17T13:00:00.000Z',
      resolvedBy: 'reviewer',
    });

    expect(plan.resolvedChangeIds).toEqual(['one', 'two']);
    expect(collectDocumentChangeIds(plan.document)).toEqual([]);
    expect(serializeHtml(plan.document, { mode: 'clean' })).toContain('AB');
  });

  it('requires resolution-critical metadata for original modified-block projections', () => {
    const review = parseReviewHtml(
      '<p data-block-id="10000000-0000-4000-8000-000000000001" ' +
        'data-diff-change-id="modify" data-diff-change-kind="modify">new</p>',
    );

    expect(() => projectDocument(review, 'original')).toThrow(
      expect.objectContaining({ code: 'RESOLUTION_METADATA_REQUIRED' }),
    );
    expect(() =>
      planChangeResolution(
        review,
        'modify',
        'reject',
        new InMemoryDiffChangesMetadataStore([
          {
            id: 'modify',
            status: 'pending',
            operation: 'replace',
            authorId: 'agent',
            authorType: 'agent',
            createdAt: '2026-07-17T12:00:00.000Z',
          },
        ]),
        { resolvedAt: '2026-07-17T13:00:00.000Z', resolvedBy: 'reviewer' },
      ),
    ).toThrow(AdapterValidationError);
  });
});
