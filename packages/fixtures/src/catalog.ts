import { applyEditsRequestSchema } from '@editor-mcp/protocol';

import { createDeterministicFixtureFactories } from './determinism.js';
import { blockFixtures } from './block-fixtures.js';
import { cloneFixtureState, deepFreeze } from './helpers.js';
import { structuralFixtures } from './structure-fixtures.js';
import { tableFixtures } from './table-fixtures.js';
import { textAndFormattingFixtures } from './text-fixtures.js';
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
  type JsonValue,
} from './types.js';

const schema = {
  id: 'editor-mcp/mvp',
  version: 1,
} as const;

const emptyTracking = {
  diffChangeId: null,
  diffChangeKind: null,
} as const;

const text = (value: string, marks: readonly FixtureMark[] = []): FixtureNode => ({
  type: 'text',
  ...(marks.length === 0 ? {} : { marks }),
  text: value,
});

const trackedAttrs = (
  blockId: string,
  change?: {
    readonly id: string;
    readonly kind: 'delete' | 'insert' | 'modify';
  },
): Readonly<Record<string, JsonValue>> => ({
  blockId,
  diffChangeId: change?.id ?? null,
  diffChangeKind: change?.kind ?? null,
});

const paragraph = (
  blockId: string,
  content: readonly FixtureNode[],
  change?: {
    readonly id: string;
    readonly kind: 'delete' | 'insert' | 'modify';
  },
): FixtureNode => ({
  type: 'paragraph',
  attrs: trackedAttrs(blockId, change),
  ...(content.length === 0 ? {} : { content }),
});

const heading = (
  blockId: string,
  level: number,
  value: string,
  change?: {
    readonly id: string;
    readonly kind: 'delete' | 'insert' | 'modify';
  },
): FixtureNode => ({
  type: 'heading',
  attrs: {
    ...trackedAttrs(blockId, change),
    level,
  },
  content: [text(value)],
});

const blockquote = (
  blockId: string,
  child: FixtureNode,
  change?: {
    readonly id: string;
    readonly kind: 'delete' | 'insert' | 'modify';
  },
): FixtureNode => ({
  type: 'blockquote',
  attrs: trackedAttrs(blockId, change),
  content: [child],
});

const tableCell = (
  type: 'tableCell' | 'tableHeader',
  blockId: string,
  child: FixtureNode,
): FixtureNode => ({
  type,
  attrs: {
    blockId,
    colspan: 1,
    rowspan: 1,
    colwidth: null,
    ...emptyTracking,
  },
  content: [child],
});

const tableRow = (
  blockId: string,
  cells: readonly FixtureNode[],
  change?: {
    readonly id: string;
    readonly kind: 'delete' | 'insert' | 'modify';
  },
): FixtureNode => ({
  type: 'tableRow',
  attrs: trackedAttrs(blockId, change),
  content: cells,
});

const table = (blockId: string, rows: readonly FixtureNode[]): FixtureNode => ({
  type: 'table',
  attrs: trackedAttrs(blockId),
  content: rows,
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
  diffChanges,
});

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
] as const satisfies readonly FixtureInvariant[];

const cleanResolutionInvariant = {
  id: 'clean-resolutions-have-no-diff-artifacts',
  description:
    'Accepted and rejected documents contain no diff marks or non-null tracking attributes.',
} as const satisfies FixtureInvariant;

const noOrphanInvariant = {
  id: 'no-orphaned-change-metadata',
  description:
    'Each pending metadata record has at least one document segment and every segment has metadata.',
} as const satisfies FixtureInvariant;

const rejectedEqualsBeforeInvariant = {
  id: 'rejected-equals-before',
  description: 'Rejecting the proposal restores the original canonical document.',
} as const satisfies FixtureInvariant;

const newReplacementIdentityInvariant = {
  id: 'replacement-block-id-is-new',
  description:
    'A block replacement retires the target ID and assigns fresh server-owned IDs to replacement content.',
} as const satisfies FixtureInvariant;

const unrelatedBlocksInvariant = {
  id: 'unrelated-blocks-are-unchanged',
  description: 'Blocks outside the semantic target remain canonically unchanged.',
} as const satisfies FixtureInvariant;

const resolvedMetadata = (
  changes: readonly FixtureChangeMetadata[],
  status: 'accepted' | 'rejected',
): readonly FixtureChangeMetadata[] =>
  changes.map((change) => ({
    ...change,
    status,
    resolvedAt: '2026-01-15T12:05:00.000Z',
    resolvedBy: 'reviewer-fixture',
  }));

const directIds = {
  heading: '11111111-1111-4111-8111-111111111101',
  target: '11111111-1111-4111-8111-111111111102',
  closing: '11111111-1111-4111-8111-111111111103',
} as const;
const directFactories = createDeterministicFixtureFactories(410_001);
const directReplacementId = directFactories.blockId();
const directChangeId = directFactories.changeId();
const directChangeSetId = `${directFactories.changeSetId()}:op_replace_direct`;

const directBefore = state(
  doc(
    heading(directIds.heading, 1, 'Study overview'),
    paragraph(directIds.target, [text('The study measures safety.')]),
    paragraph(directIds.closing, [text('Enrollment begins in June.')]),
  ),
);

const directPendingMetadata = [
  {
    id: directChangeId,
    groupId: directChangeSetId,
    status: 'pending',
    operation: 'replace',
    authorId: 'agent-fixture',
    authorType: 'agent',
    createdAt: '2026-01-15T12:00:00.000Z',
    summary: '1 operation edit batch',
    baseBlockId: directIds.target,
  },
] as const satisfies readonly FixtureChangeMetadata[];

const directProposed = (): FixtureState =>
  state(
    doc(
      heading(directIds.heading, 1, 'Study overview'),
      paragraph(directIds.target, [text('The study measures safety.')], {
        id: directChangeId,
        kind: 'delete',
      }),
      heading(directReplacementId, 2, 'The study evaluates safety and efficacy.', {
        id: directChangeId,
        kind: 'insert',
      }),
      paragraph(directIds.closing, [text('Enrollment begins in June.')]),
    ),
    directPendingMetadata,
  );

const directReplaceFixture: FixtureDefinition = {
  format: FIXTURE_FORMAT,
  formatVersion: FIXTURE_FORMAT_VERSION,
  id: 'replace-block-direct-type-change',
  title: 'Suggested paragraph-to-heading replacement',
  description:
    'Shows the retired paragraph as a deletion and its newly identified replacement heading as an insertion under one tracked change.',
  seed: 410_001,
  schema,
  tags: ['block', 'replace-block', 'resolution', 'suggest', 'type-change'],
  subject: {
    nodeType: 'paragraph',
    tracking: 'block',
  },
  request: applyEditsRequestSchema.parse({
    documentId: 'doc_fixture_replace_direct',
    documentIncarnation: 'inc_fixture_replace_direct',
    schemaId: schema.id,
    schemaVersion: schema.version,
    idempotencyKey: 'idem_fixture_replace_direct_v1',
    changeMode: 'suggest',
    operations: [
      {
        operationId: 'op_replace_direct',
        kind: 'replace_block',
        blockId: directIds.target,
        expectedBlockDigest:
          'sha256:b003481d563764f971b9448ee6a21e8b69fadcadeec84cd3fba992eba05e9dec',
        html: '<h2>The study evaluates safety and efficacy.</h2>',
      },
    ],
  }),
  resolution: {
    kind: 'accept_reject',
    changeIds: [directChangeId],
  },
  expected: {
    states: {
      before: directBefore,
      proposed: directProposed(),
      accepted: state(
        doc(
          heading(directIds.heading, 1, 'Study overview'),
          heading(directReplacementId, 2, 'The study evaluates safety and efficacy.'),
          paragraph(directIds.closing, [text('Enrollment begins in June.')]),
        ),
        resolvedMetadata(directPendingMetadata, 'accepted'),
      ),
      rejected: state(directBefore.document, resolvedMetadata(directPendingMetadata, 'rejected')),
    },
    conflicts: [],
    generatedBlockIds: [directReplacementId],
  },
  invariants: [
    ...commonInvariants,
    cleanResolutionInvariant,
    noOrphanInvariant,
    rejectedEqualsBeforeInvariant,
    newReplacementIdentityInvariant,
    unrelatedBlocksInvariant,
  ],
};

const inlineIds = {
  heading: '22222222-2222-4222-8222-222222222201',
  target: '22222222-2222-4222-8222-222222222202',
  closing: '22222222-2222-4222-8222-222222222203',
} as const;

const inlineFactories = createDeterministicFixtureFactories(410_002);
const inlineReplacementId = inlineFactories.blockId();
const inlineChanges = {
  replacement: inlineFactories.changeId(),
  group: `${inlineFactories.changeSetId()}:op_replace_suggest`,
} as const;

const inlinePendingMetadata = [
  {
    id: inlineChanges.replacement,
    groupId: inlineChanges.group,
    status: 'pending',
    operation: 'replace',
    authorId: 'agent-fixture',
    authorType: 'agent',
    createdAt: '2026-01-15T12:00:00.000Z',
    summary: '1 operation edit batch',
    baseBlockId: inlineIds.target,
  },
] as const satisfies readonly FixtureChangeMetadata[];

const inlineBefore = (): FixtureState =>
  state(
    doc(
      heading(inlineIds.heading, 1, 'Study outcomes'),
      paragraph(inlineIds.target, [text('The study measures safety.')]),
      paragraph(inlineIds.closing, [text('Results will be peer reviewed.')]),
    ),
  );

const inlineProposed = state(
  doc(
    heading(inlineIds.heading, 1, 'Study outcomes'),
    paragraph(inlineIds.target, [text('The study measures safety.')], {
      id: inlineChanges.replacement,
      kind: 'delete',
    }),
    paragraph(inlineReplacementId, [text('The study measures safety and efficacy.')], {
      id: inlineChanges.replacement,
      kind: 'insert',
    }),
    paragraph(inlineIds.closing, [text('Results will be peer reviewed.')]),
  ),
  inlinePendingMetadata,
);

const inlineAccepted = state(
  doc(
    heading(inlineIds.heading, 1, 'Study outcomes'),
    paragraph(inlineReplacementId, [text('The study measures safety and efficacy.')]),
    paragraph(inlineIds.closing, [text('Results will be peer reviewed.')]),
  ),
  resolvedMetadata(inlinePendingMetadata, 'accepted'),
);

const inlineRejected = state(
  inlineBefore().document,
  resolvedMetadata(inlinePendingMetadata, 'rejected'),
);

const suggestedBlockReplaceFixture: FixtureDefinition = {
  format: FIXTURE_FORMAT,
  formatVersion: FIXTURE_FORMAT_VERSION,
  id: 'replace-block-suggest-blocks',
  title: 'Suggested whole-block paragraph replacement',
  description:
    'Keeps the old block as a deletion and the newly identified replacement as an insertion under one change ID.',
  seed: 410_002,
  schema,
  tags: ['block', 'replace-block', 'resolution', 'suggest'],
  subject: {
    nodeType: 'paragraph',
    tracking: 'block',
  },
  request: applyEditsRequestSchema.parse({
    documentId: 'doc_fixture_replace_suggest',
    documentIncarnation: 'inc_fixture_replace_suggest',
    schemaId: schema.id,
    schemaVersion: schema.version,
    idempotencyKey: 'idem_fixture_replace_suggest_v1',
    changeMode: 'suggest',
    operations: [
      {
        operationId: 'op_replace_suggest',
        kind: 'replace_block',
        blockId: inlineIds.target,
        expectedBlockDigest:
          'sha256:5b556e1b24aa5da52298ae0869ddaa1b20ac6a05b345db3956d53ba19c4bdcc8',
        html: '<p>The study measures safety and efficacy.</p>',
      },
    ],
  }),
  resolution: {
    kind: 'accept_reject',
    changeIds: [inlineChanges.replacement],
  },
  expected: {
    states: {
      before: inlineBefore(),
      proposed: inlineProposed,
      accepted: inlineAccepted,
      rejected: inlineRejected,
    },
    conflicts: [],
    generatedBlockIds: [inlineReplacementId],
  },
  invariants: [
    ...commonInvariants,
    cleanResolutionInvariant,
    noOrphanInvariant,
    rejectedEqualsBeforeInvariant,
    newReplacementIdentityInvariant,
    unrelatedBlocksInvariant,
  ],
};

const blockIds = {
  heading: '33333333-3333-4333-8333-333333333301',
  target: '33333333-3333-4333-8333-333333333302',
  nested: '33333333-3333-4333-8333-333333333303',
  closing: '33333333-3333-4333-8333-333333333304',
} as const;

const blockFactories = createDeterministicFixtureFactories(410_003);
const blockChangeId = blockFactories.changeId();
const blockChangeSetId = `${blockFactories.changeSetId()}:op_delete_block`;

const blockPendingMetadata = [
  {
    id: blockChangeId,
    groupId: blockChangeSetId,
    status: 'pending',
    operation: 'delete',
    authorId: 'agent-fixture',
    authorType: 'agent',
    createdAt: '2026-01-15T12:00:00.000Z',
    summary: '1 operation edit batch',
    baseBlockId: blockIds.target,
  },
] as const satisfies readonly FixtureChangeMetadata[];

const cleanBlockquote = (): FixtureNode =>
  blockquote(
    blockIds.target,
    paragraph(blockIds.nested, [text('This eligibility note is obsolete.')]),
  );

const blockBefore = (): FixtureState =>
  state(
    doc(
      heading(blockIds.heading, 2, 'Eligibility'),
      cleanBlockquote(),
      paragraph(blockIds.closing, [text('Screening is required.')]),
    ),
  );

const blockDeleteFixture: FixtureDefinition = {
  format: FIXTURE_FORMAT,
  formatVersion: FIXTURE_FORMAT_VERSION,
  id: 'delete-block-suggest-blockquote',
  title: 'Suggested blockquote deletion',
  description:
    'Keeps a deleted block in the proposed document with block tracking until it is resolved.',
  seed: 410_003,
  schema,
  tags: ['block', 'delete-block', 'resolution', 'suggest'],
  subject: {
    nodeType: 'blockquote',
    tracking: 'block',
  },
  request: applyEditsRequestSchema.parse({
    documentId: 'doc_fixture_delete_block',
    documentIncarnation: 'inc_fixture_delete_block',
    schemaId: schema.id,
    schemaVersion: schema.version,
    idempotencyKey: 'idem_fixture_delete_block_v1',
    changeMode: 'suggest',
    operations: [
      {
        operationId: 'op_delete_block',
        kind: 'delete_block',
        blockId: blockIds.target,
        expectedBlockDigest:
          'sha256:0d291ac482df1b0ba3a06265c8d37448d767ced543a82d661f5b579e93637c3e',
      },
    ],
  }),
  resolution: {
    kind: 'accept_reject',
    changeIds: [blockChangeId],
  },
  expected: {
    states: {
      before: blockBefore(),
      proposed: state(
        doc(
          heading(blockIds.heading, 2, 'Eligibility'),
          blockquote(
            blockIds.target,
            paragraph(blockIds.nested, [text('This eligibility note is obsolete.')]),
            { id: blockChangeId, kind: 'delete' },
          ),
          paragraph(blockIds.closing, [text('Screening is required.')]),
        ),
        blockPendingMetadata,
      ),
      accepted: state(
        doc(
          heading(blockIds.heading, 2, 'Eligibility'),
          paragraph(blockIds.closing, [text('Screening is required.')]),
        ),
        resolvedMetadata(blockPendingMetadata, 'accepted'),
      ),
      rejected: state(blockBefore().document, resolvedMetadata(blockPendingMetadata, 'rejected')),
    },
    conflicts: [],
    generatedBlockIds: [],
  },
  invariants: [
    ...commonInvariants,
    cleanResolutionInvariant,
    noOrphanInvariant,
    rejectedEqualsBeforeInvariant,
    unrelatedBlocksInvariant,
  ],
};

const tableIds = {
  heading: '44444444-4444-4444-8444-444444444401',
  table: '44444444-4444-4444-8444-444444444402',
  headerRow: '44444444-4444-4444-8444-444444444403',
  headerCellA: '44444444-4444-4444-8444-444444444404',
  headerTextA: '44444444-4444-4444-8444-444444444405',
  headerCellB: '44444444-4444-4444-8444-444444444406',
  headerTextB: '44444444-4444-4444-8444-444444444407',
  bodyRow: '44444444-4444-4444-8444-444444444408',
  bodyCellA: '44444444-4444-4444-8444-444444444409',
  bodyTextA: '44444444-4444-4444-8444-444444444410',
  bodyCellB: '44444444-4444-4444-8444-444444444411',
  bodyTextB: '44444444-4444-4444-8444-444444444412',
} as const;

const tableFactories = createDeterministicFixtureFactories(410_004);
const tableGeneratedIds = {
  generatedCellA: tableFactories.blockId(),
  generatedTextA: tableFactories.blockId(),
  generatedCellB: tableFactories.blockId(),
  generatedTextB: tableFactories.blockId(),
  generatedRow: tableFactories.blockId(),
} as const;
const tableChangeId = tableFactories.changeId();
const tableChangeSetId = `${tableFactories.changeSetId()}:op_insert_table_row`;

const headerRow = (): FixtureNode =>
  tableRow(tableIds.headerRow, [
    tableCell(
      'tableHeader',
      tableIds.headerCellA,
      paragraph(tableIds.headerTextA, [text('Outcome')]),
    ),
    tableCell(
      'tableHeader',
      tableIds.headerCellB,
      paragraph(tableIds.headerTextB, [text('Result')]),
    ),
  ]);

const bodyRow = (): FixtureNode =>
  tableRow(tableIds.bodyRow, [
    tableCell('tableCell', tableIds.bodyCellA, paragraph(tableIds.bodyTextA, [text('Safety')])),
    tableCell('tableCell', tableIds.bodyCellB, paragraph(tableIds.bodyTextB, [text('Met')])),
  ]);

const generatedRow = (tracked: boolean): FixtureNode =>
  tableRow(
    tableGeneratedIds.generatedRow,
    [
      tableCell(
        'tableCell',
        tableGeneratedIds.generatedCellA,
        paragraph(tableGeneratedIds.generatedTextA, []),
      ),
      tableCell(
        'tableCell',
        tableGeneratedIds.generatedCellB,
        paragraph(tableGeneratedIds.generatedTextB, []),
      ),
    ],
    tracked ? { id: tableChangeId, kind: 'insert' } : undefined,
  );

const tableBefore = (): FixtureState =>
  state(
    doc(
      heading(tableIds.heading, 2, 'Outcome matrix'),
      table(tableIds.table, [headerRow(), bodyRow()]),
    ),
  );

const tablePendingMetadata = [
  {
    id: tableChangeId,
    groupId: tableChangeSetId,
    status: 'pending',
    operation: 'structure',
    authorId: 'agent-fixture',
    authorType: 'agent',
    createdAt: '2026-01-15T12:00:00.000Z',
    summary: '1 operation edit batch',
    baseBlockId: tableIds.table,
  },
] as const satisfies readonly FixtureChangeMetadata[];

const tableRowInsertFixture: FixtureDefinition = {
  format: FIXTURE_FORMAT,
  formatVersion: FIXTURE_FORMAT_VERSION,
  id: 'insert-table-row-suggest',
  title: 'Suggested table row insertion',
  description:
    'Inserts a rectangular table row with deterministic server-owned descendant IDs and row-level tracking.',
  seed: 410_004,
  schema,
  tags: ['insert-table-row', 'resolution', 'suggest', 'table'],
  subject: {
    nodeType: 'tableRow',
    tracking: 'table',
  },
  request: applyEditsRequestSchema.parse({
    documentId: 'doc_fixture_insert_table_row',
    documentIncarnation: 'inc_fixture_insert_table_row',
    schemaId: schema.id,
    schemaVersion: schema.version,
    idempotencyKey: 'idem_fixture_insert_table_row_v1',
    changeMode: 'suggest',
    operations: [
      {
        operationId: 'op_insert_table_row',
        kind: 'insert_table_row',
        tableId: tableIds.table,
        rowIndex: 1,
        position: 'after',
        expectedTableDigest:
          'sha256:d6a3636fb1860a5783bc4cc814d865366532e2fd51ccceb8f2355885a87dfcbf',
      },
    ],
  }),
  resolution: {
    kind: 'accept_reject',
    changeIds: [tableChangeId],
  },
  expected: {
    states: {
      before: tableBefore(),
      proposed: state(
        doc(
          heading(tableIds.heading, 2, 'Outcome matrix'),
          table(tableIds.table, [headerRow(), bodyRow(), generatedRow(true)]),
        ),
        tablePendingMetadata,
      ),
      accepted: state(
        doc(
          heading(tableIds.heading, 2, 'Outcome matrix'),
          table(tableIds.table, [headerRow(), bodyRow(), generatedRow(false)]),
        ),
        resolvedMetadata(tablePendingMetadata, 'accepted'),
      ),
      rejected: state(tableBefore().document, resolvedMetadata(tablePendingMetadata, 'rejected')),
    },
    conflicts: [],
    generatedBlockIds: [
      tableGeneratedIds.generatedRow,
      tableGeneratedIds.generatedCellA,
      tableGeneratedIds.generatedTextA,
      tableGeneratedIds.generatedCellB,
      tableGeneratedIds.generatedTextB,
    ],
  },
  invariants: [
    ...commonInvariants,
    cleanResolutionInvariant,
    noOrphanInvariant,
    rejectedEqualsBeforeInvariant,
    unrelatedBlocksInvariant,
    {
      id: 'generated-block-ids-are-server-owned',
      description:
        'The request contains no generated IDs; seeded execution returns the listed unique row descendants.',
    },
  ],
};

export const fixtureCatalog: readonly FixtureDefinition[] = deepFreeze([
  directReplaceFixture,
  suggestedBlockReplaceFixture,
  blockDeleteFixture,
  tableRowInsertFixture,
  ...blockFixtures,
  ...textAndFormattingFixtures,
  ...structuralFixtures,
  ...tableFixtures,
]);

export const fixtureCatalogById: Readonly<Record<string, FixtureDefinition>> = deepFreeze(
  Object.fromEntries(fixtureCatalog.map((fixture) => [fixture.id, fixture])),
);

export const cloneExpectedStates = (
  fixture: FixtureDefinition,
): FixtureDefinition['expected']['states'] => ({
  before: cloneFixtureState(fixture.expected.states.before),
  proposed: cloneFixtureState(fixture.expected.states.proposed),
  accepted: cloneFixtureState(fixture.expected.states.accepted),
  rejected: cloneFixtureState(fixture.expected.states.rejected),
});
