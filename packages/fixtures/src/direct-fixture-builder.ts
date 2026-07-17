import {
  canonicalizeDocument,
  digestBlock,
  findBlockById,
  listBlockSummaries,
  parseAgentHtml,
  proposeBlockReplacement,
  replaceNodeAtPath,
} from '@editor-mcp/adapter-tiptap-hocuspocus';
import { applyEditsRequestSchema } from '@editor-mcp/protocol';

import { createDeterministicFixtureFactories } from './determinism.js';
import {
  FIXTURE_FORMAT,
  FIXTURE_FORMAT_VERSION,
  type FixtureDefinition,
  type FixtureChangeMetadata,
  type FixtureDocument,
  type FixtureInvariant,
  type FixtureState,
} from './types.js';

export interface DirectReplacementFixtureInput {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly seed: number;
  readonly tags: readonly string[];
  readonly subjectNodeType: string;
  readonly before: FixtureDocument;
  readonly targetBlockId: string;
  readonly html: string;
}

const invariants = [
  {
    id: 'schema-valid',
    description: 'Every materialized document satisfies editor-mcp/mvp version 1.',
  },
  {
    id: 'stable-block-ids-are-unique',
    description: 'Every addressable node has one unique server-owned block ID.',
  },
  {
    id: 'accepted-rejected-are-siblings',
    description: 'Accepted keeps the replacement; rejected restores the original block.',
  },
  {
    id: 'replacement-block-id-is-new',
    description:
      'The target identity is retired and every replacement-subtree ID is server generated.',
  },
  {
    id: 'unrelated-blocks-are-unchanged',
    description: 'Blocks outside the semantic target remain canonically unchanged.',
  },
] as const satisfies readonly FixtureInvariant[];

export function createDirectReplacementFixture(
  input: DirectReplacementFixtureInput,
): FixtureDefinition {
  const beforeNode = canonicalizeDocument(input.before);
  const target = findBlockById(beforeNode, input.targetBlockId);
  const factories = createDeterministicFixtureFactories(input.seed);
  const parsedReplacement = parseAgentHtml(input.html, {
    idFactory: factories.blockId,
  });
  if (parsedReplacement.childCount !== 1 || parsedReplacement.firstChild === null) {
    throw new TypeError(`Fixture ${input.id} must replace one top-level block`);
  }
  const afterNode = replaceNodeAtPath(beforeNode, target.path, parsedReplacement.firstChild);
  const beforeIds = new Set(listBlockSummaries(beforeNode).map(({ id }) => id));
  const generatedBlockIds = listBlockSummaries(afterNode)
    .map(({ id }) => id)
    .filter((id) => !beforeIds.has(id));
  const before = {
    document: structuredClone(input.before),
    diffChanges: [],
  };
  const after = {
    document: afterNode.toJSON() as FixtureDocument,
    diffChanges: [],
  };
  const changeId = factories.changeId();
  const changeSetId = factories.changeSetId();
  const operationId = `op_${input.id.replaceAll('-', '_')}`;
  const pendingChange: FixtureChangeMetadata = {
    id: changeId,
    groupId: `${changeSetId}:${operationId}`,
    status: 'pending',
    operation: 'replace',
    authorId: 'agent-fixture',
    authorType: 'agent',
    createdAt: '2026-01-15T12:00:00.000Z',
    summary: '1 operation edit batch',
    baseBlockId: input.targetBlockId,
  };
  const proposed = proposeBlockReplacement(
    beforeNode,
    input.targetBlockId,
    parsedReplacement.firstChild,
    pendingChange,
  );
  const proposedState: FixtureState = {
    document: proposed.document.toJSON() as FixtureDocument,
    diffChanges: [pendingChange],
  };
  const resolvedChange = (status: 'accepted' | 'rejected'): FixtureChangeMetadata => ({
    ...pendingChange,
    status,
    resolvedAt: '2026-01-15T12:05:00.000Z',
    resolvedBy: 'reviewer-fixture',
  });
  const acceptedState: FixtureState = {
    document: after.document,
    diffChanges: [resolvedChange('accepted')],
  };
  const rejectedState: FixtureState = {
    document: before.document,
    diffChanges: [resolvedChange('rejected')],
  };

  return {
    format: FIXTURE_FORMAT,
    formatVersion: FIXTURE_FORMAT_VERSION,
    id: input.id,
    title: input.title,
    description: input.description,
    seed: input.seed,
    schema: { id: 'editor-mcp/mvp', version: 1 },
    tags: [...input.tags, 'suggest', 'replace-block'],
    subject: {
      nodeType: input.subjectNodeType,
      tracking: 'block',
    },
    request: applyEditsRequestSchema.parse({
      documentId: `doc_${input.id.replaceAll('-', '_')}`,
      documentIncarnation: `inc_${input.id.replaceAll('-', '_')}`,
      schemaId: 'editor-mcp/mvp',
      schemaVersion: 1,
      idempotencyKey: `idem_${input.id.replaceAll('-', '_')}`,
      changeMode: 'suggest',
      operations: [
        {
          operationId,
          kind: 'replace_block',
          blockId: input.targetBlockId,
          expectedBlockDigest: digestBlock(target.node),
          html: input.html,
        },
      ],
    }),
    resolution: { kind: 'accept_reject', changeIds: [changeId] },
    expected: {
      states: {
        before,
        proposed: proposedState,
        accepted: acceptedState,
        rejected: rejectedState,
      },
      conflicts: [],
      generatedBlockIds,
    },
    invariants,
  };
}
