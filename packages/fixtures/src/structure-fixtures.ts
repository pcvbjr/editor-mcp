import { createDirectReplacementFixture } from './direct-fixture-builder.js';
import type { FixtureDefinition, FixtureDocument, FixtureNode } from './types.js';

const trackingAttrs = (blockId: string) => ({
  blockId,
  diffChangeId: null,
  diffChangeKind: null,
});

const text = (value: string): FixtureNode => ({
  type: 'text',
  text: value,
});

const paragraph = (blockId: string, value: string | readonly FixtureNode[]): FixtureNode => ({
  type: 'paragraph',
  attrs: trackingAttrs(blockId),
  ...(typeof value === 'string'
    ? value.length === 0
      ? {}
      : { content: [text(value)] }
    : value.length === 0
      ? {}
      : { content: value }),
});

const heading = (blockId: string, level: number, value: string): FixtureNode => ({
  type: 'heading',
  attrs: {
    ...trackingAttrs(blockId),
    level,
  },
  content: [text(value)],
});

const listItem = (
  blockId: string,
  lead: FixtureNode,
  nested: readonly FixtureNode[] = [],
): FixtureNode => ({
  type: 'listItem',
  attrs: trackingAttrs(blockId),
  content: [lead, ...nested],
});

const orderedList = (
  blockId: string,
  start: number,
  items: readonly FixtureNode[],
): FixtureNode => ({
  type: 'orderedList',
  attrs: {
    ...trackingAttrs(blockId),
    start,
  },
  content: items,
});

const bulletList = (blockId: string, items: readonly FixtureNode[]): FixtureNode => ({
  type: 'bulletList',
  attrs: trackingAttrs(blockId),
  content: items,
});

const blockquote = (blockId: string, children: readonly FixtureNode[]): FixtureNode => ({
  type: 'blockquote',
  attrs: trackingAttrs(blockId),
  content: children,
});

const codeBlock = (
  blockId: string,
  value: string,
  language: string | null = null,
): FixtureNode => ({
  type: 'codeBlock',
  attrs: {
    ...trackingAttrs(blockId),
    language,
  },
  ...(value.length === 0 ? {} : { content: [text(value)] }),
});

const doc = (...content: readonly FixtureNode[]): FixtureDocument => ({
  type: 'doc',
  content,
});

const orderedInsertion = createDirectReplacementFixture({
  id: 'structure-ordered-list-insert-middle-direct',
  title: 'Insert an ordered-list item',
  description:
    'Replaces the first top-level block with a newly identified ordered list containing one inserted middle item.',
  seed: 430_001,
  tags: ['structure', 'list', 'ordered-list', 'insertion', 'first-node', 'boundary'],
  subjectNodeType: 'orderedList',
  targetBlockId: '42000001-0001-4000-8000-000000000001',
  before: doc(
    orderedList('42000001-0001-4000-8000-000000000001', 1, [
      listItem(
        '42000001-0001-4000-8000-000000000002',
        paragraph('42000001-0001-4000-8000-000000000003', 'Prepare materials'),
      ),
      listItem(
        '42000001-0001-4000-8000-000000000004',
        paragraph('42000001-0001-4000-8000-000000000005', 'Publish results'),
      ),
    ]),
    paragraph('42000001-0001-4000-8000-000000000006', 'Closing note'),
  ),
  html: '<ol><li><p>Prepare materials</p></li><li><p>Run the analysis</p></li><li><p>Publish results</p></li></ol>',
});

const orderedDeletion = createDirectReplacementFixture({
  id: 'structure-ordered-list-delete-item-direct',
  title: 'Delete an ordered-list item',
  description:
    'Replaces the last top-level block with a newly identified ordered list that omits its former middle item.',
  seed: 430_002,
  tags: ['structure', 'list', 'ordered-list', 'deletion', 'last-node', 'boundary'],
  subjectNodeType: 'orderedList',
  targetBlockId: '42000002-0001-4000-8000-000000000002',
  before: doc(
    paragraph('42000002-0001-4000-8000-000000000001', 'Protocol steps'),
    orderedList('42000002-0001-4000-8000-000000000002', 1, [
      listItem(
        '42000002-0001-4000-8000-000000000003',
        paragraph('42000002-0001-4000-8000-000000000004', 'Screen participants'),
      ),
      listItem(
        '42000002-0001-4000-8000-000000000005',
        paragraph('42000002-0001-4000-8000-000000000006', 'Archive the draft'),
      ),
      listItem(
        '42000002-0001-4000-8000-000000000007',
        paragraph('42000002-0001-4000-8000-000000000008', 'Analyze outcomes'),
      ),
    ]),
  ),
  html: '<ol><li><p>Screen participants</p></li><li><p>Analyze outcomes</p></li></ol>',
});

const orderedReordering = createDirectReplacementFixture({
  id: 'structure-ordered-list-reorder-direct',
  title: 'Reorder an ordered list',
  description:
    'Replaces an ordered list with a newly identified list whose three items appear in a different order.',
  seed: 430_003,
  tags: ['structure', 'list', 'ordered-list', 'reordering'],
  subjectNodeType: 'orderedList',
  targetBlockId: '42000003-0001-4000-8000-000000000001',
  before: doc(
    orderedList('42000003-0001-4000-8000-000000000001', 1, [
      listItem(
        '42000003-0001-4000-8000-000000000002',
        paragraph('42000003-0001-4000-8000-000000000003', 'Collect'),
      ),
      listItem(
        '42000003-0001-4000-8000-000000000004',
        paragraph('42000003-0001-4000-8000-000000000005', 'Validate'),
      ),
      listItem(
        '42000003-0001-4000-8000-000000000006',
        paragraph('42000003-0001-4000-8000-000000000007', 'Report'),
      ),
    ]),
  ),
  html: '<ol><li><p>Report</p></li><li><p>Collect</p></li><li><p>Validate</p></li></ol>',
});

const orderedStartValue = createDirectReplacementFixture({
  id: 'structure-ordered-list-start-value-direct',
  title: 'Change an ordered-list start value',
  description:
    'Replaces an ordered list with a newly identified equivalent list whose numbering starts at four.',
  seed: 430_004,
  tags: ['structure', 'list', 'ordered-list', 'start-value', 'renumbering'],
  subjectNodeType: 'orderedList',
  targetBlockId: '42000004-0001-4000-8000-000000000001',
  before: doc(
    orderedList('42000004-0001-4000-8000-000000000001', 1, [
      listItem(
        '42000004-0001-4000-8000-000000000002',
        paragraph('42000004-0001-4000-8000-000000000003', 'Fourth phase'),
      ),
      listItem(
        '42000004-0001-4000-8000-000000000004',
        paragraph('42000004-0001-4000-8000-000000000005', 'Fifth phase'),
      ),
    ]),
  ),
  html: '<ol start="4"><li><p>Fourth phase</p></li><li><p>Fifth phase</p></li></ol>',
});

const unorderedInsertionWithHardBreak = createDirectReplacementFixture({
  id: 'structure-unordered-list-insert-hard-break-direct',
  title: 'Insert an unordered-list item containing a hard break',
  description:
    'Replaces an unordered list with a newly identified list whose inserted item contains an explicit hard line break.',
  seed: 430_005,
  tags: ['structure', 'list', 'unordered-list', 'insertion', 'hard-break'],
  subjectNodeType: 'bulletList',
  targetBlockId: '42000005-0001-4000-8000-000000000001',
  before: doc(
    bulletList('42000005-0001-4000-8000-000000000001', [
      listItem(
        '42000005-0001-4000-8000-000000000002',
        paragraph('42000005-0001-4000-8000-000000000003', 'Baseline visit'),
      ),
      listItem(
        '42000005-0001-4000-8000-000000000004',
        paragraph('42000005-0001-4000-8000-000000000005', 'Follow-up visit'),
      ),
    ]),
  ),
  html: '<ul><li><p>Baseline visit</p></li><li><p>Remote check-in<br>within 48 hours</p></li><li><p>Follow-up visit</p></li></ul>',
});

const unorderedReordering = createDirectReplacementFixture({
  id: 'structure-unordered-list-reorder-direct',
  title: 'Reorder an unordered list',
  description:
    'Replaces an unordered list with a newly identified list whose items move across repeated positions.',
  seed: 430_006,
  tags: ['structure', 'list', 'unordered-list', 'reordering'],
  subjectNodeType: 'bulletList',
  targetBlockId: '42000006-0001-4000-8000-000000000001',
  before: doc(
    bulletList('42000006-0001-4000-8000-000000000001', [
      listItem(
        '42000006-0001-4000-8000-000000000002',
        paragraph('42000006-0001-4000-8000-000000000003', 'Alpha'),
      ),
      listItem(
        '42000006-0001-4000-8000-000000000004',
        paragraph('42000006-0001-4000-8000-000000000005', 'Beta'),
      ),
      listItem(
        '42000006-0001-4000-8000-000000000006',
        paragraph('42000006-0001-4000-8000-000000000007', 'Gamma'),
      ),
    ]),
  ),
  html: '<ul><li><p>Gamma</p></li><li><p>Alpha</p></li><li><p>Beta</p></li></ul>',
});

const unorderedDeletion = createDirectReplacementFixture({
  id: 'structure-unordered-list-delete-item-direct',
  title: 'Delete an unordered-list item',
  description:
    'Replaces an unordered list with a newly identified list that removes its repeated middle item.',
  seed: 430_015,
  tags: ['structure', 'list', 'unordered-list', 'deletion'],
  subjectNodeType: 'bulletList',
  targetBlockId: '42000015-0001-4000-8000-000000000001',
  before: doc(
    bulletList('42000015-0001-4000-8000-000000000001', [
      listItem(
        '42000015-0001-4000-8000-000000000002',
        paragraph('42000015-0001-4000-8000-000000000003', 'Keep this item'),
      ),
      listItem(
        '42000015-0001-4000-8000-000000000004',
        paragraph('42000015-0001-4000-8000-000000000005', 'Remove this duplicate'),
      ),
      listItem(
        '42000015-0001-4000-8000-000000000006',
        paragraph('42000015-0001-4000-8000-000000000007', 'Keep the final item'),
      ),
    ]),
  ),
  html: '<ul><li><p>Keep this item</p></li><li><p>Keep the final item</p></li></ul>',
});

const deeplyNestedMixedLists = createDirectReplacementFixture({
  id: 'structure-deeply-nested-mixed-lists-direct',
  title: 'Edit a deeply nested mixed-list subtree',
  description:
    'Replaces a four-level mixed list and changes the deepest item, proving nested content remains valid in canonical JSON.',
  seed: 430_016,
  tags: ['structure', 'list', 'nested', 'deep', 'mixed-list'],
  subjectNodeType: 'bulletList',
  targetBlockId: '42000016-0001-4000-8000-000000000001',
  before: doc(
    bulletList('42000016-0001-4000-8000-000000000001', [
      listItem(
        '42000016-0001-4000-8000-000000000002',
        paragraph('42000016-0001-4000-8000-000000000003', 'Level one'),
        [
          orderedList('42000016-0001-4000-8000-000000000004', 1, [
            listItem(
              '42000016-0001-4000-8000-000000000005',
              paragraph('42000016-0001-4000-8000-000000000006', 'Level two'),
              [
                bulletList('42000016-0001-4000-8000-000000000007', [
                  listItem(
                    '42000016-0001-4000-8000-000000000008',
                    paragraph('42000016-0001-4000-8000-000000000009', 'Level three'),
                    [
                      orderedList('42000016-0001-4000-8000-000000000010', 1, [
                        listItem(
                          '42000016-0001-4000-8000-000000000011',
                          paragraph('42000016-0001-4000-8000-000000000012', 'Deep original'),
                        ),
                      ]),
                    ],
                  ),
                ]),
              ],
            ),
          ]),
        ],
      ),
    ]),
  ),
  html: '<ul><li><p>Level one</p><ol><li><p>Level two</p><ul><li><p>Level three</p><ol><li><p>Deep revised</p></li></ol></li></ul></li></ol></li></ul>',
});

const orderedToUnordered = createDirectReplacementFixture({
  id: 'structure-ordered-to-unordered-list-direct',
  title: 'Convert an ordered list to an unordered list',
  description:
    'Replaces an ordered list with a newly identified unordered list while retaining its visible item text.',
  seed: 430_007,
  tags: ['structure', 'list', 'ordered-list', 'unordered-list', 'type-change'],
  subjectNodeType: 'orderedList',
  targetBlockId: '42000007-0001-4000-8000-000000000001',
  before: doc(
    orderedList('42000007-0001-4000-8000-000000000001', 1, [
      listItem(
        '42000007-0001-4000-8000-000000000002',
        paragraph('42000007-0001-4000-8000-000000000003', 'Consent form'),
      ),
      listItem(
        '42000007-0001-4000-8000-000000000004',
        paragraph('42000007-0001-4000-8000-000000000005', 'Visit schedule'),
      ),
    ]),
  ),
  html: '<ul><li><p>Consent form</p></li><li><p>Visit schedule</p></li></ul>',
});

const unorderedToOrdered = createDirectReplacementFixture({
  id: 'structure-unordered-to-ordered-list-direct',
  title: 'Convert an unordered list to an ordered list',
  description:
    'Replaces an unordered list with a newly identified ordered list beginning at step three.',
  seed: 430_008,
  tags: ['structure', 'list', 'ordered-list', 'unordered-list', 'type-change', 'start-value'],
  subjectNodeType: 'bulletList',
  targetBlockId: '42000008-0001-4000-8000-000000000001',
  before: doc(
    bulletList('42000008-0001-4000-8000-000000000001', [
      listItem(
        '42000008-0001-4000-8000-000000000002',
        paragraph('42000008-0001-4000-8000-000000000003', 'Confirm eligibility'),
      ),
      listItem(
        '42000008-0001-4000-8000-000000000004',
        paragraph('42000008-0001-4000-8000-000000000005', 'Assign cohort'),
      ),
    ]),
  ),
  html: '<ol start="3"><li><p>Confirm eligibility</p></li><li><p>Assign cohort</p></li></ol>',
});

const nestedMixedListReparenting = createDirectReplacementFixture({
  id: 'structure-nested-mixed-list-reparent-direct',
  title: 'Reparent a nested mixed-list subtree',
  description:
    'Replaces one list subtree so its nested ordered steps move from the first parent item to the second and change order.',
  seed: 430_009,
  tags: ['structure', 'list', 'nested', 'mixed-list', 'indentation', 'reparenting', 'subtree-move'],
  subjectNodeType: 'bulletList',
  targetBlockId: '42000009-0001-4000-8000-000000000001',
  before: doc(
    bulletList('42000009-0001-4000-8000-000000000001', [
      listItem(
        '42000009-0001-4000-8000-000000000002',
        paragraph('42000009-0001-4000-8000-000000000003', 'Preparation'),
        [
          orderedList('42000009-0001-4000-8000-000000000004', 1, [
            listItem(
              '42000009-0001-4000-8000-000000000005',
              paragraph('42000009-0001-4000-8000-000000000006', 'Verify inventory'),
            ),
            listItem(
              '42000009-0001-4000-8000-000000000007',
              paragraph('42000009-0001-4000-8000-000000000008', 'Label samples'),
            ),
          ]),
        ],
      ),
      listItem(
        '42000009-0001-4000-8000-000000000009',
        paragraph('42000009-0001-4000-8000-000000000010', 'Collection'),
      ),
    ]),
  ),
  html: '<ul><li><p>Preparation</p></li><li><p>Collection</p><ol><li><p>Label samples</p></li><li><p>Verify inventory</p></li></ol></li></ul>',
});

const headingLevelAndText = createDirectReplacementFixture({
  id: 'structure-heading-level-and-text-direct',
  title: 'Change heading level and text',
  description:
    'Replaces a level-two heading with a newly identified level-four heading containing revised text.',
  seed: 430_010,
  tags: ['structure', 'heading', 'level-change', 'text-edit', 'type-compatible'],
  subjectNodeType: 'heading',
  targetBlockId: '42000010-0001-4000-8000-000000000002',
  before: doc(
    paragraph('42000010-0001-4000-8000-000000000001', 'Context before'),
    heading('42000010-0001-4000-8000-000000000002', 2, 'Safety'),
    paragraph('42000010-0001-4000-8000-000000000003', 'Context after'),
  ),
  html: '<h4>Safety monitoring and escalation</h4>',
});

const headingToEmptyParagraph = createDirectReplacementFixture({
  id: 'structure-heading-to-empty-paragraph-direct',
  title: 'Convert a heading to an empty paragraph',
  description:
    'Replaces the last top-level heading with a newly identified empty paragraph, exercising conversion and empty-block boundaries.',
  seed: 430_011,
  tags: [
    'structure',
    'heading',
    'paragraph',
    'type-change',
    'empty-block',
    'last-node',
    'boundary',
  ],
  subjectNodeType: 'heading',
  targetBlockId: '42000011-0001-4000-8000-000000000002',
  before: doc(
    paragraph('42000011-0001-4000-8000-000000000001', 'Keep this introduction'),
    heading('42000011-0001-4000-8000-000000000002', 3, 'Remove this label'),
  ),
  html: '<p></p>',
});

const paragraphToHeading = createDirectReplacementFixture({
  id: 'structure-paragraph-to-heading-direct',
  title: 'Convert a paragraph to a heading',
  description:
    'Replaces a paragraph with a newly identified heading while preserving the surrounding top-level blocks.',
  seed: 430_012,
  tags: ['structure', 'heading', 'paragraph', 'type-change'],
  subjectNodeType: 'paragraph',
  targetBlockId: '42000012-0001-4000-8000-000000000002',
  before: doc(
    paragraph('42000012-0001-4000-8000-000000000001', 'Lead-in'),
    paragraph('42000012-0001-4000-8000-000000000002', 'Eligibility criteria'),
    paragraph('42000012-0001-4000-8000-000000000003', 'Supporting detail'),
  ),
  html: '<h2>Eligibility criteria</h2>',
});

const blockquoteToCodeBlock = createDirectReplacementFixture({
  id: 'structure-blockquote-to-code-block-direct',
  title: 'Convert a blockquote to a code block',
  description:
    'Replaces a nested blockquote subtree with a newly identified language-tagged code block.',
  seed: 430_013,
  tags: ['structure', 'blockquote', 'code-block', 'type-change'],
  subjectNodeType: 'blockquote',
  targetBlockId: '42000013-0001-4000-8000-000000000001',
  before: doc(
    blockquote('42000013-0001-4000-8000-000000000001', [
      paragraph('42000013-0001-4000-8000-000000000002', 'const answer = 42;'),
    ]),
    paragraph('42000013-0001-4000-8000-000000000003', 'Explanation'),
  ),
  html: '<pre data-language="typescript"><code>const answer = 42;</code></pre>',
});

const codeBlockToHorizontalRule = createDirectReplacementFixture({
  id: 'structure-code-block-to-horizontal-rule-direct',
  title: 'Convert a code block to a horizontal rule',
  description:
    'Replaces the first top-level code block with a newly identified horizontal rule while preserving trailing content.',
  seed: 430_014,
  tags: ['structure', 'code-block', 'horizontal-rule', 'type-change', 'first-node', 'boundary'],
  subjectNodeType: 'codeBlock',
  targetBlockId: '42000014-0001-4000-8000-000000000001',
  before: doc(
    codeBlock('42000014-0001-4000-8000-000000000001', 'obsolete_separator()', 'text'),
    paragraph('42000014-0001-4000-8000-000000000002', 'Next section'),
  ),
  html: '<hr>',
});

export const structuralFixtures = [
  orderedInsertion,
  orderedDeletion,
  orderedReordering,
  orderedStartValue,
  unorderedInsertionWithHardBreak,
  unorderedReordering,
  unorderedDeletion,
  deeplyNestedMixedLists,
  orderedToUnordered,
  unorderedToOrdered,
  nestedMixedListReparenting,
  headingLevelAndText,
  headingToEmptyParagraph,
  paragraphToHeading,
  blockquoteToCodeBlock,
  codeBlockToHorizontalRule,
] as const satisfies readonly FixtureDefinition[];
