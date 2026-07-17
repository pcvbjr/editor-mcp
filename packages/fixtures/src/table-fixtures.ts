import {
  canonicalizeDocument,
  digestBlock,
  findBlockById,
  listBlockSummaries,
  mvpSchema,
  parseAgentHtml,
  replaceNodeAtPath,
} from '@editor-mcp/adapter-tiptap-hocuspocus';
import { applyEditsRequestSchema } from '@editor-mcp/protocol';

import { createDeterministicFixtureFactories } from './determinism.js';
import { createDirectReplacementFixture } from './direct-fixture-builder.js';
import {
  FIXTURE_FORMAT,
  FIXTURE_FORMAT_VERSION,
  type FixtureDefinition,
  type FixtureChangeMetadata,
  type FixtureDocument,
  type FixtureInvariant,
  type FixtureState,
} from './types.js';

type CanonicalNode = ReturnType<typeof canonicalizeDocument>;

type DirectTableOperation =
  | {
      readonly kind: 'delete_table_column';
      readonly columnIndex: number;
    }
  | {
      readonly kind: 'delete_table_row';
      readonly rowIndex: number;
    }
  | {
      readonly columnIndex: number;
      readonly kind: 'insert_table_column';
      readonly position: 'after' | 'before';
    }
  | {
      readonly kind: 'insert_table_row';
      readonly position: 'after' | 'before';
      readonly rowIndex: number;
    };

interface DirectTableOperationFixtureInput {
  readonly beforeHtml: string;
  readonly description: string;
  readonly id: string;
  readonly operation: DirectTableOperation;
  readonly seed: number;
  readonly tags: readonly string[];
  readonly title: string;
}

interface ReplacementFixtureInput {
  readonly beforeHtml: string;
  readonly description: string;
  readonly html: string;
  readonly id: string;
  readonly seed: number;
  readonly subjectNodeType: string;
  readonly tags: readonly string[];
  readonly targetNodeType: string;
  readonly targetOccurrence?: number;
  readonly title: string;
}

const suggestedTableInvariants = [
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
    description: 'Accepted keeps the table edit; rejected restores the exact before table.',
  },
  {
    id: 'unrelated-blocks-are-unchanged',
    description: 'Blocks outside the semantic table target remain canonically unchanged.',
  },
  {
    id: 'clean-resolutions-have-no-diff-artifacts',
    description: 'Resolved table states contain no pending tracking attributes.',
  },
  {
    id: 'rejected-equals-before',
    description: 'Rejecting the table proposal restores the original canonical document.',
  },
] as const satisfies readonly FixtureInvariant[];

function fixtureDocument(node: CanonicalNode): FixtureDocument {
  // ProseMirror's JSON is certified immediately before this structural boundary conversion.
  return structuredClone(node.toJSON()) as FixtureDocument;
}

function fixtureState(document: FixtureDocument): FixtureState {
  return {
    document: structuredClone(document),
    diffChanges: [],
  };
}

function parseBefore(seed: number, html: string): CanonicalNode {
  const beforeFactories = createDeterministicFixtureFactories(seed + 1_000_000);
  return parseAgentHtml(html, { idFactory: beforeFactories.blockId });
}

function blockIdAt(document: CanonicalNode, nodeType: string, occurrence = 0): string {
  const match = listBlockSummaries(document).filter((summary) => summary.nodeType === nodeType)[
    occurrence
  ];
  if (match === undefined) {
    throw new TypeError(
      `Fixture target ${nodeType} occurrence ${String(occurrence)} does not exist`,
    );
  }
  return match.id;
}

function replacementFixture(input: ReplacementFixtureInput): FixtureDefinition {
  const before = parseBefore(input.seed, input.beforeHtml);
  return createDirectReplacementFixture({
    id: input.id,
    title: input.title,
    description: input.description,
    seed: input.seed,
    tags: input.tags,
    subjectNodeType: input.subjectNodeType,
    before: fixtureDocument(before),
    targetBlockId: blockIdAt(before, input.targetNodeType, input.targetOccurrence ?? 0),
    html: input.html,
  });
}

function requiredParagraphType() {
  const paragraph = mvpSchema.nodes['paragraph'];
  if (paragraph === undefined) {
    throw new TypeError('The certified MVP schema must define paragraph');
  }
  return paragraph;
}

function freshCell(template: CanonicalNode, idFactory: () => string): CanonicalNode {
  const cellId = idFactory();
  const paragraphId = idFactory();
  const paragraph = requiredParagraphType().create({
    blockId: paragraphId,
    diffChangeId: null,
    diffChangeKind: null,
  });
  return template.type.create(
    {
      ...template.attrs,
      blockId: cellId,
      colspan: 1,
      rowspan: 1,
      colwidth: null,
      diffChangeId: null,
      diffChangeKind: null,
    },
    paragraph,
    template.marks,
  );
}

function freshRow(template: CanonicalNode, idFactory: () => string): CanonicalNode {
  const cells = Array.from({ length: template.childCount }, (_, index) =>
    freshCell(template.child(index), idFactory),
  );
  return template.type.create(
    {
      ...template.attrs,
      blockId: idFactory(),
      diffChangeId: null,
      diffChangeKind: null,
    },
    cells,
    template.marks,
  );
}

function applyDirectTableOperation(
  before: CanonicalNode,
  tableId: string,
  operation: DirectTableOperation,
  idFactory: () => string,
): CanonicalNode {
  const target = findBlockById(before, tableId);
  const table = target.node;
  const rows = Array.from({ length: table.childCount }, (_, index) => table.child(index));

  switch (operation.kind) {
    case 'insert_table_row': {
      const anchor = rows[operation.rowIndex];
      if (anchor === undefined) {
        throw new TypeError('The row insertion anchor must exist');
      }
      const inserted = freshRow(anchor, idFactory);
      const insertionIndex = operation.rowIndex + (operation.position === 'after' ? 1 : 0);
      rows.splice(insertionIndex, 0, inserted);
      break;
    }
    case 'delete_table_row': {
      if (rows[operation.rowIndex] === undefined || rows.length <= 1) {
        throw new TypeError('The row deletion target must exist and cannot be the only row');
      }
      rows.splice(operation.rowIndex, 1);
      break;
    }
    case 'insert_table_column':
    case 'delete_table_column': {
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        const row = rows[rowIndex];
        if (row === undefined) {
          throw new TypeError('A rectangular fixture row was unexpectedly absent');
        }
        const cells = Array.from({ length: row.childCount }, (_, index) => row.child(index));
        const anchor = cells[operation.columnIndex];
        if (anchor === undefined) {
          throw new TypeError('The column operation anchor must exist in every row');
        }
        if (operation.kind === 'insert_table_column') {
          const insertionIndex = operation.columnIndex + (operation.position === 'after' ? 1 : 0);
          cells.splice(insertionIndex, 0, freshCell(anchor, idFactory));
        } else {
          if (cells.length <= 1) {
            throw new TypeError('The column deletion cannot remove the only column');
          }
          cells.splice(operation.columnIndex, 1);
        }
        rows[rowIndex] = row.type.create(row.attrs, cells, row.marks);
      }
      break;
    }
  }

  const updatedTable = table.type.create(table.attrs, rows, table.marks);
  return canonicalizeDocument(replaceNodeAtPath(before, target.path, updatedTable));
}

function operationPayload(
  operationId: string,
  tableId: string,
  tableDigest: `sha256:${string}`,
  operation: DirectTableOperation,
) {
  switch (operation.kind) {
    case 'insert_table_row':
      return {
        operationId,
        kind: operation.kind,
        tableId,
        rowIndex: operation.rowIndex,
        position: operation.position,
        expectedTableDigest: tableDigest,
      } as const;
    case 'delete_table_row':
      return {
        operationId,
        kind: operation.kind,
        tableId,
        rowIndex: operation.rowIndex,
        expectedTableDigest: tableDigest,
      } as const;
    case 'insert_table_column':
      return {
        operationId,
        kind: operation.kind,
        tableId,
        columnIndex: operation.columnIndex,
        position: operation.position,
        expectedTableDigest: tableDigest,
      } as const;
    case 'delete_table_column':
      return {
        operationId,
        kind: operation.kind,
        tableId,
        columnIndex: operation.columnIndex,
        expectedTableDigest: tableDigest,
      } as const;
  }
}

function trackedTableNode(node: CanonicalNode, changeId: string, kind: 'delete' | 'insert') {
  return node.type.create(
    { ...node.attrs, diffChangeId: changeId, diffChangeKind: kind },
    node.content,
    node.marks,
  );
}

function directTableOperationFixture(input: DirectTableOperationFixtureInput): FixtureDefinition {
  const before = parseBefore(input.seed, input.beforeHtml);
  const tableId = blockIdAt(before, 'table');
  const table = findBlockById(before, tableId).node;
  const factories = createDeterministicFixtureFactories(input.seed);
  const after = applyDirectTableOperation(before, tableId, input.operation, factories.blockId);
  const beforeIds = new Set(listBlockSummaries(before).map(({ id }) => id));
  const generatedBlockIds = listBlockSummaries(after)
    .map(({ id }) => id)
    .filter((id) => !beforeIds.has(id));
  const beforeDocument = fixtureDocument(before);
  const afterDocument = fixtureDocument(after);
  const operationId = `op_${input.id.replaceAll('-', '_')}`;
  const invariants: FixtureInvariant[] = [...suggestedTableInvariants];
  if (generatedBlockIds.length > 0) {
    invariants.push({
      id: 'generated-block-ids-are-server-owned',
      description:
        'The request contains no generated IDs; seeded execution returns the listed unique table descendants.',
    });
  }

  const changeId = factories.changeId();
  const change: FixtureChangeMetadata = {
    id: changeId,
    groupId: `${factories.changeSetId()}:${operationId}`,
    status: 'pending',
    operation: 'structure',
    authorId: 'agent-fixture',
    authorType: 'agent',
    createdAt: '2026-01-15T12:00:00.000Z',
    summary: '1 operation edit batch',
    baseBlockId: tableId,
  };
  const tableTarget = findBlockById(before, tableId);
  const tableNode = tableTarget.node;
  const afterTable = findBlockById(after, tableId).node;
  let proposedRows: CanonicalNode[];
  if (input.operation.kind === 'insert_table_row') {
    const index = input.operation.rowIndex + (input.operation.position === 'after' ? 1 : 0);
    proposedRows = Array.from({ length: afterTable.childCount }, (_, rowIndex) => {
      const row = afterTable.child(rowIndex);
      return rowIndex === index ? trackedTableNode(row, changeId, 'insert') : row;
    });
  } else if (input.operation.kind === 'delete_table_row') {
    const deleted = trackedTableNode(tableNode.child(input.operation.rowIndex), changeId, 'delete');
    proposedRows = Array.from({ length: afterTable.childCount }, (_, rowIndex) =>
      afterTable.child(rowIndex),
    );
    proposedRows.splice(input.operation.rowIndex, 0, deleted);
  } else if (input.operation.kind === 'insert_table_column') {
    const index = input.operation.columnIndex + (input.operation.position === 'after' ? 1 : 0);
    proposedRows = Array.from({ length: afterTable.childCount }, (_, rowIndex) => {
      const row = afterTable.child(rowIndex);
      const cells = Array.from({ length: row.childCount }, (_, columnIndex) => {
        const cell = row.child(columnIndex);
        return columnIndex === index ? trackedTableNode(cell, changeId, 'insert') : cell;
      });
      return row.type.create(row.attrs, cells, row.marks);
    });
  } else {
    const targetColumnIndex = 'columnIndex' in input.operation ? input.operation.columnIndex : 0;
    proposedRows = Array.from({ length: tableNode.childCount }, (_, rowIndex) => {
      const row = tableNode.child(rowIndex);
      const cells = Array.from({ length: row.childCount }, (_, columnIndex) => {
        const cell = row.child(columnIndex);
        return columnIndex === targetColumnIndex
          ? trackedTableNode(cell, changeId, 'delete')
          : cell;
      });
      return row.type.create(row.attrs, cells, row.marks);
    });
  }
  const proposed = canonicalizeDocument(
    replaceNodeAtPath(
      before,
      tableTarget.path,
      tableNode.type.create(tableNode.attrs, proposedRows, tableNode.marks),
    ),
  );
  const proposedState: FixtureState = {
    document: fixtureDocument(proposed),
    diffChanges: [change],
  };
  const resolved = (status: 'accepted' | 'rejected'): FixtureChangeMetadata => ({
    ...change,
    status,
    resolvedAt: '2026-01-15T12:05:00.000Z',
    resolvedBy: 'reviewer-fixture',
  });
  return {
    format: FIXTURE_FORMAT,
    formatVersion: FIXTURE_FORMAT_VERSION,
    id: input.id,
    title: input.title,
    description: input.description,
    seed: input.seed,
    schema: { id: 'editor-mcp/mvp', version: 1 },
    tags: [...input.tags, 'suggest', 'table', input.operation.kind],
    subject: {
      nodeType:
        input.operation.kind === 'insert_table_row' || input.operation.kind === 'delete_table_row'
          ? 'tableRow'
          : 'tableCell',
      tracking: 'table',
    },
    request: applyEditsRequestSchema.parse({
      documentId: `doc_${input.id.replaceAll('-', '_')}`,
      documentIncarnation: `inc_${input.id.replaceAll('-', '_')}`,
      schemaId: 'editor-mcp/mvp',
      schemaVersion: 1,
      idempotencyKey: `idem_${input.id.replaceAll('-', '_')}`,
      changeMode: 'suggest',
      operations: [operationPayload(operationId, tableId, digestBlock(table), input.operation)],
    }),
    resolution: { kind: 'accept_reject', changeIds: [changeId] },
    expected: {
      states: {
        before: fixtureState(beforeDocument),
        proposed: proposedState,
        accepted: { document: afterDocument, diffChanges: [resolved('accepted')] },
        rejected: { document: beforeDocument, diffChanges: [resolved('rejected')] },
      },
      conflicts: [],
      generatedBlockIds,
    },
    invariants,
  };
}

const baseTwoColumnTable =
  '<table><tbody>' +
  '<tr><th><p>Outcome</p></th><th><p>Result</p></th></tr>' +
  '<tr><td><p>Safety</p></td><td><p>Met</p></td></tr>' +
  '<tr><td><p>Efficacy</p></td><td><p>Pending</p></td></tr>' +
  '</tbody></table>';

const rowReorderAndContent = replacementFixture({
  id: 'table-row-reorder-with-content-change-direct',
  title: 'Table row reorder with a content change',
  description:
    'Replaces the whole table with freshly identified content, moving the follow-up row before baseline while changing its visit window.',
  seed: 420_101,
  tags: ['content-change', 'reorder', 'row'],
  subjectNodeType: 'table',
  targetNodeType: 'table',
  beforeHtml:
    '<table><tbody>' +
    '<tr><th><p>Visit</p></th><th><p>Window</p></th></tr>' +
    '<tr><td><p>Baseline</p></td><td><p>Day 0</p></td></tr>' +
    '<tr><td><p>Follow-up</p></td><td><p>Day 30</p></td></tr>' +
    '</tbody></table>',
  html:
    '<table><tbody>' +
    '<tr><th><p>Visit</p></th><th><p>Window</p></th></tr>' +
    '<tr><td><p>Follow-up</p></td><td><p>Day 28</p></td></tr>' +
    '<tr><td><p>Baseline</p></td><td><p>Day 0</p></td></tr>' +
    '</tbody></table>',
});

const columnShapedReplacement = replacementFixture({
  id: 'table-column-shaped-replacement-direct',
  title: 'Table column-shaped replacement',
  description:
    'Replaces the whole table with a fresh subtree after moving Status ahead of Dose and updating values down that column.',
  seed: 420_102,
  tags: ['column', 'content-change', 'reorder'],
  subjectNodeType: 'table',
  targetNodeType: 'table',
  beforeHtml:
    '<table><tbody>' +
    '<tr><th><p>Subject</p></th><th><p>Dose</p></th><th><p>Status</p></th></tr>' +
    '<tr><td><p>A01</p></td><td><p>5 mg</p></td><td><p>Open</p></td></tr>' +
    '<tr><td><p>A02</p></td><td><p>10 mg</p></td><td><p>Open</p></td></tr>' +
    '</tbody></table>',
  html:
    '<table><tbody>' +
    '<tr><th><p>Subject</p></th><th><p>Status</p></th><th><p>Dose</p></th></tr>' +
    '<tr><td><p>A01</p></td><td><p>Complete</p></td><td><p>5 mg</p></td></tr>' +
    '<tr><td><p>A02</p></td><td><p>Screening</p></td><td><p>10 mg</p></td></tr>' +
    '</tbody></table>',
});

const nestedCellParagraphEdit = replacementFixture({
  id: 'table-cell-paragraph-replacement-direct',
  title: 'Nested table-cell paragraph replacement',
  description:
    'Replaces only one paragraph inside a body cell, retiring that paragraph ID while preserving the table, row, and cell identities.',
  seed: 420_103,
  tags: ['cell', 'nested', 'paragraph'],
  subjectNodeType: 'paragraph',
  targetNodeType: 'paragraph',
  targetOccurrence: 3,
  beforeHtml: baseTwoColumnTable,
  html: '<p>Pending review</p>',
});

const headerBodyTransition = replacementFixture({
  id: 'table-header-body-transition-direct',
  title: 'Table body-to-header transition',
  description:
    'Replaces the whole table with a fresh subtree that promotes its first body row to semantic header cells.',
  seed: 420_104,
  tags: ['header', 'structure', 'transition'],
  subjectNodeType: 'table',
  targetNodeType: 'table',
  beforeHtml:
    '<table><tbody>' +
    '<tr><td><p>Metric</p></td><td><p>Value</p></td></tr>' +
    '<tr><td><p>Retention</p></td><td><p>92%</p></td></tr>' +
    '</tbody></table>',
  html:
    '<table><tbody>' +
    '<tr><th><p>Metric</p></th><th><p>Value</p></th></tr>' +
    '<tr><td><p>Retention</p></td><td><p>92%</p></td></tr>' +
    '</tbody></table>',
});

const spanningCellReplacement = replacementFixture({
  id: 'table-colspan-rowspan-replacement-direct',
  title: 'Table colspan and rowspan replacement',
  description:
    'Replaces a simple table with a fresh, logically rectangular table containing both colspan and rowspan cells.',
  seed: 420_105,
  tags: ['colspan', 'merged-cell', 'rowspan'],
  subjectNodeType: 'table',
  targetNodeType: 'table',
  beforeHtml:
    '<table><tbody>' +
    '<tr><th><p>Group</p></th><th><p>Week 1</p></th><th><p>Week 4</p></th></tr>' +
    '<tr><td><p>A</p></td><td><p>10</p></td><td><p>12</p></td></tr>' +
    '<tr><td><p>B</p></td><td><p>8</p></td><td><p>11</p></td></tr>' +
    '</tbody></table>',
  html:
    '<table><tbody>' +
    '<tr><th rowspan="2"><p>Group</p></th><th colspan="2"><p>Outcome</p></th></tr>' +
    '<tr><th><p>Week 1</p></th><th><p>Week 4</p></th></tr>' +
    '<tr><td><p>A</p></td><td><p>10</p></td><td><p>12</p></td></tr>' +
    '</tbody></table>',
});

const nestedMarkedCellContent = replacementFixture({
  id: 'table-nested-marked-cell-content-direct',
  title: 'Nested and marked table-cell content',
  description:
    'Replaces the whole table with fresh IDs while preserving multiple paragraphs, a blockquote, links, emphasis, bold, code, and a hard break inside cells.',
  seed: 420_106,
  tags: ['cell', 'marks', 'nested-content'],
  subjectNodeType: 'table',
  targetNodeType: 'table',
  beforeHtml: baseTwoColumnTable,
  html:
    '<table><tbody>' +
    '<tr><th><p>Outcome</p></th><th><p>Evidence</p></th></tr>' +
    '<tr><td><p><strong>Primary</strong> outcome</p>' +
    '<blockquote><p>Measured at <em>week 4</em>.</p></blockquote></td>' +
    '<td><p><a href="/protocol" title="Protocol">Protocol</a> <code>v2</code><br>approved</p>' +
    '<p>Source verified.</p></td></tr>' +
    '</tbody></table>',
});

const insertLastRowBoundary = directTableOperationFixture({
  id: 'table-insert-row-after-last-boundary-direct',
  title: 'Insert a row after the last row',
  description:
    'Inserts a fresh empty body row after the last row, exercising the trailing table boundary.',
  seed: 420_107,
  tags: ['boundary', 'last-row'],
  beforeHtml: baseTwoColumnTable,
  operation: {
    kind: 'insert_table_row',
    rowIndex: 2,
    position: 'after',
  },
});

const deleteFirstRowBoundary = directTableOperationFixture({
  id: 'table-delete-first-row-boundary-direct',
  title: 'Delete the first table row',
  description:
    'Suggests deleting the first row while preserving both remaining body-row identities and content.',
  seed: 420_108,
  tags: ['boundary', 'first-row'],
  beforeHtml: baseTwoColumnTable,
  operation: {
    kind: 'delete_table_row',
    rowIndex: 0,
  },
});

const insertLastColumnBoundary = directTableOperationFixture({
  id: 'table-insert-column-after-last-boundary-direct',
  title: 'Insert a column after the last column',
  description:
    'Inserts one fresh empty cell per row after the last column, preserving header and body cell types.',
  seed: 420_109,
  tags: ['boundary', 'last-column'],
  beforeHtml: baseTwoColumnTable,
  operation: {
    kind: 'insert_table_column',
    columnIndex: 1,
    position: 'after',
  },
});

const deleteFirstColumnBoundary = directTableOperationFixture({
  id: 'table-delete-first-column-boundary-direct',
  title: 'Delete the first table column',
  description:
    'Suggests deleting the first cell from every row while preserving the remaining column identities and content.',
  seed: 420_110,
  tags: ['boundary', 'first-column'],
  beforeHtml: baseTwoColumnTable,
  operation: {
    kind: 'delete_table_column',
    columnIndex: 0,
  },
});

export const tableFixtures: readonly FixtureDefinition[] = Object.freeze([
  rowReorderAndContent,
  columnShapedReplacement,
  nestedCellParagraphEdit,
  headerBodyTransition,
  spanningCellReplacement,
  nestedMarkedCellContent,
  insertLastRowBoundary,
  deleteFirstRowBoundary,
  insertLastColumnBoundary,
  deleteFirstColumnBoundary,
]);
