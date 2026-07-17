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
  type FixtureMark,
  type FixtureNode,
  type FixtureState,
} from './types.js';

const schema = {
  id: 'editor-mcp/mvp',
  version: 1,
} as const;

const APPLIED_AT = '2026-01-15T12:00:00.000Z';
const RESOLVED_AT = '2026-01-15T12:05:00.000Z';
const AGENT_ID = 'agent-fixture';
const REVIEWER_ID = 'reviewer-fixture';

const text = (value: string, marks: readonly FixtureMark[] = []): FixtureNode => ({
  type: 'text',
  ...(marks.length === 0 ? {} : { marks }),
  text: value,
});

const mark = (type: 'bold' | 'code' | 'italic' | 'strike'): FixtureMark => ({ type });

const linkMark = (href: string, title: string | null = null): FixtureMark => ({
  type: 'link',
  attrs: { href, title },
});

const diffMark = (changeId: string, kind: 'delete' | 'format' | 'insert'): FixtureMark => ({
  type: 'diffChange',
  attrs: { changeId, kind },
});

const paragraph = (blockId: string, content: readonly FixtureNode[]): FixtureNode => ({
  type: 'paragraph',
  attrs: {
    blockId,
    diffChangeId: null,
    diffChangeKind: null,
  },
  ...(content.length === 0 ? {} : { content }),
});

const doc = (...content: readonly FixtureNode[]): FixtureDocument => ({
  type: 'doc',
  content,
});

const state = (
  document: FixtureDocument,
  diffChanges: readonly FixtureChangeMetadata[] = [],
): FixtureState => ({
  document,
  diffChanges: diffChanges.toSorted((left, right) => left.id.localeCompare(right.id)),
});

function targetDigest(document: FixtureDocument, blockId: string): `sha256:${string}` {
  const canonical = canonicalizeDocument(document);
  return digestBlock(findBlockById(canonical, blockId).node);
}

const commonInvariants = [
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
    description:
      'Accepted and rejected are independently materialized from separate copies of proposed.',
  },
  {
    id: 'unrelated-blocks-are-unchanged',
    description: 'Localized text and formatting operations preserve the target block identity.',
  },
] as const satisfies readonly FixtureInvariant[];

const suggestedInvariants = [
  ...commonInvariants,
  {
    id: 'clean-resolutions-have-no-diff-artifacts',
    description:
      'Accepted and rejected documents contain no diff marks or non-null tracking attributes.',
  },
  {
    id: 'no-orphaned-change-metadata',
    description:
      'Each pending metadata record has at least one document segment and every segment has metadata.',
  },
  {
    id: 'rejected-equals-before',
    description: 'Rejecting the proposal restores the original canonical document.',
  },
] as const satisfies readonly FixtureInvariant[];

function requiredAt<T>(values: readonly T[], index: number, label: string): T {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`Missing ${label} at index ${String(index)}`);
  }
  return value;
}

interface FormattingSnapshotMetadata extends FixtureChangeMetadata {
  readonly previousFormatting: {
    readonly marks: readonly FixtureMark[];
  };
}

function pendingChange(
  changeId: string,
  groupId: string,
  operation: FixtureChangeMetadata['operation'],
  blockId: string,
  operationCount: number,
  previousMarks?: readonly FixtureMark[],
): FixtureChangeMetadata {
  const base = {
    id: changeId,
    groupId,
    status: 'pending',
    operation,
    authorId: AGENT_ID,
    authorType: 'agent',
    createdAt: APPLIED_AT,
    summary: `${String(operationCount)} operation edit batch`,
    baseBlockId: blockId,
  } as const satisfies FixtureChangeMetadata;
  if (previousMarks === undefined) {
    return base;
  }
  const withFormatting: FormattingSnapshotMetadata = {
    ...base,
    previousFormatting: { marks: previousMarks },
  };
  return withFormatting;
}

const resolvedChanges = (
  changes: readonly FixtureChangeMetadata[],
  status: 'accepted' | 'rejected',
): readonly FixtureChangeMetadata[] =>
  changes
    .map((change) => ({
      ...change,
      status,
      resolvedAt: RESOLVED_AT,
      resolvedBy: REVIEWER_ID,
    }))
    .toSorted((left, right) => left.id.localeCompare(right.id));

function suggestedExpected(
  before: FixtureState,
  proposed: FixtureState,
  accepted: FixtureState,
  rejected: FixtureState,
): FixtureDefinition['expected'] {
  return {
    states: { before, proposed, accepted, rejected },
    conflicts: [],
    generatedBlockIds: [],
  };
}

const directInsertId = '51000001-0000-4000-8000-000000000001';
const directInsertBefore = state(doc(paragraph(directInsertId, [text('Ready')])));
const directInsertAfter = state(doc(paragraph(directInsertId, [text('Ready ✅👩🏽‍💻')])));
const directInsertFactories = createDeterministicFixtureFactories(420_001);
const directInsertChangeId = directInsertFactories.changeId();
const directInsertMetadata = [
  pendingChange(
    directInsertChangeId,
    `${directInsertFactories.changeSetId()}:op_insert_emoji_at_end`,
    'insert',
    directInsertId,
    1,
  ),
] as const;
const directInsertProposed = state(
  doc(
    paragraph(directInsertId, [
      text('Ready'),
      text(' ✅👩🏽‍💻', [diffMark(directInsertChangeId, 'insert')]),
    ]),
  ),
  directInsertMetadata,
);

const directInsertEmoji: FixtureDefinition = {
  format: FIXTURE_FORMAT,
  formatVersion: FIXTURE_FORMAT_VERSION,
  id: 'insert-text-direct-emoji-end-boundary',
  title: 'Suggested emoji insertion at the end boundary',
  description:
    'Inserts a grapheme-rich emoji sequence at the final UTF-16 offset without replacing the paragraph identity.',
  seed: 420_001,
  schema,
  tags: ['boundary', 'emoji', 'insert-text', 'suggest', 'unicode'],
  subject: { nodeType: 'paragraph', tracking: 'inline' },
  request: applyEditsRequestSchema.parse({
    documentId: 'doc_fixture_insert_text_direct_emoji',
    documentIncarnation: 'inc_fixture_insert_text_direct_emoji',
    schemaId: schema.id,
    schemaVersion: schema.version,
    idempotencyKey: 'idem_fixture_insert_text_direct_emoji_v1',
    changeMode: 'suggest',
    operations: [
      {
        operationId: 'op_insert_emoji_at_end',
        kind: 'insert_text',
        blockId: directInsertId,
        expectedBlockDigest: targetDigest(directInsertBefore.document, directInsertId),
        offset: 5,
        text: ' ✅👩🏽‍💻',
      },
    ],
  }),
  resolution: { kind: 'accept_reject', changeIds: [directInsertChangeId] },
  expected: suggestedExpected(
    directInsertBefore,
    directInsertProposed,
    state(directInsertAfter.document, resolvedChanges(directInsertMetadata, 'accepted')),
    state(directInsertBefore.document, resolvedChanges(directInsertMetadata, 'rejected')),
  ),
  invariants: suggestedInvariants,
};

const suggestedInsertId = '51000002-0000-4000-8000-000000000002';
const suggestedInsertFactories = createDeterministicFixtureFactories(420_002);
const suggestedInsertChangeId = suggestedInsertFactories.changeId();
const suggestedInsertGroupId = `${suggestedInsertFactories.changeSetId()}:op_insert_multiscript_at_start`;
const suggestedInsertMetadata = [
  pendingChange(suggestedInsertChangeId, suggestedInsertGroupId, 'insert', suggestedInsertId, 1),
] as const;
const multiscriptInsertion = 'नमस्ते e\u0301 ';
const suggestedInsertBefore = state(doc(paragraph(suggestedInsertId, [text('café')])));
const suggestedInsertProposed = state(
  doc(
    paragraph(suggestedInsertId, [
      text(multiscriptInsertion, [diffMark(suggestedInsertChangeId, 'insert')]),
      text('café'),
    ]),
  ),
  suggestedInsertMetadata,
);
const suggestedInsertAccepted = state(
  doc(paragraph(suggestedInsertId, [text(`${multiscriptInsertion}café`)])),
  resolvedChanges(suggestedInsertMetadata, 'accepted'),
);
const suggestedInsertRejected = state(
  suggestedInsertBefore.document,
  resolvedChanges(suggestedInsertMetadata, 'rejected'),
);

const suggestedInsertUnicode: FixtureDefinition = {
  format: FIXTURE_FORMAT,
  formatVersion: FIXTURE_FORMAT_VERSION,
  id: 'insert-text-suggest-multiscript-start-boundary',
  title: 'Suggested multiscript insertion at the start boundary',
  description:
    'Tracks a Devanagari and decomposed-accent insertion at offset zero and resolves it without changing the paragraph ID.',
  seed: 420_002,
  schema,
  tags: ['boundary', 'combining-character', 'insert-text', 'non-latin', 'suggest', 'unicode'],
  subject: { nodeType: 'paragraph', tracking: 'inline' },
  request: applyEditsRequestSchema.parse({
    documentId: 'doc_fixture_insert_text_suggest_unicode',
    documentIncarnation: 'inc_fixture_insert_text_suggest_unicode',
    schemaId: schema.id,
    schemaVersion: schema.version,
    idempotencyKey: 'idem_fixture_insert_text_suggest_unicode_v1',
    changeMode: 'suggest',
    operations: [
      {
        operationId: 'op_insert_multiscript_at_start',
        kind: 'insert_text',
        blockId: suggestedInsertId,
        expectedBlockDigest: targetDigest(suggestedInsertBefore.document, suggestedInsertId),
        offset: 0,
        text: multiscriptInsertion,
      },
    ],
  }),
  resolution: { kind: 'accept_reject', changeIds: [suggestedInsertChangeId] },
  expected: suggestedExpected(
    suggestedInsertBefore,
    suggestedInsertProposed,
    suggestedInsertAccepted,
    suggestedInsertRejected,
  ),
  invariants: suggestedInvariants,
};

const directDeleteId = '51000003-0000-4000-8000-000000000003';
const directDeleteBefore = state(doc(paragraph(directDeleteId, [text('ABC אבג DEF')])));
const directDeleteAfter = state(doc(paragraph(directDeleteId, [text('ABC  DEF')])));
const directDeleteFactories = createDeterministicFixtureFactories(420_003);
const directDeleteChangeId = directDeleteFactories.changeId();
const directDeleteMetadata = [
  pendingChange(
    directDeleteChangeId,
    `${directDeleteFactories.changeSetId()}:op_delete_hebrew_run`,
    'delete',
    directDeleteId,
    1,
  ),
] as const;
const directDeleteProposed = state(
  doc(
    paragraph(directDeleteId, [
      text('ABC '),
      text('אבג', [diffMark(directDeleteChangeId, 'delete')]),
      text(' DEF'),
    ]),
  ),
  directDeleteMetadata,
);

const directDeleteBidi: FixtureDefinition = {
  format: FIXTURE_FORMAT,
  formatVersion: FIXTURE_FORMAT_VERSION,
  id: 'delete-text-direct-bidirectional-range',
  title: 'Suggested deletion of a bidirectional text range',
  description:
    'Deletes the Hebrew run by UTF-16 offsets while retaining the surrounding Latin text and both boundary spaces.',
  seed: 420_003,
  schema,
  tags: ['bidi', 'delete-text', 'rtl', 'suggest', 'unicode'],
  subject: { nodeType: 'paragraph', tracking: 'inline' },
  request: applyEditsRequestSchema.parse({
    documentId: 'doc_fixture_delete_text_direct_bidi',
    documentIncarnation: 'inc_fixture_delete_text_direct_bidi',
    schemaId: schema.id,
    schemaVersion: schema.version,
    idempotencyKey: 'idem_fixture_delete_text_direct_bidi_v1',
    changeMode: 'suggest',
    operations: [
      {
        operationId: 'op_delete_hebrew_run',
        kind: 'delete_text',
        blockId: directDeleteId,
        expectedBlockDigest: targetDigest(directDeleteBefore.document, directDeleteId),
        range: { from: 4, to: 7 },
      },
    ],
  }),
  resolution: { kind: 'accept_reject', changeIds: [directDeleteChangeId] },
  expected: suggestedExpected(
    directDeleteBefore,
    directDeleteProposed,
    state(directDeleteAfter.document, resolvedChanges(directDeleteMetadata, 'accepted')),
    state(directDeleteBefore.document, resolvedChanges(directDeleteMetadata, 'rejected')),
  ),
  invariants: suggestedInvariants,
};

const suggestedWhitespaceId = '51000004-0000-4000-8000-000000000004';
const suggestedWhitespaceFactories = createDeterministicFixtureFactories(420_004);
const suggestedWhitespaceChangeId = suggestedWhitespaceFactories.changeId();
const suggestedWhitespaceGroupId = `${suggestedWhitespaceFactories.changeSetId()}:op_delete_special_whitespace`;
const suggestedWhitespaceMetadata = [
  pendingChange(
    suggestedWhitespaceChangeId,
    suggestedWhitespaceGroupId,
    'delete',
    suggestedWhitespaceId,
    1,
  ),
] as const;
const specialWhitespace = '\u00a0\u2009';
const suggestedWhitespaceBefore = state(
  doc(paragraph(suggestedWhitespaceId, [text(`Alpha${specialWhitespace}Beta`)])),
);
const suggestedWhitespaceProposed = state(
  doc(
    paragraph(suggestedWhitespaceId, [
      text('Alpha'),
      text(specialWhitespace, [diffMark(suggestedWhitespaceChangeId, 'delete')]),
      text('Beta'),
    ]),
  ),
  suggestedWhitespaceMetadata,
);
const suggestedWhitespaceAccepted = state(
  doc(paragraph(suggestedWhitespaceId, [text('AlphaBeta')])),
  resolvedChanges(suggestedWhitespaceMetadata, 'accepted'),
);
const suggestedWhitespaceRejected = state(
  suggestedWhitespaceBefore.document,
  resolvedChanges(suggestedWhitespaceMetadata, 'rejected'),
);

const suggestedDeleteWhitespace: FixtureDefinition = {
  format: FIXTURE_FORMAT,
  formatVersion: FIXTURE_FORMAT_VERSION,
  id: 'delete-text-suggest-special-whitespace',
  title: 'Suggested deletion of special whitespace',
  description:
    'Tracks an adjacent non-breaking space and thin space as a deletion without normalizing either code point.',
  seed: 420_004,
  schema,
  tags: ['delete-text', 'special-whitespace', 'suggest', 'unicode'],
  subject: { nodeType: 'paragraph', tracking: 'inline' },
  request: applyEditsRequestSchema.parse({
    documentId: 'doc_fixture_delete_text_suggest_whitespace',
    documentIncarnation: 'inc_fixture_delete_text_suggest_whitespace',
    schemaId: schema.id,
    schemaVersion: schema.version,
    idempotencyKey: 'idem_fixture_delete_text_suggest_whitespace_v1',
    changeMode: 'suggest',
    operations: [
      {
        operationId: 'op_delete_special_whitespace',
        kind: 'delete_text',
        blockId: suggestedWhitespaceId,
        expectedBlockDigest: targetDigest(
          suggestedWhitespaceBefore.document,
          suggestedWhitespaceId,
        ),
        range: { from: 5, to: 7 },
      },
    ],
  }),
  resolution: { kind: 'accept_reject', changeIds: [suggestedWhitespaceChangeId] },
  expected: suggestedExpected(
    suggestedWhitespaceBefore,
    suggestedWhitespaceProposed,
    suggestedWhitespaceAccepted,
    suggestedWhitespaceRejected,
  ),
  invariants: suggestedInvariants,
};

const directReplaceId = '51000005-0000-4000-8000-000000000005';
const directReplaceBefore = state(doc(paragraph(directReplaceId, [text('Status: 🧪 pending')])));
const directReplaceAfter = state(doc(paragraph(directReplaceId, [text('Status: 試験 pending')])));
const directReplaceFactories = createDeterministicFixtureFactories(420_005);
const directReplaceChangeId = directReplaceFactories.changeId();
const directReplaceMetadata = [
  pendingChange(
    directReplaceChangeId,
    `${directReplaceFactories.changeSetId()}:op_replace_emoji_with_cjk`,
    'replace',
    directReplaceId,
    1,
  ),
] as const;
const directReplaceProposed = state(
  doc(
    paragraph(directReplaceId, [
      text('Status: '),
      text('🧪', [diffMark(directReplaceChangeId, 'delete')]),
      text('試験', [diffMark(directReplaceChangeId, 'insert')]),
      text(' pending'),
    ]),
  ),
  directReplaceMetadata,
);

const directReplaceEmoji: FixtureDefinition = {
  format: FIXTURE_FORMAT,
  formatVersion: FIXTURE_FORMAT_VERSION,
  id: 'replace-text-direct-emoji-with-cjk',
  title: 'Suggested replacement of an emoji with CJK text',
  description:
    'Uses the emoji surrogate-pair boundary to replace one emoji with Japanese text while preserving the block ID.',
  seed: 420_005,
  schema,
  tags: ['emoji', 'non-latin', 'replace-text', 'suggest', 'unicode'],
  subject: { nodeType: 'paragraph', tracking: 'inline' },
  request: applyEditsRequestSchema.parse({
    documentId: 'doc_fixture_replace_text_direct_emoji',
    documentIncarnation: 'inc_fixture_replace_text_direct_emoji',
    schemaId: schema.id,
    schemaVersion: schema.version,
    idempotencyKey: 'idem_fixture_replace_text_direct_emoji_v1',
    changeMode: 'suggest',
    operations: [
      {
        operationId: 'op_replace_emoji_with_cjk',
        kind: 'replace_text',
        blockId: directReplaceId,
        expectedBlockDigest: targetDigest(directReplaceBefore.document, directReplaceId),
        range: { from: 8, to: 10 },
        text: '試験',
      },
    ],
  }),
  resolution: { kind: 'accept_reject', changeIds: [directReplaceChangeId] },
  expected: suggestedExpected(
    directReplaceBefore,
    directReplaceProposed,
    state(directReplaceAfter.document, resolvedChanges(directReplaceMetadata, 'accepted')),
    state(directReplaceBefore.document, resolvedChanges(directReplaceMetadata, 'rejected')),
  ),
  invariants: suggestedInvariants,
};

const suggestedNormalizationId = '51000006-0000-4000-8000-000000000006';
const suggestedNormalizationFactories = createDeterministicFixtureFactories(420_006);
const suggestedNormalizationChangeId = suggestedNormalizationFactories.changeId();
const suggestedNormalizationGroupId = `${suggestedNormalizationFactories.changeSetId()}:op_replace_decomposed_accent`;
const suggestedNormalizationMetadata = [
  pendingChange(
    suggestedNormalizationChangeId,
    suggestedNormalizationGroupId,
    'replace',
    suggestedNormalizationId,
    1,
  ),
] as const;
const decomposedWord = 'Cafe\u0301 noir';
const suggestedNormalizationBefore = state(
  doc(paragraph(suggestedNormalizationId, [text(decomposedWord)])),
);
const suggestedNormalizationProposed = state(
  doc(
    paragraph(suggestedNormalizationId, [
      text('Caf'),
      text('e\u0301', [diffMark(suggestedNormalizationChangeId, 'delete')]),
      text('é', [diffMark(suggestedNormalizationChangeId, 'insert')]),
      text(' noir'),
    ]),
  ),
  suggestedNormalizationMetadata,
);
const suggestedNormalizationAccepted = state(
  doc(paragraph(suggestedNormalizationId, [text('Café noir')])),
  resolvedChanges(suggestedNormalizationMetadata, 'accepted'),
);
const suggestedNormalizationRejected = state(
  suggestedNormalizationBefore.document,
  resolvedChanges(suggestedNormalizationMetadata, 'rejected'),
);

const suggestedReplaceNormalization: FixtureDefinition = {
  format: FIXTURE_FORMAT,
  formatVersion: FIXTURE_FORMAT_VERSION,
  id: 'replace-text-suggest-combining-normalization',
  title: 'Suggested combining-character normalization',
  description:
    'Tracks replacement of a decomposed accent with its precomposed form without silently normalizing the source.',
  seed: 420_006,
  schema,
  tags: ['combining-character', 'replace-text', 'suggest', 'unicode'],
  subject: { nodeType: 'paragraph', tracking: 'inline' },
  request: applyEditsRequestSchema.parse({
    documentId: 'doc_fixture_replace_text_suggest_normalization',
    documentIncarnation: 'inc_fixture_replace_text_suggest_normalization',
    schemaId: schema.id,
    schemaVersion: schema.version,
    idempotencyKey: 'idem_fixture_replace_text_suggest_normalization_v1',
    changeMode: 'suggest',
    operations: [
      {
        operationId: 'op_replace_decomposed_accent',
        kind: 'replace_text',
        blockId: suggestedNormalizationId,
        expectedBlockDigest: targetDigest(
          suggestedNormalizationBefore.document,
          suggestedNormalizationId,
        ),
        range: { from: 3, to: 5 },
        text: 'é',
      },
    ],
  }),
  resolution: { kind: 'accept_reject', changeIds: [suggestedNormalizationChangeId] },
  expected: suggestedExpected(
    suggestedNormalizationBefore,
    suggestedNormalizationProposed,
    suggestedNormalizationAccepted,
    suggestedNormalizationRejected,
  ),
  invariants: suggestedInvariants,
};

const suggestedBoldId = '51000007-0000-4000-8000-000000000007';
const suggestedBoldFactories = createDeterministicFixtureFactories(420_007);
const suggestedBoldChangeId = suggestedBoldFactories.changeId();
const suggestedBoldGroupId = `${suggestedBoldFactories.changeSetId()}:op_add_bold`;
const suggestedBoldMetadata = [
  pendingChange(suggestedBoldChangeId, suggestedBoldGroupId, 'format', suggestedBoldId, 1, []),
] as const;
const suggestedBoldBefore = state(doc(paragraph(suggestedBoldId, [text('Make this important.')])));
const suggestedBoldProposed = state(
  doc(
    paragraph(suggestedBoldId, [
      text('Make'),
      text(' this', [mark('bold'), diffMark(suggestedBoldChangeId, 'format')]),
      text(' important.'),
    ]),
  ),
  suggestedBoldMetadata,
);
const suggestedBoldAccepted = state(
  doc(
    paragraph(suggestedBoldId, [text('Make'), text(' this', [mark('bold')]), text(' important.')]),
  ),
  resolvedChanges(suggestedBoldMetadata, 'accepted'),
);
const suggestedBoldRejected = state(
  suggestedBoldBefore.document,
  resolvedChanges(suggestedBoldMetadata, 'rejected'),
);

const suggestedAddBold: FixtureDefinition = {
  format: FIXTURE_FORMAT,
  formatVersion: FIXTURE_FORMAT_VERSION,
  id: 'format-text-suggest-add-bold',
  title: 'Suggested bold formatting',
  description:
    'Applies bold as a reviewable formatting change and records the empty prior formatting snapshot for rejection.',
  seed: 420_007,
  schema,
  tags: ['bold', 'format-text', 'suggest'],
  subject: { nodeType: 'paragraph', tracking: 'inline' },
  request: applyEditsRequestSchema.parse({
    documentId: 'doc_fixture_format_text_suggest_bold',
    documentIncarnation: 'inc_fixture_format_text_suggest_bold',
    schemaId: schema.id,
    schemaVersion: schema.version,
    idempotencyKey: 'idem_fixture_format_text_suggest_bold_v1',
    changeMode: 'suggest',
    operations: [
      {
        operationId: 'op_add_bold',
        kind: 'format_text',
        blockId: suggestedBoldId,
        expectedBlockDigest: targetDigest(suggestedBoldBefore.document, suggestedBoldId),
        range: { from: 4, to: 9 },
        action: 'add',
        mark: { type: 'bold' },
      },
    ],
  }),
  resolution: { kind: 'accept_reject', changeIds: [suggestedBoldChangeId] },
  expected: suggestedExpected(
    suggestedBoldBefore,
    suggestedBoldProposed,
    suggestedBoldAccepted,
    suggestedBoldRejected,
  ),
  invariants: suggestedInvariants,
};

const overlapFormatId = '51000008-0000-4000-8000-000000000008';
const overlapFormatBefore = state(doc(paragraph(overlapFormatId, [text('abcdefghijklmnop')])));
const overlapFormatDigest = targetDigest(overlapFormatBefore.document, overlapFormatId);
const directOverlappingFormatting: FixtureDefinition = {
  format: FIXTURE_FORMAT,
  formatVersion: FIXTURE_FORMAT_VERSION,
  id: 'format-text-direct-overlapping-marks',
  title: 'Suggested overlapping ordinary marks (conflict contract)',
  description:
    'Adds bold, italic, strike, code, and link marks over overlapping and adjacent UTF-16 ranges in one atomic batch.',
  seed: 420_008,
  schema,
  tags: ['batch', 'bold', 'code', 'format-text', 'italic', 'link', 'overlap', 'strike', 'suggest'],
  subject: { nodeType: 'paragraph', tracking: 'inline' },
  request: applyEditsRequestSchema.parse({
    documentId: 'doc_fixture_format_text_direct_overlap',
    documentIncarnation: 'inc_fixture_format_text_direct_overlap',
    schemaId: schema.id,
    schemaVersion: schema.version,
    idempotencyKey: 'idem_fixture_format_text_direct_overlap_v1',
    changeMode: 'suggest',
    operations: [
      {
        operationId: 'op_add_bold_overlap',
        kind: 'format_text',
        blockId: overlapFormatId,
        expectedBlockDigest: overlapFormatDigest,
        range: { from: 0, to: 8 },
        action: 'add',
        mark: { type: 'bold' },
      },
      {
        operationId: 'op_add_italic_overlap',
        kind: 'format_text',
        blockId: overlapFormatId,
        expectedBlockDigest: overlapFormatDigest,
        range: { from: 4, to: 12 },
        action: 'add',
        mark: { type: 'italic' },
      },
      {
        operationId: 'op_add_strike_overlap',
        kind: 'format_text',
        blockId: overlapFormatId,
        expectedBlockDigest: overlapFormatDigest,
        range: { from: 2, to: 6 },
        action: 'add',
        mark: { type: 'strike' },
      },
      {
        operationId: 'op_add_code_overlap',
        kind: 'format_text',
        blockId: overlapFormatId,
        expectedBlockDigest: overlapFormatDigest,
        range: { from: 8, to: 14 },
        action: 'add',
        mark: { type: 'code' },
      },
      {
        operationId: 'op_add_link_overlap',
        kind: 'format_text',
        blockId: overlapFormatId,
        expectedBlockDigest: overlapFormatDigest,
        range: { from: 10, to: 16 },
        action: 'add',
        mark: { type: 'link', href: '/evidence' },
      },
    ],
  }),
  resolution: { kind: 'not_applicable' },
  expected: {
    states: {
      before: overlapFormatBefore,
      proposed: overlapFormatBefore,
      accepted: overlapFormatBefore,
      rejected: overlapFormatBefore,
    },
    conflicts: [
      {
        code: 'INVALID_CONTENT',
        operationId: 'op_add_italic_overlap',
        detail:
          'Overlapping pending inline changes are rejected; no partial proposal is published.',
      },
    ],
    generatedBlockIds: [],
  },
  invariants: suggestedInvariants,
};

const removeFormatId = '51000009-0000-4000-8000-000000000009';
const removeFormatBefore = state(
  doc(
    paragraph(removeFormatId, [
      text('BOLD', [mark('bold')]),
      text('ITAL', [mark('italic')]),
      text('STRK', [mark('strike')]),
      text('CODE', [mark('code')]),
      text('LINK', [linkMark('https://example.test/source', 'Source')]),
    ]),
  ),
);
const removeFormatAfter = state(doc(paragraph(removeFormatId, [text('BOLDITALSTRKCODELINK')])));
const removeFormatDigest = targetDigest(removeFormatBefore.document, removeFormatId);
const removeFactories = createDeterministicFixtureFactories(420_009);
const removeChangeIds = Array.from({ length: 5 }, () => removeFactories.changeId());
const removeChangeSetId = removeFactories.changeSetId();
const removeOperationIds = [
  'op_remove_bold',
  'op_remove_italic',
  'op_remove_strike',
  'op_remove_code',
  'op_remove_link',
] as const;
const removePreviousMarks: readonly (readonly FixtureMark[])[] = [
  [mark('bold')],
  [mark('italic')],
  [mark('strike')],
  [mark('code')],
  [linkMark('https://example.test/source', 'Source')],
];
const removeMetadata = removeChangeIds.map((id, index) =>
  pendingChange(
    id,
    `${removeChangeSetId}:${requiredAt(removeOperationIds, index, 'remove operation')}`,
    'format',
    removeFormatId,
    5,
    removePreviousMarks[index],
  ),
) as readonly FixtureChangeMetadata[];
const removeFormatProposed = state(
  doc(
    paragraph(removeFormatId, [
      text('BOLD', [diffMark(requiredAt(removeChangeIds, 0, 'remove change'), 'format')]),
      text('ITAL', [diffMark(requiredAt(removeChangeIds, 1, 'remove change'), 'format')]),
      text('STRK', [diffMark(requiredAt(removeChangeIds, 2, 'remove change'), 'format')]),
      text('CODE', [diffMark(requiredAt(removeChangeIds, 3, 'remove change'), 'format')]),
      text('LINK', [diffMark(requiredAt(removeChangeIds, 4, 'remove change'), 'format')]),
    ]),
  ),
  removeMetadata,
);

const directAdjacentFormattingRemoval: FixtureDefinition = {
  format: FIXTURE_FORMAT,
  formatVersion: FIXTURE_FORMAT_VERSION,
  id: 'format-text-direct-remove-adjacent-marks',
  title: 'Suggested removal of adjacent ordinary marks',
  description:
    'Removes bold, italic, strike, code, and link marks from five adjacent ranges in one atomic batch.',
  seed: 420_009,
  schema,
  tags: ['adjacent', 'batch', 'bold', 'code', 'format-text', 'italic', 'link', 'strike', 'suggest'],
  subject: { nodeType: 'paragraph', tracking: 'inline' },
  request: applyEditsRequestSchema.parse({
    documentId: 'doc_fixture_format_text_direct_remove',
    documentIncarnation: 'inc_fixture_format_text_direct_remove',
    schemaId: schema.id,
    schemaVersion: schema.version,
    idempotencyKey: 'idem_fixture_format_text_direct_remove_v1',
    changeMode: 'suggest',
    operations: [
      {
        operationId: 'op_remove_bold',
        kind: 'format_text',
        blockId: removeFormatId,
        expectedBlockDigest: removeFormatDigest,
        range: { from: 0, to: 4 },
        action: 'remove',
        mark: { type: 'bold' },
      },
      {
        operationId: 'op_remove_italic',
        kind: 'format_text',
        blockId: removeFormatId,
        expectedBlockDigest: removeFormatDigest,
        range: { from: 4, to: 8 },
        action: 'remove',
        mark: { type: 'italic' },
      },
      {
        operationId: 'op_remove_strike',
        kind: 'format_text',
        blockId: removeFormatId,
        expectedBlockDigest: removeFormatDigest,
        range: { from: 8, to: 12 },
        action: 'remove',
        mark: { type: 'strike' },
      },
      {
        operationId: 'op_remove_code',
        kind: 'format_text',
        blockId: removeFormatId,
        expectedBlockDigest: removeFormatDigest,
        range: { from: 12, to: 16 },
        action: 'remove',
        mark: { type: 'code' },
      },
      {
        operationId: 'op_remove_link',
        kind: 'format_text',
        blockId: removeFormatId,
        expectedBlockDigest: removeFormatDigest,
        range: { from: 16, to: 20 },
        action: 'remove',
        mark: { type: 'link', href: 'https://example.test/source', title: 'Source' },
      },
    ],
  }),
  resolution: { kind: 'accept_reject', changeIds: removeChangeIds },
  expected: suggestedExpected(
    removeFormatBefore,
    removeFormatProposed,
    state(removeFormatAfter.document, resolvedChanges(removeMetadata, 'accepted')),
    state(removeFormatBefore.document, resolvedChanges(removeMetadata, 'rejected')),
  ),
  invariants: suggestedInvariants,
};

const adjacentReplaceId = '51000010-0000-4000-8000-000000000010';
const adjacentReplaceBefore = state(doc(paragraph(adjacentReplaceId, [text('red青blue')])));
const adjacentReplaceAfter = state(doc(paragraph(adjacentReplaceId, [text('RED藍BLUE')])));
const adjacentReplaceDigest = targetDigest(adjacentReplaceBefore.document, adjacentReplaceId);
const adjacentFactories = createDeterministicFixtureFactories(420_010);
const adjacentChangeIds = Array.from({ length: 3 }, () => adjacentFactories.changeId());
const adjacentChangeSetId = adjacentFactories.changeSetId();
const adjacentOperationIds = ['op_replace_blue', 'op_replace_cjk', 'op_replace_red'] as const;
const adjacentMetadata = adjacentChangeIds.map((id) =>
  pendingChange(
    id,
    `${adjacentChangeSetId}:${requiredAt(adjacentOperationIds, adjacentChangeIds.indexOf(id), 'adjacent operation')}`,
    'replace',
    adjacentReplaceId,
    3,
  ),
) as readonly FixtureChangeMetadata[];
const adjacentReplaceProposed = state(
  doc(
    paragraph(adjacentReplaceId, [
      text('red', [diffMark(requiredAt(adjacentChangeIds, 2, 'adjacent change'), 'delete')]),
      text('RED', [diffMark(requiredAt(adjacentChangeIds, 2, 'adjacent change'), 'insert')]),
      text('青', [diffMark(requiredAt(adjacentChangeIds, 1, 'adjacent change'), 'delete')]),
      text('藍', [diffMark(requiredAt(adjacentChangeIds, 1, 'adjacent change'), 'insert')]),
      text('blue', [diffMark(requiredAt(adjacentChangeIds, 0, 'adjacent change'), 'delete')]),
      text('BLUE', [diffMark(requiredAt(adjacentChangeIds, 0, 'adjacent change'), 'insert')]),
    ]),
  ),
  adjacentMetadata,
);

const directAdjacentTextBatch: FixtureDefinition = {
  format: FIXTURE_FORMAT,
  formatVersion: FIXTURE_FORMAT_VERSION,
  id: 'replace-text-direct-adjacent-batch',
  title: 'Suggested adjacent text replacements',
  description:
    'Applies three same-length adjacent replacements against one authoritative before-state digest in a single atomic batch.',
  seed: 420_010,
  schema,
  tags: ['adjacent', 'batch', 'non-latin', 'replace-text', 'suggest', 'unicode'],
  subject: { nodeType: 'paragraph', tracking: 'inline' },
  request: applyEditsRequestSchema.parse({
    documentId: 'doc_fixture_replace_text_direct_adjacent',
    documentIncarnation: 'inc_fixture_replace_text_direct_adjacent',
    schemaId: schema.id,
    schemaVersion: schema.version,
    idempotencyKey: 'idem_fixture_replace_text_direct_adjacent_v1',
    changeMode: 'suggest',
    operations: [
      {
        operationId: 'op_replace_blue',
        kind: 'replace_text',
        blockId: adjacentReplaceId,
        expectedBlockDigest: adjacentReplaceDigest,
        range: { from: 4, to: 8 },
        text: 'BLUE',
      },
      {
        operationId: 'op_replace_cjk',
        kind: 'replace_text',
        blockId: adjacentReplaceId,
        expectedBlockDigest: adjacentReplaceDigest,
        range: { from: 3, to: 4 },
        text: '藍',
      },
      {
        operationId: 'op_replace_red',
        kind: 'replace_text',
        blockId: adjacentReplaceId,
        expectedBlockDigest: adjacentReplaceDigest,
        range: { from: 0, to: 3 },
        text: 'RED',
      },
    ],
  }),
  resolution: { kind: 'accept_reject', changeIds: adjacentChangeIds },
  expected: suggestedExpected(
    adjacentReplaceBefore,
    adjacentReplaceProposed,
    state(adjacentReplaceAfter.document, resolvedChanges(adjacentMetadata, 'accepted')),
    state(adjacentReplaceBefore.document, resolvedChanges(adjacentMetadata, 'rejected')),
  ),
  invariants: suggestedInvariants,
};

export const textAndFormattingFixtures: readonly FixtureDefinition[] = deepFreeze([
  directInsertEmoji,
  suggestedInsertUnicode,
  directDeleteBidi,
  suggestedDeleteWhitespace,
  directReplaceEmoji,
  suggestedReplaceNormalization,
  suggestedAddBold,
  directOverlappingFormatting,
  directAdjacentFormattingRemoval,
  directAdjacentTextBatch,
]);
