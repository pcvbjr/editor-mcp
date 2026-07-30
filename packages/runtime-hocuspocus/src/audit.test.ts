import { describe, expect, it } from 'vitest';

import type { AuditEnvelope } from '@editor-mcp/core';

import { DurableYjsAuditSink, MemoryYjsPersistence, type YjsPersistence } from './index.js';

const event: AuditEnvelope = {
  protocolVersion: 1,
  auditEventId: 'audit-1',
  eventType: 'document.edit',
  document: {
    tenantId: 'tenant-1',
    documentId: 'doc-1',
    documentIncarnation: 'inc-1',
    collaborationField: 'default',
    schemaId: 'editor-mcp/mvp',
    schemaVersion: 1,
  },
  actor: {
    principalId: 'agent-1',
    principalType: 'agent',
    agentRunId: 'run-1',
  },
  operationIds: ['op-1'],
  adapterVersion: 'adapter-tiptap-hocuspocus/v1',
  targetPreconditions: [
    {
      operationId: 'op-1',
      operationKind: 'replace_block',
      targetType: 'block',
      targetReference: '00000000-0000-4000-8000-000000000001',
      expectedDigest: `sha256:${'c'.repeat(64)}`,
    },
  ],
  beforeRevision: 'rev-1',
  afterRevision: 'rev-2',
  beforeHash: `sha256:${'d'.repeat(64)}`,
  afterHash: `sha256:${'e'.repeat(64)}`,
  generatedBlockIds: [],
  generatedChangeIds: [],
  authorizationDecision: {
    decisionId: 'decision-1',
    policyVersion: 'policy/v1',
    effect: 'allow',
    reasonCode: 'authorized',
  },
  outcome: { status: 'applied' },
  acknowledgement: {
    protocolVersion: 1,
    level: 'document_and_audit',
    idempotencyReceiptDurable: true,
    documentStateDurable: true,
    auditDurableOrQueued: true,
    acknowledgedAt: '2026-07-17T00:00:00.000Z',
    persistenceRevision: 'rev-2',
  },
  traceId: 'trace-1',
  requestHash: `sha256:${'a'.repeat(64)}`,
  idempotencyKeyHash: `sha256:${'b'.repeat(64)}`,
  serverTimestamp: '2026-07-17T00:00:00.000Z',
};

describe('DurableYjsAuditSink', () => {
  it('persists an append-only content-free event', async () => {
    const persistence = new MemoryYjsPersistence();
    const sink = new DurableYjsAuditSink({ persistence });
    await sink.append(event);
    await expect(sink.read(event)).resolves.toEqual(event);
    await expect(sink.append(event)).resolves.toBeUndefined();
  });

  it('rejects event ID reuse with different content', async () => {
    const sink = new DurableYjsAuditSink({
      persistence: new MemoryYjsPersistence(),
    });
    await sink.append(event);
    await expect(sink.append({ ...event, outcome: { status: 'conflict' } })).rejects.toThrow(
      /reused/u,
    );
  });

  it('serializes concurrent appends of the same event ID', async () => {
    const sink = new DurableYjsAuditSink({
      persistence: new MemoryYjsPersistence(),
    });
    const conflicting: AuditEnvelope = {
      ...event,
      outcome: { status: 'conflict' },
    };

    const results = await Promise.allSettled([sink.append(event), sink.append(conflicting)]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejection = results.find((result) => result.status === 'rejected');
    if (rejection?.status !== 'rejected' || !(rejection.reason instanceof Error)) {
      throw new Error('Expected the conflicting append to fail with an Error');
    }
    expect(rejection.reason.message).toMatch(/reused/u);
  });

  it('isolates the same event ID by the complete document identity', async () => {
    const sink = new DurableYjsAuditSink({
      persistence: new MemoryYjsPersistence(),
    });
    const otherField: AuditEnvelope = {
      ...event,
      document: {
        ...event.document,
        collaborationField: 'sidebar',
      },
    };

    await sink.append(event);
    await sink.append(otherField);

    await expect(sink.read(event)).resolves.toEqual(event);
    await expect(sink.read(otherField)).resolves.toEqual(otherField);
  });

  it('fails closed when persistence returns an event from another identity', async () => {
    const backing = new MemoryYjsPersistence();
    let storedName: string | undefined;
    const aliasingPersistence: YjsPersistence = {
      load: (name) => backing.load(storedName ?? name),
      store: (name, update) => {
        storedName ??= name;
        return backing.store(storedName, update);
      },
      storeIfSequence: (name, expectedSequence, update) => {
        storedName ??= name;
        return backing.storeIfSequence(storedName, expectedSequence, update);
      },
    };
    const sink = new DurableYjsAuditSink({ persistence: aliasingPersistence });
    await sink.append(event);

    await expect(
      sink.read({
        auditEventId: event.auditEventId,
        document: {
          ...event.document,
          collaborationField: 'sidebar',
        },
      }),
    ).rejects.toThrow(/document identity/u);
  });
});
