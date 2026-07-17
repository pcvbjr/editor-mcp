import { describe, expect, it } from 'vitest';

import {
  CONTRACT_COMPATIBILITY_POLICY,
  DOMAIN_ERROR_CODES,
  IDEMPOTENCY_REPLAY_RULES,
  MVP_OPERATION_KINDS,
  applyEditsRequestV1Schema,
  applyEditsResultSchema,
  auditEventSchema,
  auditOutcomeSchema,
  authorizationContextSchema,
  changeMetadataSchema,
  changeStatusSchema,
  documentCapabilitiesSchema,
  documentIdentitySchema,
  documentReadRequestSchema,
  documentReadResultV1Schema,
  editOperationSchema,
  editorFixtureSchema,
  fixtureChangeMetadataSchema,
  fixtureInvariantKindSchema,
  idempotencyReceiptSchema,
  idempotencyReplayDecisionSchema,
  operationPolicyInputSchema,
  operationResultSchema,
  persistenceAcknowledgementSchema,
  policyDecisionSchema,
  publicErrorSchema,
  safeLinkHrefSchema,
} from './index.js';

const BLOCK_1 = '550e8400-e29b-41d4-a716-446655440000';
const BLOCK_2 = '550e8400-e29b-41d4-a716-446655440001';
const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;
const NOW = '2026-07-17T12:00:00Z';

const identity = {
  tenantId: 'tenant_1',
  documentId: 'doc_1',
  documentIncarnation: 'inc_1',
  collaborationField: 'default',
  schemaId: 'editor-mcp/mvp',
  schemaVersion: 1,
} as const;

const actor = {
  principalId: 'principal_1',
  principalType: 'agent',
  agentRunId: 'run_1',
} as const;

const durableAcknowledgement = {
  protocolVersion: 1,
  level: 'document_and_audit',
  idempotencyReceiptDurable: true,
  documentStateDurable: true,
  auditDurableOrQueued: true,
  acknowledgedAt: NOW,
  persistenceRevision: 'persist_1',
  receiptReference: 'receipt_1',
} as const;

const replaceOperation = {
  operationId: 'op_replace',
  kind: 'replace_block',
  blockId: BLOCK_1,
  expectedBlockDigest: DIGEST_A,
  html: '<p>Updated</p>',
} as const;

const appliedOperationResult = {
  operationId: replaceOperation.operationId,
  status: 'applied',
  affectedBlockIds: [BLOCK_1],
  createdBlockIds: [],
  generatedChangeIds: ['change_1'],
} as const;

const appliedResult = {
  protocolVersion: 1,
  ...identity,
  status: 'applied',
  beforeRevision: 'rev_before',
  committedRevision: 'rev_after',
  changeSetId: 'change_set_1',
  idempotentReplay: false,
  createdBlockIds: [],
  affectedBlockIds: [BLOCK_1],
  generatedChangeIds: ['change_1'],
  operationResults: [appliedOperationResult],
  conflicts: [],
  acknowledgement: durableAcknowledgement,
} as const;

describe('version and identity contracts', () => {
  it('publishes a single strict protocol major and explicit replay policy', () => {
    expect(CONTRACT_COMPATIBILITY_POLICY).toMatchObject({
      currentProtocolVersion: 1,
      supportedProtocolVersions: [1],
      unknownFields: 'reject',
      unsupportedVersions: 'reject',
    });
    expect(IDEMPOTENCY_REPLAY_RULES.sameKeySameRequest).toBe('return-original-result');
  });

  it('requires the complete internal document identity', () => {
    expect(documentIdentitySchema.parse(identity)).toEqual(identity);
    expect(() =>
      documentIdentitySchema.parse({
        ...identity,
        collaborationField: undefined,
      }),
    ).toThrow();
    expect(() => documentIdentitySchema.parse({ ...identity, externalSlug: 'article' })).toThrow();
  });
});

describe('capability and read contracts', () => {
  const capabilities = {
    reviewModes: ['direct', 'suggest'],
    operations: [...MVP_OPERATION_KINDS],
    representationProfiles: ['agent-html/v1', 'prosemirror-json/v1'],
  } as const;

  it('advertises every MVP operation and rejects duplicate capabilities', () => {
    expect(documentCapabilitiesSchema.parse(capabilities).operations).toEqual(MVP_OPERATION_KINDS);
    expect(() =>
      documentCapabilitiesSchema.parse({
        ...capabilities,
        operations: ['replace_block', 'replace_block'],
      }),
    ).toThrow(/unique/i);
  });

  it('validates bounded read selection and structured representations', () => {
    expect(
      documentReadRequestSchema.parse({
        protocolVersion: 1,
        ...identity,
        selection: { kind: 'blocks', blockIds: [BLOCK_1] },
        representationProfile: 'agent-html/v1',
        maxBytes: 50_000,
      }).selection.kind,
    ).toBe('blocks');

    expect(
      documentReadResultV1Schema.parse({
        protocolVersion: 1,
        ...identity,
        revision: 'rev_1',
        capabilities,
        representation: {
          profile: 'agent-html/v1',
          html: `<p data-block-id="${BLOCK_1}">Hello</p>`,
        },
        blocks: [
          {
            id: BLOCK_1,
            nodeType: 'paragraph',
            contentDigest: DIGEST_A,
          },
        ],
        truncated: false,
      }).representation.profile,
    ).toBe('agent-html/v1');

    expect(() =>
      documentReadRequestSchema.parse({
        protocolVersion: 1,
        ...identity,
        selection: { kind: 'blocks', blockIds: [BLOCK_1, BLOCK_1] },
        representationProfile: 'agent-html/v1',
      }),
    ).toThrow(/unique/i);
  });
});

describe('complete MVP operation contract', () => {
  const operations = [
    {
      operationId: 'op_1',
      kind: 'insert_before',
      anchorBlockId: BLOCK_1,
      expectedAnchorDigest: DIGEST_A,
      html: '<p>Before</p>',
    },
    {
      operationId: 'op_2',
      kind: 'insert_after',
      anchorBlockId: BLOCK_1,
      html: '<p>After</p>',
    },
    replaceOperation,
    {
      operationId: 'op_4',
      kind: 'delete_block',
      blockId: BLOCK_1,
      expectedBlockDigest: DIGEST_A,
    },
    {
      operationId: 'op_5',
      kind: 'insert_text',
      blockId: BLOCK_1,
      expectedBlockDigest: DIGEST_A,
      offset: 4,
      text: 'new',
    },
    {
      operationId: 'op_6',
      kind: 'delete_text',
      blockId: BLOCK_1,
      expectedBlockDigest: DIGEST_A,
      range: { from: 2, to: 5 },
    },
    {
      operationId: 'op_7',
      kind: 'replace_text',
      blockId: BLOCK_1,
      expectedBlockDigest: DIGEST_A,
      range: { from: 2, to: 5 },
      text: 'replacement',
    },
    {
      operationId: 'op_8',
      kind: 'format_text',
      blockId: BLOCK_1,
      expectedBlockDigest: DIGEST_A,
      range: { from: 0, to: 5 },
      action: 'add',
      mark: { type: 'link', href: 'https://example.com', title: 'Example' },
    },
    {
      operationId: 'op_9',
      kind: 'insert_table_row',
      tableId: BLOCK_2,
      rowIndex: 1,
      expectedTableDigest: DIGEST_B,
      position: 'after',
    },
    {
      operationId: 'op_10',
      kind: 'delete_table_row',
      tableId: BLOCK_2,
      rowIndex: 1,
      expectedTableDigest: DIGEST_B,
    },
    {
      operationId: 'op_11',
      kind: 'insert_table_column',
      tableId: BLOCK_2,
      columnIndex: 1,
      expectedTableDigest: DIGEST_B,
      position: 'before',
    },
    {
      operationId: 'op_12',
      kind: 'delete_table_column',
      tableId: BLOCK_2,
      columnIndex: 1,
      expectedTableDigest: DIGEST_B,
    },
    {
      operationId: 'op_13',
      kind: 'accept_change',
      changeId: 'change_1',
      expectedChangeRevision: DIGEST_A,
    },
    {
      operationId: 'op_14',
      kind: 'reject_change',
      changeId: 'change_2',
    },
  ] as const;

  it.each(operations)('accepts $kind', (operation) => {
    expect(editOperationSchema.parse(operation).kind).toBe(operation.kind);
  });

  it('rejects invalid text ranges, unsafe links, and operation-specific fields', () => {
    expect(() =>
      editOperationSchema.parse({
        operationId: 'op_bad_range',
        kind: 'delete_text',
        blockId: BLOCK_1,
        expectedBlockDigest: DIGEST_A,
        range: { from: 4, to: 4 },
      }),
    ).toThrow(/range/i);

    expect(() =>
      editOperationSchema.parse({
        operationId: 'op_bad_link',
        kind: 'format_text',
        blockId: BLOCK_1,
        expectedBlockDigest: DIGEST_A,
        range: { from: 0, to: 1 },
        action: 'add',
        mark: { type: 'link', href: 'javascript:alert(1)' },
      }),
    ).toThrow(/scheme/i);

    expect(() =>
      editOperationSchema.parse({
        operationId: 'op_bad_delete',
        kind: 'delete_table_row',
        tableId: BLOCK_2,
        rowIndex: 0,
        expectedTableDigest: DIGEST_B,
        position: 'after',
      }),
    ).toThrow();
  });

  it('requires an atomic versioned batch and unique operation IDs', () => {
    const request = {
      protocolVersion: 1,
      ...identity,
      idempotencyKey: 'idempotency_123',
      readRevision: 'rev_1',
      atomic: true,
      changeMode: 'suggest',
      operations: [replaceOperation],
    } as const;

    expect(applyEditsRequestV1Schema.parse(request).atomic).toBe(true);
    expect(() => applyEditsRequestV1Schema.parse({ ...request, atomic: false })).toThrow();
    expect(() =>
      applyEditsRequestV1Schema.parse({
        ...request,
        operations: [replaceOperation, replaceOperation],
      }),
    ).toThrow(/unique/i);
  });
});

describe('results, conflicts, errors, and durability', () => {
  it('accepts a fully acknowledged applied result', () => {
    expect(applyEditsResultSchema.parse(appliedResult)).toMatchObject({
      status: 'applied',
      committedRevision: 'rev_after',
      idempotentReplay: false,
    });
  });

  it('prevents false success before the full durability boundary', () => {
    expect(() =>
      applyEditsResultSchema.parse({
        ...appliedResult,
        acknowledgement: {
          ...durableAcknowledgement,
          level: 'document',
          auditDurableOrQueued: false,
        },
      }),
    ).toThrow(/durable document and audit/i);

    expect(() =>
      persistenceAcknowledgementSchema.parse({
        ...durableAcknowledgement,
        level: 'document',
      }),
    ).toThrow(/inconsistent/i);
  });

  it('requires structured conflict and failure metadata', () => {
    expect(() =>
      applyEditsResultSchema.parse({
        ...appliedResult,
        status: 'conflict',
        committedRevision: undefined,
        operationResults: [
          {
            ...appliedOperationResult,
            status: 'conflict',
          },
        ],
        conflicts: [],
        acknowledgement: {
          protocolVersion: 1,
          level: 'idempotency',
          idempotencyReceiptDurable: true,
          documentStateDurable: false,
          auditDurableOrQueued: false,
          acknowledgedAt: NOW,
        },
      }),
    ).toThrow(/conflict/i);

    expect(() =>
      publicErrorSchema.parse({
        protocolVersion: 1,
        code: 'INVALID_CONTENT',
        message: 'The submitted content is invalid',
        retryable: false,
        documentContent: '<p>secret</p>',
      }),
    ).toThrow();

    expect(DOMAIN_ERROR_CODES).toContain('IDEMPOTENCY_MISMATCH');
  });

  it('marks duplicate outcomes as original-result replays', () => {
    expect(
      applyEditsResultSchema.parse({
        ...appliedResult,
        status: 'duplicate',
        idempotentReplay: true,
        operationResults: [
          {
            ...appliedOperationResult,
            status: 'replayed',
          },
        ],
      }).status,
    ).toBe('duplicate');

    expect(() =>
      applyEditsResultSchema.parse({
        ...appliedResult,
        status: 'duplicate',
      }),
    ).toThrow(/replay/i);
  });
});

describe('change lifecycle and authorization contracts', () => {
  const resolution = {
    outcome: 'accepted',
    operationId: 'op_accept',
    resolvedBy: {
      principalId: 'reviewer_1',
      principalType: 'human',
    },
    resolvedAt: NOW,
    beforeRevision: 'rev_proposed',
    afterRevision: 'rev_accepted',
  } as const;

  const change = {
    protocolVersion: 1,
    changeId: 'change_1',
    changeSetId: 'change_set_1',
    kind: 'replace',
    author: actor,
    createdAt: NOW,
    affectedBlockIds: [BLOCK_1],
  } as const;

  it('publishes all required lifecycle states', () => {
    expect(changeStatusSchema.options).toEqual([
      'proposed',
      'pending',
      'grouped',
      'accepted',
      'rejected',
      'resolved',
    ]);

    expect(changeMetadataSchema.parse({ ...change, status: 'pending' }).status).toBe('pending');
    expect(
      changeMetadataSchema.parse({
        ...change,
        status: 'grouped',
        groupId: 'group_1',
      }).status,
    ).toBe('grouped');
    expect(
      changeMetadataSchema.parse({
        ...change,
        status: 'accepted',
        resolution,
      }).status,
    ).toBe('accepted');
    expect(
      changeMetadataSchema.parse({
        ...change,
        status: 'resolved',
        resolution,
      }).status,
    ).toBe('resolved');
  });

  it('rejects contradictory pending and resolved metadata', () => {
    expect(() =>
      changeMetadataSchema.parse({
        ...change,
        status: 'pending',
        resolution,
      }),
    ).toThrow(/unresolved/i);
    expect(() =>
      changeMetadataSchema.parse({
        ...change,
        status: 'rejected',
        resolution,
      }),
    ).toThrow(/rejected resolution/i);
  });

  it('requires authenticated agent runs and explicit policy constraints', () => {
    const authorization = {
      protocolVersion: 1,
      tenantId: identity.tenantId,
      actor,
      mcpClientId: 'client_1',
      authenticationMethod: 'oauth_access_token',
      authenticatedAt: NOW,
      grantedPermissions: ['documents:suggest'],
    } as const;

    expect(authorizationContextSchema.parse(authorization).actor).toEqual(actor);
    expect(
      operationPolicyInputSchema.parse({
        protocolVersion: 1,
        authorization,
        document: identity,
        changeMode: 'suggest',
        operations: [{ operationId: replaceOperation.operationId, kind: 'replace_block' }],
        ownsTargetSuggestions: false,
      }).operations,
    ).toHaveLength(1);

    expect(() =>
      operationPolicyInputSchema.parse({
        protocolVersion: 1,
        authorization,
        document: identity,
        changeMode: 'direct',
        operations: [{ operationId: replaceOperation.operationId, kind: 'replace_block' }],
        ownsTargetSuggestions: false,
      }),
    ).toThrow(/only submit suggested edits/i);

    expect(() =>
      authorizationContextSchema.parse({
        ...authorization,
        actor: { principalId: 'agent_1', principalType: 'agent' },
      }),
    ).toThrow(/run ID/i);

    expect(() =>
      policyDecisionSchema.parse({
        protocolVersion: 1,
        decisionId: 'decision_1',
        policyVersion: 'policy/v1',
        effect: 'allow',
        requiredPermissions: ['documents:suggest'],
        reasonCode: 'AUTHORIZED',
        decidedAt: NOW,
      }),
    ).toThrow(/constraints/i);
  });
});

describe('idempotency and audit contracts', () => {
  const scope = {
    tenantId: identity.tenantId,
    principalId: actor.principalId,
    documentId: identity.documentId,
    documentIncarnation: identity.documentIncarnation,
    idempotencyKey: 'idempotency_123',
  } as const;

  const receipt = {
    protocolVersion: 1,
    receiptId: 'receipt_1',
    scope,
    requestHash: DIGEST_A,
    beforeRevision: 'rev_before',
    afterRevision: 'rev_after',
    generatedBlockIds: [],
    generatedChangeIds: ['change_1'],
    changeSetId: 'change_set_1',
    finalOutcome: 'applied',
    result: appliedResult,
    createdAt: NOW,
    finalizedAt: NOW,
  } as const;

  it('stores the original generated IDs and result for exact replay', () => {
    expect(idempotencyReceiptSchema.parse(receipt).result).toMatchObject({
      committedRevision: 'rev_after',
      generatedChangeIds: ['change_1'],
    });
    expect(
      idempotencyReplayDecisionSchema.parse({
        protocolVersion: 1,
        scope,
        disposition: 'replay',
        receipt,
      }).disposition,
    ).toBe('replay');
  });

  it('requires different canonical hashes for mismatch decisions', () => {
    const mismatchError = {
      protocolVersion: 1,
      code: 'IDEMPOTENCY_MISMATCH',
      message: 'The key was already used for another request',
      retryable: false,
    } as const;

    expect(() =>
      idempotencyReplayDecisionSchema.parse({
        protocolVersion: 1,
        scope,
        disposition: 'mismatch',
        existingRequestHash: DIGEST_A,
        incomingRequestHash: DIGEST_A,
        error: mismatchError,
      }),
    ).toThrow(/different/i);

    expect(
      idempotencyReplayDecisionSchema.parse({
        protocolVersion: 1,
        scope,
        disposition: 'mismatch',
        existingRequestHash: DIGEST_A,
        incomingRequestHash: DIGEST_B,
        error: mismatchError,
      }).disposition,
    ).toBe('mismatch');
  });

  it('records the content-free durable audit envelope', () => {
    expect(
      auditEventSchema.parse({
        protocolVersion: 1,
        auditEventId: 'audit_1',
        eventType: 'document.edit',
        document: identity,
        actor,
        operationIds: [replaceOperation.operationId],
        changeSetId: 'change_set_1',
        requestHash: DIGEST_A,
        idempotencyKeyHash: DIGEST_B,
        adapterVersion: 'adapter/v1',
        targetPreconditions: [
          {
            operationId: replaceOperation.operationId,
            operationKind: replaceOperation.kind,
            targetType: 'block',
            targetReference: BLOCK_1,
            expectedDigest: DIGEST_A,
          },
        ],
        beforeRevision: 'rev_before',
        afterRevision: 'rev_after',
        beforeHash: DIGEST_A,
        afterHash: DIGEST_B,
        generatedBlockIds: [],
        generatedChangeIds: ['change_1'],
        authorizationDecision: {
          decisionId: 'decision_1',
          policyVersion: 'policy/v1',
          effect: 'allow',
          reasonCode: 'AUTHORIZED',
        },
        outcome: { status: 'applied' },
        acknowledgement: durableAcknowledgement,
        traceId: 'trace_1',
        serverTimestamp: NOW,
      }).eventType,
    ).toBe('document.edit');
  });
});

describe('shared executable fixture contract', () => {
  const beforeState = {
    document: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { blockId: BLOCK_1 },
          content: [{ type: 'text', text: 'Before' }],
        },
      ],
    },
    diffChanges: [],
  } as const;

  const replacementState = {
    document: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { blockId: BLOCK_2 },
          content: [{ type: 'text', text: 'Updated' }],
        },
      ],
    },
    diffChanges: [],
  } as const;

  const fixture = {
    format: 'editor-mcp/fixture',
    formatVersion: 1,
    id: 'replace-block-direct',
    title: 'Replace a block directly',
    description: 'A deterministic replace-block fixture.',
    seed: 42,
    schema: { id: 'editor-mcp/mvp', version: 1 },
    tags: ['replace-block', 'direct'],
    subject: { nodeType: 'paragraph', tracking: 'none' },
    request: {
      documentId: identity.documentId,
      documentIncarnation: identity.documentIncarnation,
      schemaId: identity.schemaId,
      schemaVersion: identity.schemaVersion,
      idempotencyKey: 'idempotency_123',
      changeMode: 'direct',
      operations: [replaceOperation],
    },
    resolution: { kind: 'not_applicable' },
    expected: {
      states: {
        before: beforeState,
        proposed: replacementState,
        accepted: replacementState,
        rejected: replacementState,
      },
      conflicts: [],
      generatedBlockIds: [BLOCK_2],
    },
    invariants: [
      {
        id: 'replacement-block-id-is-new',
        description:
          'Replacing a block retires its target ID and assigns the replacement a new ID.',
      },
    ],
  } as const;

  it('validates the adapter-free catalog envelope and all four states', () => {
    const parsed = editorFixtureSchema.parse(fixture);
    expect(parsed.expected.states).toHaveProperty('before');
    expect(parsed.expected.states).toHaveProperty('proposed');
    expect(parsed.expected.states).toHaveProperty('accepted');
    expect(parsed.expected.states).toHaveProperty('rejected');
  });

  it('defines replacement as identity retirement and rejects the removed preservation invariant', () => {
    expect(fixtureInvariantKindSchema.parse('replacement-block-id-is-new')).toBe(
      'replacement-block-id-is-new',
    );
    expect(() => fixtureInvariantKindSchema.parse('target-block-id-is-preserved')).toThrow();

    const parsed = editorFixtureSchema.parse(fixture);
    expect(parsed.expected.states.before.document).toEqual(beforeState.document);
    expect(parsed.expected.states.proposed.document).toEqual(replacementState.document);
    expect(parsed.expected.generatedBlockIds).toEqual([BLOCK_2]);
  });

  it('rejects duplicate invariant and fixture metadata IDs', () => {
    expect(() =>
      editorFixtureSchema.parse({
        ...fixture,
        invariants: [fixture.invariants[0], fixture.invariants[0]],
      }),
    ).toThrow(/unique/i);
    expect(() =>
      editorFixtureSchema.parse({
        ...fixture,
        tags: ['direct', 'direct'],
      }),
    ).toThrow(/unique/i);
  });
});

describe('defensive contract refinements', () => {
  it('rejects contradictory result, audit, authorization, and receipt states', () => {
    expect(() =>
      operationResultSchema.parse({
        ...appliedOperationResult,
        status: 'conflict',
      }),
    ).toThrow(/conflict metadata/i);
    expect(() =>
      operationResultSchema.parse({
        ...appliedOperationResult,
        status: 'failed',
      }),
    ).toThrow(/public error/i);
    expect(() =>
      operationResultSchema.parse({
        ...appliedOperationResult,
        conflict: {
          protocolVersion: 1,
          code: 'TARGET_CHANGED',
          message: 'changed',
          recovery: { action: 'reread_target' },
        },
      }),
    ).toThrow(/cannot include/i);
    expect(() =>
      applyEditsResultSchema.parse({
        ...appliedResult,
        committedRevision: undefined,
      }),
    ).toThrow(/committed revision/i);
    expect(() =>
      applyEditsResultSchema.parse({
        ...appliedResult,
        status: 'failed',
      }),
    ).toThrow(/public error/i);
    expect(() =>
      applyEditsResultSchema.parse({
        ...appliedResult,
        error: {
          protocolVersion: 1,
          code: 'INTERNAL',
          message: 'failed',
          retryable: false,
        },
      }),
    ).toThrow(/only failed/i);

    expect(() => auditOutcomeSchema.parse({ status: 'failed' })).toThrow(/error code/i);
    expect(() =>
      auditOutcomeSchema.parse({
        status: 'applied',
        errorCode: 'INTERNAL',
      }),
    ).toThrow(/only failed/i);
    expect(() =>
      authorizationContextSchema.parse({
        protocolVersion: 1,
        tenantId: identity.tenantId,
        actor,
        authenticationMethod: 'local',
        authenticatedAt: NOW,
        grantedPermissions: ['documents:read', 'documents:read'],
      }),
    ).toThrow(/unique/i);
    expect(() =>
      policyDecisionSchema.parse({
        protocolVersion: 1,
        decisionId: 'decision_1',
        policyVersion: 'policy/v1',
        effect: 'deny',
        requiredPermissions: ['documents:read'],
        reasonCode: 'DENIED',
        constraints: {
          allowedChangeModes: ['direct'],
          allowedOperationKinds: ['replace_block'],
          maximumOperations: 1,
          requireTargetDigests: true,
          allowReviewOwnSuggestions: false,
        },
        decidedAt: NOW,
      }),
    ).toThrow(/cannot grant/i);
    expect(() =>
      persistenceAcknowledgementSchema.parse({
        protocolVersion: 1,
        level: 'document',
        idempotencyReceiptDurable: true,
        documentStateDurable: true,
        auditDurableOrQueued: false,
        acknowledgedAt: NOW,
      }),
    ).toThrow(/persistence revision/i);
    expect(() =>
      applyEditsResultSchema.parse({
        ...appliedResult,
        affectedBlockIds: [BLOCK_1, BLOCK_1],
      }),
    ).toThrow(/unique/i);
    expect(() => safeLinkHrefSchema.parse(`https://exa\u0000mple.test`)).toThrow(/scheme/i);
  });

  it('rejects every contradictory change lifecycle and fixture resolution shape', () => {
    const resolution = {
      outcome: 'accepted',
      operationId: 'op_accept',
      resolvedBy: {
        principalId: 'reviewer_1',
        principalType: 'human',
      },
      resolvedAt: NOW,
      beforeRevision: 'rev_before',
      afterRevision: 'rev_after',
    } as const;
    const change = {
      protocolVersion: 1,
      changeId: 'change_1',
      changeSetId: 'change_set_1',
      kind: 'replace',
      author: actor,
      createdAt: NOW,
      affectedBlockIds: [BLOCK_1],
    } as const;

    expect(() => changeMetadataSchema.parse({ ...change, status: 'grouped' })).toThrow(/group/i);
    expect(() => changeMetadataSchema.parse({ ...change, status: 'accepted' })).toThrow(
      /resolution/i,
    );
    expect(() =>
      changeMetadataSchema.parse({
        ...change,
        status: 'accepted',
        resolution: { ...resolution, outcome: 'rejected' },
      }),
    ).toThrow(/accepted resolution/i);
    expect(() =>
      changeMetadataSchema.parse({
        ...change,
        status: 'pending',
        affectedBlockIds: [BLOCK_1, BLOCK_1],
      }),
    ).toThrow(/unique/i);
    expect(() =>
      changeMetadataSchema.parse({
        ...change,
        status: 'grouped',
        groupId: 'group_1',
        memberChangeIds: ['change_1', 'change_1'],
      }),
    ).toThrow(/unique/i);

    const fixtureChange = {
      id: 'change_1',
      status: 'pending',
      operation: 'insert',
      authorId: 'agent_1',
      authorType: 'agent',
      createdAt: NOW,
    } as const;
    expect(() =>
      fixtureChangeMetadataSchema.parse({
        ...fixtureChange,
        resolvedAt: NOW,
      }),
    ).toThrow(/pending/i);
    expect(() =>
      fixtureChangeMetadataSchema.parse({
        ...fixtureChange,
        resolvedBy: 'reviewer_1',
      }),
    ).toThrow(/pending/i);
    expect(() =>
      fixtureChangeMetadataSchema.parse({
        ...fixtureChange,
        status: 'accepted',
      }),
    ).toThrow(/resolution/i);
    expect(() =>
      fixtureChangeMetadataSchema.parse({
        ...fixtureChange,
        status: 'accepted',
        resolvedAt: NOW,
      }),
    ).toThrow(/resolution/i);
    expect(
      fixtureChangeMetadataSchema.parse({
        ...fixtureChange,
        status: 'rejected',
        resolvedAt: NOW,
        resolvedBy: 'reviewer_1',
      }).status,
    ).toBe('rejected');
  });

  it('rejects inconsistent audit and idempotency state references', () => {
    const baseAudit = {
      protocolVersion: 1,
      auditEventId: 'audit_2',
      eventType: 'document.edit',
      document: identity,
      actor,
      operationIds: ['op_1'],
      requestHash: DIGEST_A,
      idempotencyKeyHash: DIGEST_B,
      adapterVersion: 'adapter/v1',
      targetPreconditions: [],
      beforeRevision: 'rev_before',
      beforeHash: DIGEST_A,
      generatedBlockIds: [],
      generatedChangeIds: [],
      authorizationDecision: {
        decisionId: 'decision_1',
        policyVersion: 'policy/v1',
        effect: 'allow',
        reasonCode: 'AUTHORIZED',
      },
      outcome: { status: 'applied' },
      acknowledgement: durableAcknowledgement,
      traceId: 'trace_1',
      serverTimestamp: NOW,
    } as const;
    expect(() => auditEventSchema.parse(baseAudit)).toThrow(/after-state/i);
    expect(
      auditEventSchema.parse({
        ...baseAudit,
        outcome: { status: 'duplicate' },
        afterRevision: 'rev_after',
        afterHash: DIGEST_B,
      }).outcome.status,
    ).toBe('duplicate');
    expect(() =>
      auditEventSchema.parse({
        ...baseAudit,
        operationIds: ['op_1', 'op_1'],
        afterRevision: 'rev_after',
        afterHash: DIGEST_B,
      }),
    ).toThrow(/unique/i);

    const scope = {
      tenantId: identity.tenantId,
      principalId: actor.principalId,
      documentId: identity.documentId,
      documentIncarnation: identity.documentIncarnation,
      idempotencyKey: 'idempotency_123',
    } as const;
    const baseReceipt = {
      protocolVersion: 1,
      receiptId: 'receipt_2',
      scope,
      requestHash: DIGEST_A,
      beforeRevision: 'rev_before',
      generatedBlockIds: [],
      generatedChangeIds: [],
      finalOutcome: 'applied',
      result: appliedResult,
      createdAt: NOW,
      finalizedAt: NOW,
    } as const;
    expect(() => idempotencyReceiptSchema.parse(baseReceipt)).toThrow(/after revision/i);
    expect(() =>
      idempotencyReceiptSchema.parse({
        ...baseReceipt,
        afterRevision: 'rev_after',
        finalOutcome: 'conflict',
      }),
    ).toThrow(/outcome/i);
    expect(() =>
      idempotencyReceiptSchema.parse({
        ...baseReceipt,
        afterRevision: 'rev_after',
        scope: { ...scope, tenantId: 'other' },
      }),
    ).toThrow(/scope/i);
  });
});
