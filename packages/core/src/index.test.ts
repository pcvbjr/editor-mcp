import { describe, expect, it, vi } from 'vitest';
import { applyEditsResultSchema, auditEventSchema } from '@editor-mcp/protocol';

import {
  DomainError,
  EditorService,
  MemoryAuditSink,
  MemoryIdempotencyLedger,
  PermissionAuthorizationPolicy,
  canonicalJson,
  sha256,
  toErrorEnvelope,
  type ApplyContext,
  type CreateContext,
  type DocumentCreationOutcome,
  type DocumentCreationPort,
  type DocumentIdentity,
  type DocumentMutationPort,
  type DocumentReadPort,
  type DocumentReadResultV1,
  type MutationOutcome,
} from './index.js';

const blockId = '550e8400-e29b-41d4-a716-446655440000';
const digest = `sha256:${'a'.repeat(64)}`;

const request = {
  documentId: 'doc-1',
  documentIncarnation: 'inc-1',
  schemaId: 'editor-mcp/mvp',
  schemaVersion: 1,
  idempotencyKey: 'idem-12345678',
  changeMode: 'direct',
  operations: [
    {
      operationId: 'op-1',
      kind: 'replace_block',
      blockId,
      expectedBlockDigest: digest,
      html: '<p>updated</p>',
    },
  ],
} as const;

const context: ApplyContext = {
  authorization: {
    tenantId: 'tenant-1',
    principalId: 'agent-1',
    principalType: 'human',
    permissions: new Set(['documents:read', 'documents:suggest', 'documents:write']),
    agentRunId: 'run-1',
    traceId: 'trace-1',
  },
};

class FakeDocuments implements DocumentReadPort, DocumentMutationPort, DocumentCreationPort {
  public mutationCount = 0;
  public creationCount = 0;
  public lastIdentity: DocumentIdentity | undefined;
  public readonly outcome: MutationOutcome = {
    status: 'applied',
    beforeRevision: 'rev-1',
    revision: 'rev-2',
    changeSetId: 'change-set-1',
    createdBlockIds: [],
    affectedBlockIds: [blockId],
    changeIds: [],
    conflicts: [],
    acknowledgement: {
      level: 'snapshot',
      sequence: 2,
      storedAt: '2026-07-17T00:00:00.000Z',
    },
  };

  public async readDocument(): Promise<undefined> {
    return undefined;
  }

  public async applyAtomic(identity: DocumentIdentity): Promise<MutationOutcome> {
    this.mutationCount += 1;
    this.lastIdentity = identity;
    return this.outcome;
  }

  public async createBlank(identity: DocumentIdentity): Promise<DocumentCreationOutcome> {
    this.creationCount += 1;
    this.lastIdentity = identity;
    return {
      created: this.creationCount === 1,
      revision: 'rev-created',
      acknowledgement: {
        level: 'snapshot',
        sequence: 1,
        storedAt: '2026-07-17T00:00:00.000Z',
      },
    };
  }
}

function service(documents = new FakeDocuments()) {
  const audit = new MemoryAuditSink();
  return {
    documents,
    audit,
    service: new EditorService({
      documents,
      authorization: new PermissionAuthorizationPolicy(),
      idempotency: new MemoryIdempotencyLedger(),
      audit,
      now: () => new Date('2026-07-17T00:00:00.000Z'),
    }),
  };
}

describe('canonical request hashing', () => {
  it('is independent of object key order', () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(sha256(canonicalJson({ b: 2, a: 1 }))).toBe(sha256(canonicalJson({ a: 1, b: 2 })));
  });

  it('rejects cycles and non-finite numbers', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(/cycles/u);
    expect(() => canonicalJson(Number.NaN)).toThrow(/non-finite/u);
  });
});

describe('EditorService', () => {
  it('creates a server-addressed document and returns its editor URL', async () => {
    const setup = service();
    const createContext: CreateContext = {
      authorization: {
        ...context.authorization,
        permissions: new Set(['documents:create']),
      },
    };
    const input = {
      protocolVersion: 1,
      tenantId: 'tenant-1',
      collaborationField: 'default',
      schemaId: 'editor-mcp/mvp',
      schemaVersion: 1,
      idempotencyKey: 'create-document-1',
    } as const;

    const first = await setup.service.createDocument(input, createContext);
    const replay = await setup.service.createDocument(input, createContext);

    expect(first).toMatchObject({
      status: 'created',
      idempotentReplay: false,
      revision: 'rev-created',
    });
    expect(first.editorUrl).toContain(first.documentId);
    expect(replay).toMatchObject({
      status: 'existing',
      idempotentReplay: true,
      documentId: first.documentId,
      documentIncarnation: first.documentIncarnation,
    });
  });

  it('rejects direct mutations from agent principals before authorization or persistence', async () => {
    const setup = service();
    const agentContext: ApplyContext = {
      authorization: {
        ...context.authorization,
        principalType: 'agent',
        agentRunId: 'run-1',
      },
    };
    await expect(setup.service.applyEdits(request, agentContext)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      message: 'Agent principals may only submit suggested edits',
    });
    expect(setup.documents.mutationCount).toBe(0);
  });

  it('rejects review decisions from agents even under a permissive permission set', async () => {
    const setup = service();
    await expect(
      setup.service.applyEdits(
        {
          ...request,
          changeMode: 'suggest',
          operations: [
            {
              operationId: 'review-1',
              kind: 'accept_change',
              changeId: 'change-1',
            },
          ],
        },
        {
          authorization: {
            ...context.authorization,
            principalType: 'agent',
            permissions: new Set(['documents:suggest', 'suggestions:review']),
          },
        },
      ),
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      message: 'Agent principals cannot accept or reject suggestions',
    });
    expect(setup.documents.mutationCount).toBe(0);
  });

  it('authorizes legacy and strict v1 reads through one domain service', async () => {
    const v1Result: DocumentReadResultV1 = {
      protocolVersion: 1,
      tenantId: 'tenant-1',
      documentId: 'doc-1',
      documentIncarnation: 'inc-1',
      collaborationField: 'default',
      schemaId: 'editor-mcp/mvp',
      schemaVersion: 1,
      revision: 'rev-1',
      capabilities: {
        reviewModes: ['direct', 'suggest'],
        operations: ['replace_block'],
        representationProfiles: ['agent-html/v1'],
      },
      representation: {
        profile: 'agent-html/v1',
        html: '<p>Hello</p>',
      },
      blocks: [],
      truncated: false,
    };
    const documents: DocumentReadPort & DocumentMutationPort = {
      readDocument: () =>
        Promise.resolve({
          documentId: 'doc-1',
          documentIncarnation: 'inc-1',
          schemaId: 'editor-mcp/mvp',
          schemaVersion: 1,
          revision: 'rev-1',
          html: '<p>Hello</p>',
          blocks: [],
        }),
      readDocumentV1: () => Promise.resolve(v1Result),
      applyAtomic: () => Promise.resolve(new FakeDocuments().outcome),
    };
    const editor = new EditorService({
      documents,
      authorization: new PermissionAuthorizationPolicy(),
      idempotency: new MemoryIdempotencyLedger(),
      audit: new MemoryAuditSink(),
    });
    await expect(
      editor.readDocument(
        {
          documentId: 'doc-1',
          documentIncarnation: 'inc-1',
          schemaId: 'editor-mcp/mvp',
          schemaVersion: 1,
        },
        { authorization: context.authorization },
      ),
    ).resolves.toMatchObject({ revision: 'rev-1' });
    await expect(
      editor.readDocumentV1(
        {
          protocolVersion: 1,
          tenantId: 'tenant-1',
          documentId: 'doc-1',
          documentIncarnation: 'inc-1',
          collaborationField: 'default',
          schemaId: 'editor-mcp/mvp',
          schemaVersion: 1,
          selection: { kind: 'document' },
          representationProfile: 'agent-html/v1',
        },
        { authorization: context.authorization },
      ),
    ).resolves.toEqual(v1Result);
    await expect(
      editor.readDocumentV1(
        {
          protocolVersion: 1,
          tenantId: 'other-tenant',
          documentId: 'doc-1',
          documentIncarnation: 'inc-1',
          collaborationField: 'default',
          schemaId: 'editor-mcp/mvp',
          schemaVersion: 1,
          selection: { kind: 'document' },
          representationProfile: 'agent-html/v1',
        },
        { authorization: context.authorization },
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('rejects invalid reads and reports documents that do not exist', async () => {
    const setup = service();
    await expect(
      setup.service.readDocument(
        {
          documentId: 'missing',
          documentIncarnation: 'inc-1',
          schemaId: 'editor-mcp/mvp',
          schemaVersion: 1,
        },
        { authorization: context.authorization },
      ),
    ).rejects.toMatchObject({ code: 'DOCUMENT_NOT_FOUND' });
    await expect(
      setup.service.readDocumentV1(
        { protocolVersion: 2 },
        { authorization: context.authorization },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('applies, durably acknowledges, audits, and replays one semantic effect', async () => {
    const setup = service();
    const first = await setup.service.applyEdits(request, context);
    const replay = await setup.service.applyEdits(request, context);

    expect(first).toMatchObject({
      status: 'applied',
      idempotentReplay: false,
      committedRevision: 'rev-2',
      acknowledgement: { level: 'document_and_audit' },
    });
    expect(replay).toMatchObject({
      status: 'duplicate',
      idempotentReplay: true,
      committedRevision: 'rev-2',
      changeSetId: first.changeSetId,
    });
    expect(() => applyEditsResultSchema.parse(first)).not.toThrow();
    expect(() => applyEditsResultSchema.parse(replay)).not.toThrow();
    expect(setup.documents.mutationCount).toBe(1);
    expect(setup.audit.events()).toHaveLength(1);
    expect(setup.audit.events()[0]).not.toHaveProperty('html');
    expect(() => auditEventSchema.parse(setup.audit.events()[0])).not.toThrow();
  });

  it('serializes concurrent duplicate requests', async () => {
    const setup = service();
    const append = vi.spyOn(setup.audit, 'append');
    const original = setup.documents.applyAtomic.bind(setup.documents);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    setup.documents.applyAtomic = vi.fn(async (identity: DocumentIdentity) => {
      await gate;
      return original(identity);
    });

    const first = setup.service.applyEdits(request, context);
    const second = setup.service.applyEdits(request, context);
    release?.();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.idempotentReplay).toBe(false);
    expect(secondResult.idempotentReplay).toBe(true);
    expect(setup.documents.mutationCount).toBe(1);
    expect(append).toHaveBeenCalledTimes(2);
    expect(setup.audit.events()).toHaveLength(1);
  });

  it('retries a durably queued audit event on replay after delivery failure', async () => {
    const documents = new FakeDocuments();
    const delivered = new MemoryAuditSink();
    let deliveryAttempts = 0;
    const editor = new EditorService({
      documents,
      authorization: new PermissionAuthorizationPolicy(),
      idempotency: new MemoryIdempotencyLedger(),
      audit: {
        append: async (event) => {
          deliveryAttempts += 1;
          if (deliveryAttempts === 1) {
            throw new Error('audit transport unavailable');
          }
          await delivered.append(event);
        },
      },
    });
    const first = await editor.applyEdits(request, context);
    const replay = await editor.applyEdits(request, context);
    const secondReplay = await editor.applyEdits(request, context);
    expect(first.status).toBe('applied');
    expect(replay.status).toBe('duplicate');
    expect(secondReplay.status).toBe('duplicate');
    expect(documents.mutationCount).toBe(1);
    expect(deliveryAttempts).toBe(3);
    expect(delivered.events()).toHaveLength(1);
  });

  it('records the authorization policy decision that allowed the mutation', async () => {
    const documents = new FakeDocuments();
    const audit = new MemoryAuditSink();
    const editor = new EditorService({
      documents,
      authorization: {
        authorize: () =>
          Promise.resolve({
            allowed: true,
            policyVersion: 'tenant-rbac/42',
            reason: 'document-role-match',
          }),
      },
      idempotency: new MemoryIdempotencyLedger(),
      audit,
    });

    await editor.applyEdits(request, context);

    expect(audit.events()[0]?.authorizationDecision).toMatchObject({
      policyVersion: 'tenant-rbac/42',
      effect: 'allow',
      reasonCode: 'document-role-match',
    });
  });

  it('replays a conflict as a conflict instead of an invalid duplicate', async () => {
    const setup = service();
    const conflict: MutationOutcome = {
      status: 'conflict',
      beforeRevision: 'rev-1',
      revision: 'rev-1',
      createdBlockIds: [],
      affectedBlockIds: [],
      changeIds: [],
      conflicts: [
        {
          code: 'TARGET_CHANGED',
          operationId: 'op-1',
          targetId: blockId,
          currentDigest: digest,
          currentRevision: 'rev-1',
          retryHint: 'reread_target',
        },
      ],
    };
    setup.documents.applyAtomic = vi.fn(async () => conflict);
    const first = await setup.service.applyEdits(request, context);
    const replay = await setup.service.applyEdits(request, context);
    expect(first.status).toBe('conflict');
    expect(replay).toMatchObject({
      status: 'conflict',
      idempotentReplay: true,
    });
    expect(() => applyEditsResultSchema.parse(replay)).not.toThrow();
  });

  it('rejects mismatched reuse of an idempotency key', async () => {
    const setup = service();
    await setup.service.applyEdits(request, context);
    await expect(
      setup.service.applyEdits(
        {
          ...request,
          operations: [
            {
              ...request.operations[0],
              html: '<p>different</p>',
            },
          ],
        },
        context,
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' });
    expect(setup.documents.mutationCount).toBe(1);
  });

  it('checks authorization before touching the adapter', async () => {
    const setup = service();
    const denied: ApplyContext = {
      authorization: {
        ...context.authorization,
        permissions: new Set(['documents:read']),
      },
    };
    await expect(setup.service.applyEdits(request, denied)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(setup.documents.mutationCount).toBe(0);
  });

  it('requires both review and write permission for a mixed direct batch', async () => {
    const setup = service();
    const reviewOnly: ApplyContext = {
      authorization: {
        ...context.authorization,
        permissions: new Set(['suggestions:review']),
      },
    };
    await expect(
      setup.service.applyEdits(
        {
          ...request,
          operations: [
            {
              operationId: 'resolve-1',
              kind: 'accept_change',
              changeId: 'change-1',
            },
            {
              operationId: 'delete-1',
              kind: 'delete_block',
              blockId,
              expectedBlockDigest: digest,
            },
          ],
        },
        reviewOnly,
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(setup.documents.mutationCount).toBe(0);
  });

  it('honors tenant and collaboration-field identity from the request', async () => {
    const setup = service();
    await setup.service.applyEdits(
      { ...request, tenantId: 'tenant-1', collaborationField: 'body' },
      context,
    );
    expect(setup.documents.lastIdentity).toMatchObject({
      tenantId: 'tenant-1',
      collaborationField: 'body',
    });

    await expect(
      setup.service.applyEdits(
        {
          ...request,
          idempotencyKey: 'idem-other-tenant',
          tenantId: 'tenant-2',
        },
        context,
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('requires a persistence acknowledgement for applied mutations', async () => {
    const setup = service();
    Object.assign(setup.documents.outcome, { acknowledgement: undefined });
    await expect(setup.service.applyEdits(request, context)).rejects.toMatchObject({
      code: 'DOCUMENT_UNAVAILABLE',
    });
  });

  it('honors cancellation before commit', async () => {
    const setup = service();
    const controller = new AbortController();
    controller.abort();
    await expect(
      setup.service.applyEdits(request, {
        ...context,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' });
    expect(setup.documents.mutationCount).toBe(0);
  });
});

describe('safe public errors', () => {
  it('does not expose unknown errors', () => {
    expect(toErrorEnvelope(new Error('database password leaked'))).toEqual({
      version: 1,
      error: {
        code: 'INTERNAL',
        message: 'The document operation could not be completed',
        retryable: false,
      },
    });
  });

  it('retains safe domain details', () => {
    expect(
      toErrorEnvelope(
        new DomainError('TARGET_CHANGED', 'Target changed', false, {
          targetId: blockId,
        }),
      ),
    ).toMatchObject({
      error: {
        code: 'TARGET_CHANGED',
        details: { targetId: blockId },
      },
    });
  });
});
