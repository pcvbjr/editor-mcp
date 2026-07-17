import { describe, expect, it } from 'vitest';

import {
  canonicalizeDocument,
  digestBlock,
  findBlockById,
  type ProseMirrorNodeJson,
} from '@editor-mcp/adapter-tiptap-hocuspocus';
import {
  MemoryIdempotencyLedger,
  type AuthorizationContext,
  type DocumentIdentity,
  type IdempotencyClaim,
  type IdempotencyLedger,
  type IdempotencyReceipt,
  type IdempotencyScope,
} from '@editor-mcp/core';
import { MemoryYjsPersistence } from '@editor-mcp/runtime-hocuspocus';

import { createReferenceStack } from './composition.js';

const blockId = '00000000-0000-4000-8000-000000000001';
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
  permissions: new Set(['documents:read', 'documents:write']),
  agentRunId: 'run-1',
  traceId: 'trace-1',
};
const document: ProseMirrorNodeJson = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      attrs: {
        blockId,
        diffChangeId: null,
        diffChangeKind: null,
      },
      content: [{ type: 'text', text: 'Before' }],
    },
  ],
};

class FailFirstCompletionLedger implements IdempotencyLedger {
  readonly #delegate = new MemoryIdempotencyLedger();
  public attemptedReceipt: IdempotencyReceipt | undefined;
  public abortCount = 0;

  public claim(scope: IdempotencyScope, requestHash: string): Promise<IdempotencyClaim> {
    return this.#delegate.claim(scope, requestHash);
  }

  public complete(
    _scope: IdempotencyScope,
    _leaseId: string,
    receipt: IdempotencyReceipt,
  ): Promise<void> {
    this.attemptedReceipt = structuredClone(receipt);
    return Promise.reject(new Error('Injected receipt persistence failure'));
  }

  public abort(scope: IdempotencyScope, leaseId: string, error: unknown): Promise<void> {
    this.abortCount += 1;
    return this.#delegate.abort(scope, leaseId, error);
  }
}

describe('production vertical-slice composition', () => {
  it('persists one semantic effect and replays it after a full stack reload', async () => {
    const persistence = new MemoryYjsPersistence();
    const firstStack = createReferenceStack({
      persistence,
      authenticate: async () => authorization,
    });
    await firstStack.documents.seed({ identity, document });
    const before = await firstStack.runtime.read(identity);
    const parsed = findBlockById(
      canonicalizeDocument(before?.document as unknown as ProseMirrorNodeJson),
      blockId,
    ).node;
    const edit = {
      documentId: identity.documentId,
      documentIncarnation: identity.documentIncarnation,
      collaborationField: identity.collaborationField,
      schemaId: 'editor-mcp/mvp',
      schemaVersion: 1,
      idempotencyKey: 'idem-durable-replay',
      changeMode: 'direct',
      operations: [
        {
          operationId: 'replace-1',
          kind: 'replace_block',
          blockId,
          expectedBlockDigest: digestBlock(parsed),
          html: '<p>After</p>',
        },
      ],
    };
    const first = await firstStack.editor.applyEdits(edit, {
      authorization,
    });
    expect(first).toMatchObject({
      status: 'applied',
      idempotentReplay: false,
      acknowledgement: { level: 'document_and_audit' },
    });
    expect(first.createdBlockIds).toHaveLength(1);
    expect(first.affectedBlockIds).toContain(blockId);
    await firstStack.runtime.unload(identity);

    const reloadedStack = createReferenceStack({
      persistence,
      authenticate: async () => authorization,
    });
    const replay = await reloadedStack.editor.applyEdits(edit, {
      authorization,
    });
    expect(replay).toMatchObject({
      status: 'duplicate',
      idempotentReplay: true,
      createdBlockIds: first.createdBlockIds,
    });
    const read = await reloadedStack.editor.readDocument(
      {
        documentId: identity.documentId,
        documentIncarnation: identity.documentIncarnation,
        collaborationField: identity.collaborationField,
        schemaId: 'editor-mcp/mvp',
        schemaVersion: 1,
      },
      { authorization },
    );
    expect(read.html).toContain('After');
    expect(read.html).not.toContain('Before');
    expect(read.html).toContain(first.createdBlockIds[0]);
    expect(read.html).not.toContain(blockId);
  });

  it('recovers a committed mutation after receipt persistence fails without applying it twice', async () => {
    const persistence = new MemoryYjsPersistence();
    const failingLedger = new FailFirstCompletionLedger();
    const firstStack = createReferenceStack({
      persistence,
      authenticate: async () => authorization,
      idempotency: failingLedger,
    });
    await firstStack.documents.seed({ identity, document });
    const before = await firstStack.runtime.read(identity);
    const anchor = findBlockById(
      canonicalizeDocument(before?.document as unknown as ProseMirrorNodeJson),
      blockId,
    ).node;
    const edit = {
      documentId: identity.documentId,
      documentIncarnation: identity.documentIncarnation,
      collaborationField: identity.collaborationField,
      schemaId: 'editor-mcp/mvp',
      schemaVersion: 1,
      idempotencyKey: 'idem-receipt-recovery',
      changeMode: 'direct',
      operations: [
        {
          operationId: 'insert-1',
          kind: 'insert_after',
          anchorBlockId: blockId,
          expectedAnchorDigest: digestBlock(anchor),
          html: '<p>Inserted exactly once</p>',
        },
      ],
    };

    await expect(firstStack.editor.applyEdits(edit, { authorization })).rejects.toThrow(
      'Injected receipt persistence failure',
    );
    expect(failingLedger.abortCount).toBe(0);
    const attemptedResult = failingLedger.attemptedReceipt?.result;
    expect(attemptedResult?.createdBlockIds).toHaveLength(1);
    await firstStack.runtime.unload(identity);

    const recoveredStack = createReferenceStack({
      persistence,
      authenticate: async () => authorization,
      idempotency: new MemoryIdempotencyLedger(),
    });
    await expect(
      recoveredStack.editor.applyEdits(
        {
          ...edit,
          operations: [
            {
              ...edit.operations[0],
              html: '<p>A different payload</p>',
            },
          ],
        },
        { authorization },
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' });
    const recovered = await recoveredStack.editor.applyEdits(edit, { authorization });
    expect(recovered).toMatchObject({
      status: 'duplicate',
      idempotentReplay: true,
      committedRevision: attemptedResult?.committedRevision,
      createdBlockIds: attemptedResult?.createdBlockIds,
    });
    const read = await recoveredStack.editor.readDocument(
      {
        documentId: identity.documentId,
        documentIncarnation: identity.documentIncarnation,
        collaborationField: identity.collaborationField,
        schemaId: 'editor-mcp/mvp',
        schemaVersion: 1,
      },
      { authorization },
    );
    expect(read.html.match(/Inserted exactly once/gu)).toHaveLength(1);
  });
});
