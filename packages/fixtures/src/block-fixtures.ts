import {
  canonicalizeDocument,
  digestBlock,
  findBlockById,
} from '@editor-mcp/adapter-tiptap-hocuspocus';
import { applyEditsRequestSchema } from '@editor-mcp/protocol';

import { createDeterministicFixtureFactories } from './determinism.js';
import { deepFreeze } from './helpers.js';
import {
  FIXTURE_FORMAT,
  FIXTURE_FORMAT_VERSION,
  type FixtureChangeMetadata,
  type FixtureDefinition,
  type FixtureDocument,
  type FixtureInvariant,
  type FixtureNode,
  type FixtureState,
} from './types.js';

const schema = { id: 'editor-mcp/mvp', version: 1 } as const;
const trackingAttrs = (
  blockId: string,
  changeId: string | null = null,
  kind: string | null = null,
) => ({
  blockId,
  diffChangeId: changeId,
  diffChangeKind: kind,
});
const paragraph = (
  blockId: string,
  value: string,
  changeId: string | null = null,
  kind: string | null = null,
): FixtureNode => ({
  type: 'paragraph',
  attrs: trackingAttrs(blockId, changeId, kind),
  ...(value.length === 0 ? {} : { content: [{ type: 'text', text: value }] }),
});
const doc = (...content: readonly FixtureNode[]): FixtureDocument => ({ type: 'doc', content });
const state = (
  document: FixtureDocument,
  diffChanges: readonly FixtureChangeMetadata[] = [],
): FixtureState => ({
  document,
  diffChanges,
});
const resolved = (changes: readonly FixtureChangeMetadata[], status: 'accepted' | 'rejected') =>
  changes.map((change) => ({
    ...change,
    status,
    resolvedAt: '2026-01-15T12:05:00.000Z',
    resolvedBy: 'reviewer-fixture',
  }));
const directInvariants: readonly FixtureInvariant[] = [
  {
    id: 'schema-valid',
    description: 'Every materialized document satisfies editor-mcp/mvp version 1.',
  },
  {
    id: 'stable-block-ids-are-unique',
    description: 'Every addressable node has one unique server-owned block ID.',
  },
  {
    id: 'generated-block-ids-are-server-owned',
    description: 'Inserted content receives fresh server-owned block IDs.',
  },
  {
    id: 'unrelated-blocks-are-unchanged',
    description: 'Blocks outside the insertion anchor remain canonically unchanged.',
  },
  { id: 'direct-resolution-is-noop', description: 'A direct insertion is already final.' },
];
const suggestedInvariants: readonly FixtureInvariant[] = [
  ...directInvariants.filter(({ id }) => id !== 'direct-resolution-is-noop'),
  {
    id: 'clean-resolutions-have-no-diff-artifacts',
    description: 'Resolved states contain no pending tracking attributes.',
  },
  {
    id: 'no-orphaned-change-metadata',
    description: 'Each pending metadata record has corresponding document segments.',
  },
  {
    id: 'rejected-equals-before',
    description: 'Rejecting the insertion restores the exact before document.',
  },
];

const beforeIds = {
  before: '61000001-0000-4000-8000-000000000001',
  anchor: '61000001-0000-4000-8000-000000000002',
  after: '61000001-0000-4000-8000-000000000003',
} as const;
const beforeDocument = doc(
  paragraph(beforeIds.before, 'Before anchor'),
  paragraph(beforeIds.anchor, 'Anchor block'),
  paragraph(beforeIds.after, 'After anchor'),
);

const directFactories = createDeterministicFixtureFactories(450_001);
const directInsertedId = directFactories.blockId();
const directChangeId = directFactories.changeId();
const directGroupId = `${directFactories.changeSetId()}:op_insert_before_suggest`;
const directChanges: readonly FixtureChangeMetadata[] = [
  {
    id: directChangeId,
    groupId: directGroupId,
    status: 'pending',
    operation: 'insert',
    authorId: 'agent-fixture',
    authorType: 'agent',
    createdAt: '2026-01-15T12:00:00.000Z',
    summary: '1 operation edit batch',
    baseBlockId: beforeIds.anchor,
  },
];
const directBeforeCanonical = canonicalizeDocument(beforeDocument);
const directFixture: FixtureDefinition = {
  format: FIXTURE_FORMAT,
  formatVersion: FIXTURE_FORMAT_VERSION,
  id: 'insert-block-before-direct',
  title: 'Insert a block before an anchor',
  description:
    'Inserts one fresh paragraph before the anchor and preserves every other canonical block exactly.',
  seed: 450_001,
  schema,
  tags: ['block', 'insert-before', 'resolution', 'suggest', 'structural'],
  subject: { nodeType: 'paragraph', tracking: 'block' },
  request: applyEditsRequestSchema.parse({
    documentId: 'doc_fixture_insert_before_direct',
    documentIncarnation: 'inc_fixture_insert_before_direct',
    schemaId: schema.id,
    schemaVersion: schema.version,
    idempotencyKey: 'idem_fixture_insert_before_direct_v1',
    changeMode: 'suggest',
    operations: [
      {
        operationId: 'op_insert_before_suggest',
        kind: 'insert_before',
        anchorBlockId: beforeIds.anchor,
        expectedAnchorDigest: digestBlock(
          findBlockById(directBeforeCanonical, beforeIds.anchor).node,
        ),
        html: '<p>Inserted before</p>',
      },
    ],
  }),
  resolution: { kind: 'accept_reject', changeIds: [directChangeId] },
  expected: {
    states: {
      before: state(beforeDocument),
      proposed: state(
        doc(
          paragraph(beforeIds.before, 'Before anchor'),
          paragraph(directInsertedId, 'Inserted before', directChangeId, 'insert'),
          paragraph(beforeIds.anchor, 'Anchor block'),
          paragraph(beforeIds.after, 'After anchor'),
        ),
        directChanges,
      ),
      accepted: state(
        doc(
          paragraph(beforeIds.before, 'Before anchor'),
          paragraph(directInsertedId, 'Inserted before'),
          paragraph(beforeIds.anchor, 'Anchor block'),
          paragraph(beforeIds.after, 'After anchor'),
        ),
        resolved(directChanges, 'accepted'),
      ),
      rejected: state(beforeDocument, resolved(directChanges, 'rejected')),
    },
    conflicts: [],
    generatedBlockIds: [directInsertedId],
  },
  invariants: suggestedInvariants,
};

const suggestedFactories = createDeterministicFixtureFactories(450_002);
const suggestedInsertedId = suggestedFactories.blockId();
const suggestedChangeId = suggestedFactories.changeId();
const suggestedGroupId = `${suggestedFactories.changeSetId()}:op_insert_after_suggest`;
const suggestedChanges: readonly FixtureChangeMetadata[] = [
  {
    id: suggestedChangeId,
    groupId: suggestedGroupId,
    status: 'pending',
    operation: 'insert',
    authorId: 'agent-fixture',
    authorType: 'agent',
    createdAt: '2026-01-15T12:00:00.000Z',
    summary: '1 operation edit batch',
    baseBlockId: beforeIds.anchor,
  },
];
const suggestedBeforeCanonical = canonicalizeDocument(beforeDocument);
const suggestedFixture: FixtureDefinition = {
  format: FIXTURE_FORMAT,
  formatVersion: FIXTURE_FORMAT_VERSION,
  id: 'insert-block-after-suggest',
  title: 'Suggest a block after an anchor',
  description:
    'Inserts a tracked paragraph after the anchor under one change ID; reject restores the exact before JSON.',
  seed: 450_002,
  schema,
  tags: ['block', 'insert-after', 'resolution', 'suggest', 'structural'],
  subject: { nodeType: 'paragraph', tracking: 'block' },
  request: applyEditsRequestSchema.parse({
    documentId: 'doc_fixture_insert_after_suggest',
    documentIncarnation: 'inc_fixture_insert_after_suggest',
    schemaId: schema.id,
    schemaVersion: schema.version,
    idempotencyKey: 'idem_fixture_insert_after_suggest_v1',
    changeMode: 'suggest',
    operations: [
      {
        operationId: 'op_insert_after_suggest',
        kind: 'insert_after',
        anchorBlockId: beforeIds.anchor,
        expectedAnchorDigest: digestBlock(
          findBlockById(suggestedBeforeCanonical, beforeIds.anchor).node,
        ),
        html: '<p>Suggested after</p>',
      },
    ],
  }),
  resolution: { kind: 'accept_reject', changeIds: [suggestedChangeId] },
  expected: {
    states: {
      before: state(beforeDocument),
      proposed: state(
        doc(
          paragraph(beforeIds.before, 'Before anchor'),
          paragraph(beforeIds.anchor, 'Anchor block'),
          paragraph(suggestedInsertedId, 'Suggested after', suggestedChangeId, 'insert'),
          paragraph(beforeIds.after, 'After anchor'),
        ),
        suggestedChanges,
      ),
      accepted: state(
        doc(
          paragraph(beforeIds.before, 'Before anchor'),
          paragraph(beforeIds.anchor, 'Anchor block'),
          paragraph(suggestedInsertedId, 'Suggested after'),
          paragraph(beforeIds.after, 'After anchor'),
        ),
        resolved(suggestedChanges, 'accepted'),
      ),
      rejected: state(beforeDocument, resolved(suggestedChanges, 'rejected')),
    },
    conflicts: [],
    generatedBlockIds: [suggestedInsertedId],
  },
  invariants: suggestedInvariants,
};

export const blockFixtures: readonly FixtureDefinition[] = deepFreeze([
  directFixture,
  suggestedFixture,
]);
