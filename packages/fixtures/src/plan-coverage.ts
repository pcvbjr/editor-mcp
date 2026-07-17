import { fixtureCatalogById } from './catalog.js';

export type PlanCoverageStatus = 'fixture' | 'contract-test';

export interface PlanCoverageEntry {
  readonly id: string;
  readonly case: string;
  readonly status: PlanCoverageStatus;
  readonly fixtureIds: readonly string[];
  readonly note: string;
}

export const planCoverage: readonly PlanCoverageEntry[] = Object.freeze([
  {
    id: 'ordered-insert',
    case: 'Ordered-list insertion',
    status: 'fixture',
    fixtureIds: ['structure-ordered-list-insert-middle-direct'],
    note: 'Whole-list replace with exact canonical JSON.',
  },
  {
    id: 'ordered-delete',
    case: 'Ordered-list deletion',
    status: 'fixture',
    fixtureIds: ['structure-ordered-list-delete-item-direct'],
    note: 'Whole-list replace with exact canonical JSON.',
  },
  {
    id: 'ordered-reorder',
    case: 'Ordered-list reordering',
    status: 'fixture',
    fixtureIds: ['structure-ordered-list-reorder-direct'],
    note: 'Whole-list replace; no granular move verb in MVP.',
  },
  {
    id: 'ordered-numbering',
    case: 'Ordered-list renumbering/start value',
    status: 'fixture',
    fixtureIds: [
      'structure-ordered-list-start-value-direct',
      'structure-unordered-to-ordered-list-direct',
    ],
    note: 'Exact start attributes are asserted.',
  },
  {
    id: 'unordered-insert-delete-reorder',
    case: 'Unordered-list insertion, deletion, and reordering',
    status: 'fixture',
    fixtureIds: [
      'structure-unordered-list-insert-hard-break-direct',
      'structure-unordered-list-delete-item-direct',
      'structure-unordered-list-reorder-direct',
    ],
    note: 'Exact list item order is asserted.',
  },
  {
    id: 'list-transitions',
    case: 'Ordered/unordered list transitions',
    status: 'fixture',
    fixtureIds: [
      'structure-ordered-to-unordered-list-direct',
      'structure-unordered-to-ordered-list-direct',
    ],
    note: 'Type and generated identities are asserted.',
  },
  {
    id: 'nested-lists',
    case: 'Nested mixed lists, indentation, reparenting, and deep nesting',
    status: 'fixture',
    fixtureIds: [
      'structure-nested-mixed-list-reparent-direct',
      'structure-deeply-nested-mixed-lists-direct',
    ],
    note: 'Depth-4 canonical trees are included.',
  },
  {
    id: 'tables-boundaries',
    case: 'Table row/column insertion and deletion boundaries',
    status: 'fixture',
    fixtureIds: [
      'table-insert-row-after-last-boundary-direct',
      'table-delete-first-row-boundary-direct',
      'table-insert-column-after-last-boundary-direct',
      'table-delete-first-column-boundary-direct',
    ],
    note: 'Dedicated table operations with exact table JSON.',
  },
  {
    id: 'tables-structure',
    case: 'Table row reorder, column shape changes, cell edits, headers, and spans',
    status: 'fixture',
    fixtureIds: [
      'table-row-reorder-with-content-change-direct',
      'table-column-shaped-replacement-direct',
      'table-cell-paragraph-replacement-direct',
      'table-header-body-transition-direct',
      'table-colspan-rowspan-replacement-direct',
    ],
    note: 'MVP expresses unsupported granular structure as replace_block.',
  },
  {
    id: 'tables-nested',
    case: 'Nested and marked table-cell content',
    status: 'fixture',
    fixtureIds: ['table-nested-marked-cell-content-direct'],
    note: 'Marks, links, hard breaks, and multiple paragraphs are canonicalized.',
  },
  {
    id: 'headings',
    case: 'Heading level/text changes and paragraph conversions',
    status: 'fixture',
    fixtureIds: [
      'structure-heading-level-and-text-direct',
      'structure-heading-to-empty-paragraph-direct',
      'structure-paragraph-to-heading-direct',
    ],
    note: 'Exact heading attrs and replacement IDs are asserted.',
  },
  {
    id: 'block-types',
    case: 'Blockquote, code block, divider, and type conversions',
    status: 'fixture',
    fixtureIds: [
      'structure-blockquote-to-code-block-direct',
      'structure-code-block-to-horizontal-rule-direct',
    ],
    note: 'Language and node type are canonical JSON.',
  },
  {
    id: 'text-unicode',
    case: 'Emoji, combining text, non-Latin, bidi, line breaks, and special whitespace',
    status: 'fixture',
    fixtureIds: [
      'insert-text-direct-emoji-end-boundary',
      'insert-text-suggest-multiscript-start-boundary',
      'delete-text-direct-bidirectional-range',
      'delete-text-suggest-special-whitespace',
      'replace-text-direct-adjacent-batch',
    ],
    note: 'UTF-16 ranges and exact text are asserted.',
  },
  {
    id: 'formatting',
    case: 'Bold, italic, links, code, overlapping and adjacent marks',
    status: 'fixture',
    fixtureIds: [
      'format-text-suggest-add-bold',
      'format-text-direct-overlapping-marks',
      'format-text-direct-remove-adjacent-marks',
    ],
    note: 'Exact mark arrays and formatting snapshots are asserted; overlapping pending ranges are an atomic conflict contract.',
  },
  {
    id: 'block-replacement',
    case: 'Suggested whole-block replacement identity lifecycle',
    status: 'fixture',
    fixtureIds: ['replace-block-direct-type-change', 'replace-block-suggest-blocks'],
    note: 'Old IDs retire; replacement subtree receives fresh IDs.',
  },
  {
    id: 'block-insert-before-after',
    case: 'Insert-before and insert-after block verbs',
    status: 'fixture',
    fixtureIds: ['insert-block-before-direct', 'insert-block-after-suggest'],
    note: 'Anchor digests, generated IDs, and exact accept/reject JSON are asserted.',
  },
  {
    id: 'empty-boundaries',
    case: 'Empty blocks/cells and first/last boundaries',
    status: 'fixture',
    fixtureIds: [
      'structure-heading-to-empty-paragraph-direct',
      'table-insert-row-after-last-boundary-direct',
      'table-delete-first-row-boundary-direct',
    ],
    note: 'Empty documents are rejected by the MVP schema.',
  },
  {
    id: 'ambiguous-targets',
    case: 'Duplicate text, repeated headings, identical list items, similar rows',
    status: 'contract-test',
    fixtureIds: [],
    note: 'Stable block ID plus digest targeting is asserted by the contract test.',
  },
  {
    id: 'unsupported-styles',
    case: 'Numbering-style and bullet-style changes',
    status: 'contract-test',
    fixtureIds: [],
    note: 'Rejected because the MVP schema intentionally excludes list-style attrs.',
  },
  {
    id: 'unsupported-structure',
    case: 'Move, split, join, merge, and split-cell verbs',
    status: 'contract-test',
    fixtureIds: [],
    note: 'Rejected/represented as replace_block; no granular MVP verbs exist.',
  },
  {
    id: 'unsupported-blocks',
    case: 'Empty document and callout block',
    status: 'contract-test',
    fixtureIds: [],
    note: 'Rejected by the certified MVP schema.',
  },
  {
    id: 'unsupported-attrs',
    case: 'Anchors, classes, and alignment attrs',
    status: 'contract-test',
    fixtureIds: [],
    note: 'Strict HTML allowlist rejects unknown attrs.',
  },
  {
    id: 'robustness',
    case: 'Malformed input, duplicate IDs, deep/large documents',
    status: 'contract-test',
    fixtureIds: [],
    note: 'Adapter defensive tests cover malformed and duplicate identity inputs.',
  },
  {
    id: 'correctness',
    case: 'Determinism, round-trip canonical JSON, idempotence, and untouched content',
    status: 'contract-test',
    fixtureIds: [],
    note: 'Fixture canonical and production integration tests assert these properties.',
  },
  {
    id: 'fuzz',
    case: 'Seeded property-style reconstruction and invariant checks',
    status: 'contract-test',
    fixtureIds: [],
    note: 'Seeded fixture catalog is the deterministic baseline for property expansion.',
  },
]);

export function validatePlanCoverage(
  coverage: readonly PlanCoverageEntry[] = planCoverage,
  catalog: Readonly<Record<string, unknown>> = fixtureCatalogById,
): void {
  const fixtureIds = new Set(Object.keys(catalog));
  for (const entry of coverage) {
    for (const fixtureId of entry.fixtureIds) {
      if (!fixtureIds.has(fixtureId)) {
        throw new Error(`Plan coverage ${entry.id} references missing fixture ${fixtureId}`);
      }
    }
  }
}
