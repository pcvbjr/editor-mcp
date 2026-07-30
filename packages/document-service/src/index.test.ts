import { describe, expect, it } from 'vitest';

import {
  canonicalizeDocument,
  digestBlock,
  findBlockById,
  listBlockSummaries,
  type ProseMirrorNodeJson,
} from '@editor-mcp/adapter-tiptap-hocuspocus';
import {
  EditorService,
  MemoryAuditSink,
  MemoryIdempotencyLedger,
  PermissionAuthorizationPolicy,
  type ApplyContext,
  type AuthorizationContext,
  type DocumentIdentity,
} from '@editor-mcp/core';
import { HocuspocusRuntime, MemoryYjsPersistence } from '@editor-mcp/runtime-hocuspocus';
import { documentReadResultV1Schema } from '@editor-mcp/protocol';

import { TiptapDocumentService, type TiptapDocumentServiceOptions } from './index.js';

const ids = {
  first: '00000000-0000-4000-8000-000000000001',
  second: '00000000-0000-4000-8000-000000000002',
  table: '00000000-0000-4000-8000-000000000003',
  row1: '00000000-0000-4000-8000-000000000004',
  cell11: '00000000-0000-4000-8000-000000000005',
  paragraph11: '00000000-0000-4000-8000-000000000006',
  cell12: '00000000-0000-4000-8000-000000000007',
  paragraph12: '00000000-0000-4000-8000-000000000008',
  row2: '00000000-0000-4000-8000-000000000009',
  cell21: '00000000-0000-4000-8000-00000000000a',
  paragraph21: '00000000-0000-4000-8000-00000000000b',
  cell22: '00000000-0000-4000-8000-00000000000c',
  paragraph22: '00000000-0000-4000-8000-00000000000d',
} as const;

const documentJson: ProseMirrorNodeJson = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      attrs: {
        blockId: ids.first,
        diffChangeId: null,
        diffChangeKind: null,
      },
      content: [{ type: 'text', text: 'Hello world' }],
    },
    {
      type: 'paragraph',
      attrs: {
        blockId: ids.second,
        diffChangeId: null,
        diffChangeKind: null,
      },
      content: [{ type: 'text', text: 'Second paragraph' }],
    },
    {
      type: 'table',
      attrs: {
        blockId: ids.table,
        diffChangeId: null,
        diffChangeKind: null,
      },
      content: [
        {
          type: 'tableRow',
          attrs: {
            blockId: ids.row1,
            diffChangeId: null,
            diffChangeKind: null,
          },
          content: [
            {
              type: 'tableHeader',
              attrs: {
                blockId: ids.cell11,
                colspan: 1,
                rowspan: 1,
                colwidth: null,
                diffChangeId: null,
                diffChangeKind: null,
              },
              content: [
                {
                  type: 'paragraph',
                  attrs: {
                    blockId: ids.paragraph11,
                    diffChangeId: null,
                    diffChangeKind: null,
                  },
                  content: [{ type: 'text', text: 'A' }],
                },
              ],
            },
            {
              type: 'tableHeader',
              attrs: {
                blockId: ids.cell12,
                colspan: 1,
                rowspan: 1,
                colwidth: null,
                diffChangeId: null,
                diffChangeKind: null,
              },
              content: [
                {
                  type: 'paragraph',
                  attrs: {
                    blockId: ids.paragraph12,
                    diffChangeId: null,
                    diffChangeKind: null,
                  },
                  content: [{ type: 'text', text: 'B' }],
                },
              ],
            },
          ],
        },
        {
          type: 'tableRow',
          attrs: {
            blockId: ids.row2,
            diffChangeId: null,
            diffChangeKind: null,
          },
          content: [
            {
              type: 'tableCell',
              attrs: {
                blockId: ids.cell21,
                colspan: 1,
                rowspan: 1,
                colwidth: null,
                diffChangeId: null,
                diffChangeKind: null,
              },
              content: [
                {
                  type: 'paragraph',
                  attrs: {
                    blockId: ids.paragraph21,
                    diffChangeId: null,
                    diffChangeKind: null,
                  },
                  content: [{ type: 'text', text: 'C' }],
                },
              ],
            },
            {
              type: 'tableCell',
              attrs: {
                blockId: ids.cell22,
                colspan: 1,
                rowspan: 1,
                colwidth: null,
                diffChangeId: null,
                diffChangeKind: null,
              },
              content: [
                {
                  type: 'paragraph',
                  attrs: {
                    blockId: ids.paragraph22,
                    diffChangeId: null,
                    diffChangeKind: null,
                  },
                  content: [{ type: 'text', text: 'D' }],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

const identity: DocumentIdentity = {
  tenantId: 'tenant-1',
  documentId: 'doc-1',
  documentIncarnation: 'inc-1',
  collaborationField: 'default',
  schemaId: 'editor-mcp/mvp',
  schemaVersion: 1,
};

const authorization: AuthorizationContext = {
  tenantId: identity.tenantId,
  principalId: 'agent-1',
  principalType: 'human',
  permissions: new Set([
    'documents:read',
    'documents:suggest',
    'documents:write',
    'suggestions:review',
  ]),
  traceId: 'trace-1',
};

const context: ApplyContext = { authorization };

async function setup(options: Omit<TiptapDocumentServiceOptions, 'runtime'> = {}) {
  const persistence = new MemoryYjsPersistence();
  const runtime = new HocuspocusRuntime({ persistence });
  const service = new TiptapDocumentService({ runtime, ...options });
  await service.seed({ identity, document: documentJson });
  return { persistence, runtime, service };
}

function queuedBlockIds(...values: readonly string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index];
    if (value === undefined) {
      throw new Error('The test block ID queue was exhausted');
    }
    index += 1;
    return value;
  };
}

async function stateOf(runtime: HocuspocusRuntime, targetIdentity: DocumentIdentity = identity) {
  const state = await runtime.read<{
    type: string;
    content: never[];
    [key: string]: never[] | string;
  }>({
    ...targetIdentity,
  });
  expect(state).toBeDefined();
  return canonicalizeDocument(state?.document as unknown as ProseMirrorNodeJson);
}

function digestOf(document: ReturnType<typeof canonicalizeDocument>, blockId: string): string {
  return digestBlock(findBlockById(document, blockId).node);
}

function nodeJson(node: ReturnType<typeof canonicalizeDocument>): ProseMirrorNodeJson {
  return node.toJSON() as ProseMirrorNodeJson;
}

function request(
  operations: Parameters<TiptapDocumentService['applyAtomic']>[1]['operations'],
  changeMode: 'direct' | 'suggest' = 'direct',
  idempotencyKey = `idem-${Math.random().toString(36).slice(2, 14)}`,
): Parameters<TiptapDocumentService['applyAtomic']>[1] {
  return {
    documentId: identity.documentId,
    documentIncarnation: identity.documentIncarnation,
    schemaId: 'editor-mcp/mvp',
    schemaVersion: 1,
    idempotencyKey,
    changeMode,
    operations,
  };
}

describe('TiptapDocumentService reads and direct mutations', () => {
  it('creates one durable blank document and replays the same identity', async () => {
    const persistence = new MemoryYjsPersistence();
    const runtime = new HocuspocusRuntime({ persistence });
    const service = new TiptapDocumentService({
      runtime,
      blockIdFactory: () => ids.first,
    });

    const first = await service.createBlank(identity, context);
    const replay = await service.createBlank(identity, context);
    const document = await stateOf(runtime);

    expect(first).toMatchObject({ created: true, acknowledgement: { level: 'snapshot' } });
    expect(replay).toMatchObject({
      created: false,
      revision: first.revision,
      acknowledgement: { sequence: first.acknowledgement.sequence },
    });
    expect(listBlockSummaries(document)).toEqual([
      expect.objectContaining({ id: ids.first, nodeType: 'paragraph' }),
    ]);
  });

  it('rejects direct mutations from agent principals at the document boundary', async () => {
    const { runtime, service } = await setup();
    const before = await stateOf(runtime);
    await expect(
      service.applyAtomic(
        identity,
        request([
          {
            operationId: 'agent-direct-1',
            kind: 'delete_block',
            blockId: ids.first,
            expectedBlockDigest: digestOf(before, ids.first),
          },
        ]),
        {
          authorization: {
            ...authorization,
            principalType: 'agent',
            agentRunId: 'run-agent-direct',
          },
        },
      ),
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      message: 'Agent principals may only submit suggested edits',
    });
  });

  it('returns canonical HTML, stable IDs, digests, and bounded projections', async () => {
    const { service } = await setup();
    const result = await service.readDocument(
      identity,
      {
        documentId: identity.documentId,
        documentIncarnation: identity.documentIncarnation,
        schemaId: 'editor-mcp/mvp',
        schemaVersion: 1,
        blockIds: [ids.first],
      },
      { authorization },
    );
    expect(result?.html).toContain(`data-block-id="${ids.first}"`);
    expect(result?.html).not.toContain(`data-block-id="${ids.second}"`);
    expect(result?.blocks).toHaveLength(1);
    expect(result?.blocks[0]?.id).toBe(ids.first);
    expect(result?.blocks[0]?.contentDigest).toMatch(/^sha256:/u);
  });

  it('serves every strict v1 representation with bounded output', async () => {
    const { service } = await setup();
    const baseRequest = {
      protocolVersion: 1,
      ...identity,
      selection: { kind: 'document' as const },
    } as const;
    for (const representationProfile of [
      'agent-html/v1',
      'prosemirror-json/v1',
      'plain-text/v1',
      'outline/v1',
    ] as const) {
      const result = await service.readDocumentV1(
        identity,
        { ...baseRequest, representationProfile },
        { authorization },
      );
      expect(result?.representation.profile).toBe(representationProfile);
      expect(() => documentReadResultV1Schema.parse(result)).not.toThrow();
    }

    const full = await service.readDocumentV1(
      identity,
      { ...baseRequest, representationProfile: 'prosemirror-json/v1' },
      { authorization },
    );
    expect(full).toBeDefined();
    const maxBytes = Buffer.byteLength(JSON.stringify(full), 'utf8') - 100;
    const bounded = await service.readDocumentV1(
      identity,
      {
        ...baseRequest,
        representationProfile: 'prosemirror-json/v1',
        maxBytes,
      },
      { authorization },
    );
    expect(bounded?.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(bounded), 'utf8')).toBeLessThanOrEqual(maxBytes);
  });

  it.each([
    {
      label: 'same-type',
      html: '<p>Updated paragraph</p>',
      nodeType: 'paragraph',
      text: 'Updated paragraph',
      replacementId: '10000000-0000-4000-8000-000000000001',
    },
    {
      label: 'type-changing',
      html: '<h2>Updated heading</h2>',
      nodeType: 'heading',
      text: 'Updated heading',
      replacementId: '10000000-0000-4000-8000-000000000002',
    },
    {
      label: 'content-identical',
      html: '<p>Hello world</p>',
      nodeType: 'paragraph',
      text: 'Hello world',
      replacementId: '10000000-0000-4000-8000-000000000006',
    },
  ])(
    'gives a $label direct block replacement a new identity across reload',
    async ({ html, nodeType, replacementId, text }) => {
      const { runtime, service } = await setup({
        blockIdFactory: queuedBlockIds(replacementId),
      });
      const before = await stateOf(runtime);
      const untouchedBefore = nodeJson(findBlockById(before, ids.second).node);
      const result = await service.applyAtomic(
        identity,
        request([
          {
            operationId: 'replace-1',
            kind: 'replace_block',
            blockId: ids.first,
            expectedBlockDigest: digestOf(before, ids.first),
            html,
          },
        ]),
        context,
      );

      expect(result).toMatchObject({
        status: 'applied',
        affectedBlockIds: [ids.first],
        createdBlockIds: [replacementId],
      });
      await runtime.unload(identity);
      const after = await stateOf(runtime);
      const summaries = listBlockSummaries(after);
      expect(summaries.some(({ id }) => id === ids.first)).toBe(false);
      const replacement = findBlockById(after, replacementId).node;
      expect(replacement.type.name).toBe(nodeType);
      expect(replacement.textContent).toBe(text);
      expect(nodeJson(findBlockById(after, ids.second).node)).toEqual(untouchedBefore);
    },
  );

  it('returns the same replacement identity on a service-level idempotent replay', async () => {
    const replacementId = '10000000-0000-4000-8000-000000000003';
    const changeId = 'chg-replace-replay';
    const { runtime, service } = await setup({
      blockIdFactory: queuedBlockIds(replacementId),
      changeIdFactory: () => changeId,
      changeSetIdFactory: () => 'set-replace-replay',
    });
    const before = await stateOf(runtime);
    const replaceRequest = request(
      [
        {
          operationId: 'replace-replay',
          kind: 'replace_block',
          blockId: ids.first,
          expectedBlockDigest: digestOf(before, ids.first),
          html: '<p>Replay-safe replacement</p>',
        },
      ],
      'suggest',
      'idem-replace-replay',
    );

    const first = await service.applyAtomic(identity, replaceRequest, context);
    const afterFirst = nodeJson(await stateOf(runtime));
    const replay = await service.applyAtomic(identity, replaceRequest, context);

    expect(first).toMatchObject({
      createdBlockIds: [replacementId],
      changeIds: [changeId],
    });
    expect(replay).toMatchObject({
      idempotentReplay: true,
      createdBlockIds: [replacementId],
      changeIds: [changeId],
      revision: first.revision,
    });
    expect(nodeJson(await stateOf(runtime))).toEqual(afterFirst);
  });

  it('returns a stale-target conflict with no mutation', async () => {
    const { runtime, service } = await setup();
    const result = await service.applyAtomic(
      identity,
      request([
        {
          operationId: 'replace-stale',
          kind: 'replace_block',
          blockId: ids.first,
          expectedBlockDigest: `sha256:${'f'.repeat(64)}`,
          html: '<p>Must not apply</p>',
        },
      ]),
      context,
    );
    expect(result).toMatchObject({
      status: 'conflict',
      conflicts: [{ code: 'TARGET_CHANGED', targetId: ids.first }],
    });
    expect(findBlockById(await stateOf(runtime), ids.first).node.textContent).toBe('Hello world');
  });

  it('rejects a stale versioned read revision before mutation', async () => {
    const { runtime, service } = await setup();
    const before = await stateOf(runtime);
    const result = await service.applyAtomic(
      identity,
      {
        ...request([
          {
            operationId: 'replace-stale-revision',
            kind: 'replace_block',
            blockId: ids.first,
            expectedBlockDigest: digestOf(before, ids.first),
            html: '<p>Must not apply</p>',
          },
        ]),
        readRevision: 'stale-revision',
      },
      context,
    );
    expect(result).toMatchObject({
      status: 'conflict',
      conflicts: [
        {
          code: 'TARGET_CHANGED',
          retryHint: 'reread_document',
        },
      ],
    });
    expect(findBlockById(await stateOf(runtime), ids.first).node.textContent).toBe('Hello world');
  });

  it('keeps an entire batch atomic when a later operation conflicts', async () => {
    const { runtime, service } = await setup();
    const before = await stateOf(runtime);
    const result = await service.applyAtomic(
      identity,
      request([
        {
          operationId: 'insert-atomic',
          kind: 'insert_text',
          blockId: ids.first,
          expectedBlockDigest: digestOf(before, ids.first),
          offset: 5,
          text: ' temporarily',
        },
        {
          operationId: 'delete-stale',
          kind: 'delete_block',
          blockId: ids.second,
          expectedBlockDigest: `sha256:${'e'.repeat(64)}`,
        },
      ]),
      context,
    );
    expect(result.status).toBe('conflict');
    expect(findBlockById(await stateOf(runtime), ids.first).node.textContent).toBe('Hello world');
  });

  it('does not partially mutate a batch when a later replacement is invalid', async () => {
    const { runtime, service } = await setup({
      blockIdFactory: queuedBlockIds(
        '10000000-0000-4000-8000-000000000004',
        '10000000-0000-4000-8000-000000000005',
      ),
    });
    const before = await stateOf(runtime);
    const beforeJson = nodeJson(before);

    await expect(
      service.applyAtomic(
        identity,
        request([
          {
            operationId: 'draft-first-edit',
            kind: 'insert_text',
            blockId: ids.first,
            expectedBlockDigest: digestOf(before, ids.first),
            offset: 5,
            text: ' temporary',
          },
          {
            operationId: 'invalid-whole-block-replacement',
            kind: 'replace_block',
            blockId: ids.second,
            expectedBlockDigest: digestOf(before, ids.second),
            html: '<p>One</p><p>Two</p>',
          },
        ]),
        context,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CONTENT' });

    expect(nodeJson(await stateOf(runtime))).toEqual(beforeJson);
  });

  it('supports localized text insert, replace, delete, and formatting', async () => {
    const { runtime, service } = await setup();
    let document = await stateOf(runtime);
    await service.applyAtomic(
      identity,
      request([
        {
          operationId: 'text-insert',
          kind: 'insert_text',
          blockId: ids.first,
          expectedBlockDigest: digestOf(document, ids.first),
          offset: 5,
          text: ' brave',
        },
      ]),
      context,
    );
    document = await stateOf(runtime);
    expect(findBlockById(document, ids.first).node.textContent).toBe('Hello brave world');

    await service.applyAtomic(
      identity,
      request([
        {
          operationId: 'text-replace',
          kind: 'replace_text',
          blockId: ids.first,
          expectedBlockDigest: digestOf(document, ids.first),
          range: { from: 6, to: 11 },
          text: 'kind',
        },
      ]),
      context,
    );
    document = await stateOf(runtime);
    await service.applyAtomic(
      identity,
      request([
        {
          operationId: 'text-format',
          kind: 'format_text',
          blockId: ids.first,
          expectedBlockDigest: digestOf(document, ids.first),
          range: { from: 0, to: 5 },
          action: 'add',
          mark: { type: 'bold' },
        },
      ]),
      context,
    );
    document = await stateOf(runtime);
    expect(findBlockById(document, ids.first).node.firstChild?.marks[0]?.type.name).toBe('bold');

    await service.applyAtomic(
      identity,
      request([
        {
          operationId: 'text-delete',
          kind: 'delete_text',
          blockId: ids.first,
          expectedBlockDigest: digestOf(document, ids.first),
          range: { from: 5, to: 10 },
        },
      ]),
      context,
    );
    expect(findBlockById(await stateOf(runtime), ids.first).node.textContent).toBe('Hello world');
  });

  it('inserts before and after anchors and deletes a block directly', async () => {
    const { runtime, service } = await setup();
    const before = await service.applyAtomic(
      identity,
      request([
        {
          operationId: 'insert-before',
          kind: 'insert_before',
          anchorBlockId: ids.first,
          html: '<p>Before first</p>',
        },
      ]),
      context,
    );
    expect(before.createdBlockIds).toHaveLength(1);

    let document = await stateOf(runtime);
    const after = await service.applyAtomic(
      identity,
      request([
        {
          operationId: 'insert-after',
          kind: 'insert_after',
          anchorBlockId: ids.second,
          expectedAnchorDigest: digestOf(document, ids.second),
          html: '<blockquote><p>After second</p></blockquote>',
        },
      ]),
      context,
    );
    expect(after.createdBlockIds.length).toBeGreaterThanOrEqual(2);

    document = await stateOf(runtime);
    const deleted = await service.applyAtomic(
      identity,
      request([
        {
          operationId: 'delete-direct',
          kind: 'delete_block',
          blockId: ids.second,
          expectedBlockDigest: digestOf(document, ids.second),
        },
      ]),
      context,
    );
    expect(deleted.status).toBe('applied');
    expect(listBlockSummaries(await stateOf(runtime)).some(({ id }) => id === ids.second)).toBe(
      false,
    );
  });
});

describe('suggestion and resolution semantics', () => {
  it('rejects a whole-block replacement by removing the new block and retaining the old ID', async () => {
    const replacementId = '20000000-0000-4000-8000-000000000001';
    const changeId = 'chg-reject-block-replacement';
    const { runtime, service } = await setup({
      blockIdFactory: queuedBlockIds(replacementId),
      changeIdFactory: () => changeId,
    });
    const before = await stateOf(runtime);
    const untouchedBefore = nodeJson(findBlockById(before, ids.second).node);
    const proposal = await service.applyAtomic(
      identity,
      request(
        [
          {
            operationId: 'suggest-replace',
            kind: 'replace_block',
            blockId: ids.first,
            expectedBlockDigest: digestOf(before, ids.first),
            html: '<p>Proposed text</p>',
          },
        ],
        'suggest',
      ),
      context,
    );
    expect(proposal).toMatchObject({
      createdBlockIds: [replacementId],
      changeIds: [changeId],
    });
    const proposed = await stateOf(runtime);
    expect(findBlockById(proposed, ids.first).node).toMatchObject({
      attrs: { diffChangeId: changeId, diffChangeKind: 'delete' },
      textContent: 'Hello world',
    });
    expect(findBlockById(proposed, replacementId).node).toMatchObject({
      attrs: { diffChangeId: changeId, diffChangeKind: 'insert' },
      textContent: 'Proposed text',
    });

    const rejected = await service.applyAtomic(
      identity,
      request([
        {
          operationId: 'reject-change',
          kind: 'reject_change',
          changeId,
        },
      ]),
      context,
    );
    expect(rejected.status).toBe('applied');
    const after = await stateOf(runtime);
    expect(findBlockById(after, ids.first).node).toMatchObject({
      attrs: { diffChangeId: null, diffChangeKind: null },
      textContent: 'Hello world',
    });
    expect(listBlockSummaries(after).some(({ id }) => id === replacementId)).toBe(false);
    expect(nodeJson(findBlockById(after, ids.second).node)).toEqual(untouchedBefore);
  });

  it('accepts a type-changing whole-block replacement by retaining only the new ID', async () => {
    const replacementId = '20000000-0000-4000-8000-000000000002';
    const changeId = 'chg-accept-block-replacement';
    const { runtime, service } = await setup({
      blockIdFactory: queuedBlockIds(replacementId),
      changeIdFactory: () => changeId,
    });
    const before = await stateOf(runtime);
    const untouchedBefore = nodeJson(findBlockById(before, ids.second).node);
    const proposal = await service.applyAtomic(
      identity,
      request(
        [
          {
            operationId: 'suggest-heading-replacement',
            kind: 'replace_block',
            blockId: ids.first,
            expectedBlockDigest: digestOf(before, ids.first),
            html: '<h2>Accepted heading</h2>',
          },
        ],
        'suggest',
      ),
      context,
    );
    expect(proposal).toMatchObject({
      createdBlockIds: [replacementId],
      changeIds: [changeId],
    });

    await service.applyAtomic(
      identity,
      request([
        {
          operationId: 'accept-heading-replacement',
          kind: 'accept_change',
          changeId,
        },
      ]),
      context,
    );

    const after = await stateOf(runtime);
    expect(listBlockSummaries(after).some(({ id }) => id === ids.first)).toBe(false);
    expect(findBlockById(after, replacementId).node).toMatchObject({
      type: { name: 'heading' },
      attrs: {
        blockId: replacementId,
        diffChangeId: null,
        diffChangeKind: null,
      },
      textContent: 'Accepted heading',
    });
    expect(nodeJson(findBlockById(after, ids.second).node)).toEqual(untouchedBefore);
  });

  it('accepts a tracked deletion and persists resolved metadata', async () => {
    const { runtime, service } = await setup();
    const before = await stateOf(runtime);
    const proposal = await service.applyAtomic(
      identity,
      request(
        [
          {
            operationId: 'suggest-delete',
            kind: 'delete_text',
            blockId: ids.first,
            expectedBlockDigest: digestOf(before, ids.first),
            range: { from: 5, to: 11 },
          },
        ],
        'suggest',
      ),
      context,
    );
    const changeId = proposal.changeIds[0];
    expect(changeId).toBeDefined();
    const proposed = findBlockById(await stateOf(runtime), ids.first).node;
    expect(proposed.textContent).toBe('Hello world');
    expect(collectMarkKinds(proposed)).toContain('delete');

    await service.applyAtomic(
      identity,
      request([
        {
          operationId: 'accept-delete',
          kind: 'accept_change',
          changeId: changeId ?? '',
        },
      ]),
      context,
    );
    expect(findBlockById(await stateOf(runtime), ids.first).node.textContent).toBe('Hello');
    expect(await service.pendingChangeIds(identity)).toEqual([]);
  });

  it('resolves suggested inserts, replacements, formatting, and block deletion', async () => {
    const { runtime, service } = await setup();
    let document = await stateOf(runtime);
    const inserted = await service.applyAtomic(
      identity,
      request(
        [
          {
            operationId: 'suggest-insert-before',
            kind: 'insert_before',
            anchorBlockId: ids.first,
            expectedAnchorDigest: digestOf(document, ids.first),
            html: '<p>Suggested sibling</p>',
          },
        ],
        'suggest',
      ),
      context,
    );
    await service.applyAtomic(
      identity,
      request([
        {
          operationId: 'reject-insert',
          kind: 'reject_change',
          changeId: inserted.changeIds[0] ?? '',
        },
      ]),
      context,
    );
    expect((await stateOf(runtime)).textContent.includes('Suggested sibling')).toBe(false);

    document = await stateOf(runtime);
    const replaced = await service.applyAtomic(
      identity,
      request(
        [
          {
            operationId: 'suggest-replace-text',
            kind: 'replace_text',
            blockId: ids.first,
            expectedBlockDigest: digestOf(document, ids.first),
            range: { from: 6, to: 11 },
            text: 'team',
          },
        ],
        'suggest',
      ),
      context,
    );
    await service.applyAtomic(
      identity,
      request([
        {
          operationId: 'accept-replace-text',
          kind: 'accept_change',
          changeId: replaced.changeIds[0] ?? '',
        },
      ]),
      context,
    );
    expect(findBlockById(await stateOf(runtime), ids.first).node.textContent).toBe('Hello team');

    document = await stateOf(runtime);
    const formatted = await service.applyAtomic(
      identity,
      request(
        [
          {
            operationId: 'suggest-format',
            kind: 'format_text',
            blockId: ids.first,
            expectedBlockDigest: digestOf(document, ids.first),
            range: { from: 0, to: 5 },
            action: 'add',
            mark: { type: 'italic' },
          },
        ],
        'suggest',
      ),
      context,
    );
    await service.applyAtomic(
      identity,
      request([
        {
          operationId: 'reject-format',
          kind: 'reject_change',
          changeId: formatted.changeIds[0] ?? '',
        },
      ]),
      context,
    );
    expect(findBlockById(await stateOf(runtime), ids.first).node.firstChild?.marks).toHaveLength(0);

    document = await stateOf(runtime);
    const deleted = await service.applyAtomic(
      identity,
      request(
        [
          {
            operationId: 'suggest-delete-block',
            kind: 'delete_block',
            blockId: ids.second,
            expectedBlockDigest: digestOf(document, ids.second),
          },
        ],
        'suggest',
      ),
      context,
    );
    await service.applyAtomic(
      identity,
      request([
        {
          operationId: 'reject-delete-block',
          kind: 'reject_change',
          changeId: deleted.changeIds[0] ?? '',
        },
      ]),
      context,
    );
    expect(findBlockById(await stateOf(runtime), ids.second).node.textContent).toBe(
      'Second paragraph',
    );
  });
});

function collectMarkKinds(node: ReturnType<typeof findBlockById>['node']): string[] {
  const kinds: string[] = [];
  node.descendants((child) => {
    for (const mark of child.marks) {
      if (mark.type.name === 'diffChange') {
        kinds.push(String(mark.attrs['kind']));
      }
    }
  });
  return kinds;
}

describe('table, durability, isolation, and replay', () => {
  it('inserts a row and deletes a column while retaining a valid table', async () => {
    const { runtime, service } = await setup();
    let document = await stateOf(runtime);
    const inserted = await service.applyAtomic(
      identity,
      request([
        {
          operationId: 'row-insert',
          kind: 'insert_table_row',
          tableId: ids.table,
          rowIndex: 1,
          position: 'after',
          expectedTableDigest: digestOf(document, ids.table),
        },
      ]),
      context,
    );
    expect(inserted.createdBlockIds.length).toBeGreaterThanOrEqual(4);
    document = await stateOf(runtime);
    expect(findBlockById(document, ids.table).node.childCount).toBe(3);

    await service.applyAtomic(
      identity,
      request([
        {
          operationId: 'column-delete',
          kind: 'delete_table_column',
          tableId: ids.table,
          columnIndex: 1,
          expectedTableDigest: digestOf(document, ids.table),
        },
      ]),
      context,
    );
    const table = findBlockById(await stateOf(runtime), ids.table).node;
    expect(table.childCount).toBe(3);
    expect(table.child(0).childCount).toBe(1);
    expect(() => {
      table.check();
    }).not.toThrow();
  });

  it('inserts a column, deletes a row, and resolves a suggested row', async () => {
    const { runtime, service } = await setup();
    let document = await stateOf(runtime);
    await service.applyAtomic(
      identity,
      request([
        {
          operationId: 'column-insert',
          kind: 'insert_table_column',
          tableId: ids.table,
          columnIndex: 0,
          position: 'after',
          expectedTableDigest: digestOf(document, ids.table),
        },
      ]),
      context,
    );
    document = await stateOf(runtime);
    expect(findBlockById(document, ids.table).node.child(0).childCount).toBe(3);

    await service.applyAtomic(
      identity,
      request([
        {
          operationId: 'row-delete',
          kind: 'delete_table_row',
          tableId: ids.table,
          rowIndex: 1,
          expectedTableDigest: digestOf(document, ids.table),
        },
      ]),
      context,
    );
    document = await stateOf(runtime);
    expect(findBlockById(document, ids.table).node.childCount).toBe(1);

    const suggested = await service.applyAtomic(
      identity,
      request(
        [
          {
            operationId: 'row-insert-suggest',
            kind: 'insert_table_row',
            tableId: ids.table,
            rowIndex: 0,
            position: 'before',
            expectedTableDigest: digestOf(document, ids.table),
          },
        ],
        'suggest',
      ),
      context,
    );
    await service.applyAtomic(
      identity,
      request([
        {
          operationId: 'accept-row-insert',
          kind: 'accept_change',
          changeId: suggested.changeIds[0] ?? '',
        },
      ]),
      context,
    );
    const table = findBlockById(await stateOf(runtime), ids.table).node;
    expect(table.childCount).toBe(2);
    expect(() => {
      table.check();
    }).not.toThrow();
  });

  it('rolls back semantic state when persistence acknowledgement fails', async () => {
    const { persistence, runtime, service } = await setup();
    const before = await stateOf(runtime);
    persistence.failNextStore();
    await expect(
      service.applyAtomic(
        identity,
        request([
          {
            operationId: 'persistence-failure',
            kind: 'insert_text',
            blockId: ids.first,
            expectedBlockDigest: digestOf(before, ids.first),
            offset: 5,
            text: ' lost',
          },
        ]),
        context,
      ),
    ).rejects.toMatchObject({ name: 'RuntimePersistenceError' });
    expect(findBlockById(await stateOf(runtime), ids.first).node.textContent).toBe('Hello world');
  });

  it('honors cancellation and deadlines at the runtime commit boundary', async () => {
    const { runtime, service } = await setup();
    const before = await stateOf(runtime);
    const edit = request([
      {
        operationId: 'cancelled-before-commit',
        kind: 'insert_text',
        blockId: ids.first,
        expectedBlockDigest: digestOf(before, ids.first),
        offset: 5,
        text: ' must-not-commit',
      },
    ]);
    const controller = new AbortController();
    controller.abort();

    for (const control of [
      { signal: controller.signal },
      { deadline: new Date(0) },
    ] satisfies readonly Pick<ApplyContext, 'deadline' | 'signal'>[]) {
      await expect(
        service.applyAtomic(identity, edit, {
          authorization,
          ...control,
        }),
      ).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' });
    }

    expect(findBlockById(await stateOf(runtime), ids.first).node.textContent).toBe('Hello world');
  });

  it('isolates the same document ID across tenants and incarnations', async () => {
    const { runtime, service } = await setup();
    const otherIdentity = { ...identity, tenantId: 'tenant-2' };
    await service.seed({
      identity: otherIdentity,
      document: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            attrs: {
              blockId: ids.first,
              diffChangeId: null,
              diffChangeKind: null,
            },
            content: [{ type: 'text', text: 'Other tenant' }],
          },
        ],
      },
    });
    expect(findBlockById(await stateOf(runtime), ids.first).node.textContent).toBe('Hello world');
    expect(findBlockById(await stateOf(runtime, otherIdentity), ids.first).node.textContent).toBe(
      'Other tenant',
    );
  });

  it('returns the original generated IDs through core idempotent replay', async () => {
    const { runtime, service } = await setup();
    const audit = new MemoryAuditSink();
    const editor = new EditorService({
      documents: service,
      authorization: new PermissionAuthorizationPolicy(),
      idempotency: new MemoryIdempotencyLedger(),
      audit,
    });
    const before = await stateOf(runtime);
    const edit = request(
      [
        {
          operationId: 'replay-insert',
          kind: 'insert_after',
          anchorBlockId: ids.first,
          expectedAnchorDigest: digestOf(before, ids.first),
          html: '<p>Inserted once</p>',
        },
      ],
      'direct',
      'idem-replay-1234',
    );
    const first = await editor.applyEdits(edit, context);
    const replay = await editor.applyEdits(edit, context);
    expect(first.createdBlockIds).toHaveLength(1);
    expect(replay.createdBlockIds).toEqual(first.createdBlockIds);
    expect(replay.idempotentReplay).toBe(true);
    expect(
      listBlockSummaries(await stateOf(runtime)).filter(
        ({ id }) => id === first.createdBlockIds[0],
      ),
    ).toHaveLength(1);
    expect(audit.events()).toHaveLength(1);
  });
});
