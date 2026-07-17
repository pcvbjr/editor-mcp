import { describe, expect, it } from 'vitest';

import type { IdempotencyReceipt, IdempotencyScope } from '@editor-mcp/core';

import { DurableYjsIdempotencyLedger, MemoryYjsPersistence } from './index.js';

const scope: IdempotencyScope = {
  tenantId: 'tenant-1',
  principalId: 'agent-1',
  documentId: 'doc-1',
  documentIncarnation: 'inc-1',
  collaborationField: 'default',
  schemaId: 'editor-mcp/mvp',
  schemaVersion: 1,
  key: 'idem-12345678',
};

const receipt: IdempotencyReceipt = {
  requestHash: `sha256:${'a'.repeat(64)}`,
  afterRevision: 'rev-2',
  result: {
    protocolVersion: 1,
    tenantId: scope.tenantId,
    documentId: scope.documentId,
    documentIncarnation: scope.documentIncarnation,
    collaborationField: scope.collaborationField,
    schemaId: 'editor-mcp/mvp',
    schemaVersion: 1,
    status: 'applied',
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
  },
  completedAt: '2026-07-17T00:00:00.000Z',
};

describe('DurableYjsIdempotencyLedger', () => {
  it('grants exactly one cross-instance claim and lets the other instance observe completion', async () => {
    const persistence = new MemoryYjsPersistence();
    const firstLedger = new DurableYjsIdempotencyLedger({ persistence });
    const secondLedger = new DurableYjsIdempotencyLedger({ persistence });
    const [firstClaim, secondClaim] = await Promise.all([
      firstLedger.claim(scope, receipt.requestHash),
      secondLedger.claim(scope, receipt.requestHash),
    ]);
    expect([firstClaim.kind, secondClaim.kind].sort()).toEqual(['claimed', 'wait']);

    const claimed = firstClaim.kind === 'claimed' ? firstClaim : secondClaim;
    const waiting = firstClaim.kind === 'wait' ? firstClaim : secondClaim;
    if (claimed.kind !== 'claimed' || waiting.kind !== 'wait') {
      return;
    }
    const completingLedger = new DurableYjsIdempotencyLedger({ persistence });
    await completingLedger.complete(scope, claimed.leaseId, receipt);
    await expect(waiting.receipt).resolves.toEqual(receipt);

    const reloaded = new DurableYjsIdempotencyLedger({ persistence });
    await expect(reloaded.claim(scope, receipt.requestHash)).resolves.toMatchObject({
      kind: 'replay',
      receipt,
    });
  });

  it('rejects mismatched key reuse and permits retry after abort', async () => {
    const persistence = new MemoryYjsPersistence();
    const ledger = new DurableYjsIdempotencyLedger({ persistence });
    const claim = await ledger.claim(scope, receipt.requestHash);
    expect(claim.kind).toBe('claimed');
    await expect(ledger.claim(scope, `sha256:${'b'.repeat(64)}`)).resolves.toEqual({
      kind: 'mismatch',
    });
    if (claim.kind !== 'claimed') {
      return;
    }
    await ledger.abort(scope, claim.leaseId, new Error('retry'));
    await expect(ledger.claim(scope, receipt.requestHash)).resolves.toMatchObject({
      kind: 'claimed',
    });
  });

  it('rejects a wait when its durable lease expires instead of hanging', async () => {
    const persistence = new MemoryYjsPersistence();
    const owner = new DurableYjsIdempotencyLedger({
      persistence,
      pendingLeaseMs: 20,
    });
    const observer = new DurableYjsIdempotencyLedger({
      persistence,
      pendingLeaseMs: 20,
    });
    const claim = await owner.claim(scope, receipt.requestHash);
    expect(claim.kind).toBe('claimed');
    const waiting = await observer.claim(scope, receipt.requestHash);
    expect(waiting.kind).toBe('wait');
    if (waiting.kind !== 'wait') {
      return;
    }

    await expect(waiting.receipt).rejects.toThrow(
      'Durable idempotency lease expired before completion',
    );
    await expect(observer.claim(scope, receipt.requestHash)).resolves.toMatchObject({
      kind: 'claimed',
    });
  });

  it('does not overwrite a winning complete or abort during a cross-instance race', async () => {
    const persistence = new MemoryYjsPersistence();
    const completer = new DurableYjsIdempotencyLedger({ persistence });
    const aborter = new DurableYjsIdempotencyLedger({ persistence });
    const claim = await completer.claim(scope, receipt.requestHash);
    if (claim.kind !== 'claimed') {
      throw new Error('Expected the initial lease to be claimed');
    }

    const [completion, abortion] = await Promise.allSettled([
      completer.complete(scope, claim.leaseId, receipt),
      aborter.abort(scope, claim.leaseId, new Error('aborted')),
    ]);
    expect(abortion.status).toBe('fulfilled');

    const observed = await new DurableYjsIdempotencyLedger({ persistence }).claim(
      scope,
      receipt.requestHash,
    );
    const expectedObservation =
      completion.status === 'fulfilled' ? { kind: 'replay', receipt } : { kind: 'claimed' };
    expect(observed).toMatchObject(expectedObservation);
  });
});
