import type { Attrs, DOMOutputSpec, MarkSpec, NodeSpec, TagParseRule } from '@tiptap/pm/model';
import { Schema } from '@tiptap/pm/model';

import { readAttr } from './attrs.js';
import {
  MVP_SCHEMA_ID,
  MVP_SCHEMA_VERSION,
  type BlockDiffKind,
  type InlineDiffKind,
  type MvpAdapter,
  type MvpSchemaCapability,
} from './types.js';

export const ADDRESSABLE_NODE_TYPES = Object.freeze([
  'paragraph',
  'heading',
  'blockquote',
  'bulletList',
  'orderedList',
  'listItem',
  'codeBlock',
  'horizontalRule',
  'table',
  'tableRow',
  'tableHeader',
  'tableCell',
] as const);

export type AddressableNodeType = (typeof ADDRESSABLE_NODE_TYPES)[number];

export const MVP_NODE_TYPES = Object.freeze([
  'doc',
  'text',
  'paragraph',
  'heading',
  'blockquote',
  'bulletList',
  'orderedList',
  'listItem',
  'codeBlock',
  'horizontalRule',
  'hardBreak',
  'table',
  'tableRow',
  'tableHeader',
  'tableCell',
] as const);

export const MVP_MARK_TYPES = Object.freeze([
  'bold',
  'italic',
  'strike',
  'code',
  'link',
  'diffChange',
] as const);

const blockDiffKinds = new Set<BlockDiffKind>(['delete', 'insert', 'modify']);
const inlineDiffKinds = new Set<InlineDiffKind>(['delete', 'format', 'insert']);

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

function isNullableBlockDiffKind(value: unknown): boolean {
  return (
    value === null || (typeof value === 'string' && blockDiffKinds.has(value as BlockDiffKind))
  );
}

const addressableAttrs = {
  blockId: { default: null, validate: isNullableString },
  diffChangeId: { default: null, validate: isNullableString },
  diffChangeKind: { default: null, validate: isNullableBlockDiffKind },
} as const;

function trackingDomAttrs(attrs: Attrs): Record<string, string> {
  const result: Record<string, string> = {};
  const blockId = readAttr(attrs, 'blockId');
  const changeId = readAttr(attrs, 'diffChangeId');
  const changeKind = readAttr(attrs, 'diffChangeKind');
  if (typeof blockId === 'string') {
    result['data-block-id'] = blockId;
  }
  if (typeof changeId === 'string') {
    result['data-diff-change-id'] = changeId;
  }
  if (typeof changeKind === 'string') {
    result['data-diff-change-kind'] = changeKind;
  }
  return result;
}

function trackingAttrsFromDom(element: HTMLElement): Record<string, string | null> {
  return {
    blockId: element.getAttribute('data-block-id'),
    diffChangeId: element.getAttribute('data-diff-change-id'),
    diffChangeKind: element.getAttribute('data-diff-change-kind'),
  };
}

function trackedBlockSpec(
  tag: string,
  content: string | undefined,
  extra: Partial<NodeSpec> = {},
): NodeSpec {
  const parseRule: TagParseRule = {
    tag,
    getAttrs: (node) => trackingAttrsFromDom(node),
  };
  return {
    group: 'block',
    attrs: addressableAttrs,
    ...(content === undefined ? {} : { content }),
    parseDOM: [parseRule],
    toDOM: (node): DOMOutputSpec => [
      tag,
      trackingDomAttrs(node.attrs),
      ...(content === undefined ? [] : [0]),
    ],
    ...extra,
  };
}

function parsePositiveInteger(value: string | null, fallback: number): number {
  if (value === null || !/^[1-9]\d*$/u.test(value)) {
    return fallback;
  }
  return Number(value);
}

function parseColumnWidths(value: string | null): readonly number[] | null {
  if (value === null) {
    return null;
  }
  const widths = value.split(',').map((part) => Number(part));
  return widths.every((width) => Number.isSafeInteger(width) && width > 0) ? widths : null;
}

const nodes: Record<string, NodeSpec> = {
  doc: { content: 'block+' },
  text: { group: 'inline' },
  paragraph: trackedBlockSpec('p', 'inline*'),
  heading: {
    ...trackedBlockSpec('h1', 'inline*'),
    attrs: {
      ...addressableAttrs,
      level: {
        default: 1,
        validate: (value: unknown) =>
          typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 6,
      },
    },
    parseDOM: [1, 2, 3, 4, 5, 6].map((level): TagParseRule => ({
      tag: `h${String(level)}`,
      attrs: { level },
      getAttrs: (node) => ({
        ...trackingAttrsFromDom(node),
        level,
      }),
    })),
    toDOM: (node): DOMOutputSpec => [
      `h${String(readAttr(node.attrs, 'level'))}`,
      trackingDomAttrs(node.attrs),
      0,
    ],
  },
  blockquote: trackedBlockSpec('blockquote', 'block+'),
  bulletList: trackedBlockSpec('ul', 'listItem+'),
  orderedList: {
    ...trackedBlockSpec('ol', 'listItem+'),
    attrs: {
      ...addressableAttrs,
      start: {
        default: 1,
        validate: (value: unknown) =>
          typeof value === 'number' && Number.isSafeInteger(value) && value >= 1,
      },
    },
    parseDOM: [
      {
        tag: 'ol',
        getAttrs: (node) => {
          const element = node;
          return {
            ...trackingAttrsFromDom(element),
            start: parsePositiveInteger(element.getAttribute('start'), 1),
          };
        },
      },
    ],
    toDOM: (node): DOMOutputSpec => {
      const attrs = trackingDomAttrs(node.attrs);
      const start = readAttr(node.attrs, 'start');
      if (start !== 1) {
        attrs['start'] = String(start);
      }
      return ['ol', attrs, 0];
    },
  },
  listItem: trackedBlockSpec('li', 'paragraph block*'),
  codeBlock: {
    ...trackedBlockSpec('pre', 'text*', {
      marks: '',
      code: true,
      defining: true,
    }),
    attrs: {
      ...addressableAttrs,
      language: {
        default: null,
        validate: isNullableString,
      },
    },
    parseDOM: [
      {
        tag: 'pre',
        preserveWhitespace: 'full',
        getAttrs: (node) => {
          const element = node;
          return {
            ...trackingAttrsFromDom(element),
            language: element.getAttribute('data-language'),
          };
        },
      },
    ],
    toDOM: (node): DOMOutputSpec => {
      const attrs = trackingDomAttrs(node.attrs);
      const language = readAttr(node.attrs, 'language');
      if (typeof language === 'string') {
        attrs['data-language'] = language;
      }
      return ['pre', attrs, ['code', 0]];
    },
  },
  horizontalRule: trackedBlockSpec('hr', undefined, {
    atom: true,
  }),
  hardBreak: {
    inline: true,
    group: 'inline',
    selectable: false,
    parseDOM: [{ tag: 'br' }],
    toDOM: (): DOMOutputSpec => ['br'],
  },
  table: {
    ...trackedBlockSpec('table', 'tableRow+', {
      isolating: true,
    }),
    toDOM: (node): DOMOutputSpec => ['table', trackingDomAttrs(node.attrs), ['tbody', 0]],
  },
  tableRow: trackedBlockSpec('tr', '(tableHeader | tableCell)+'),
  tableHeader: {
    ...trackedBlockSpec('th', 'block+', { isolating: true }),
    attrs: {
      ...addressableAttrs,
      colspan: {
        default: 1,
        validate: (value: unknown) =>
          typeof value === 'number' && Number.isSafeInteger(value) && value >= 1,
      },
      rowspan: {
        default: 1,
        validate: (value: unknown) =>
          typeof value === 'number' && Number.isSafeInteger(value) && value >= 1,
      },
      colwidth: {
        default: null,
        validate: (value: unknown) =>
          value === null ||
          (Array.isArray(value) &&
            value.every((width) => Number.isSafeInteger(width) && Number(width) > 0)),
      },
    },
    parseDOM: [
      {
        tag: 'th',
        getAttrs: (node) => {
          const element = node;
          return {
            ...trackingAttrsFromDom(element),
            colspan: parsePositiveInteger(element.getAttribute('colspan'), 1),
            rowspan: parsePositiveInteger(element.getAttribute('rowspan'), 1),
            colwidth: parseColumnWidths(element.getAttribute('data-colwidth')),
          };
        },
      },
    ],
    toDOM: tableCellToDom('th'),
  },
  tableCell: {
    ...trackedBlockSpec('td', 'block+', { isolating: true }),
    attrs: {
      ...addressableAttrs,
      colspan: {
        default: 1,
        validate: (value: unknown) =>
          typeof value === 'number' && Number.isSafeInteger(value) && value >= 1,
      },
      rowspan: {
        default: 1,
        validate: (value: unknown) =>
          typeof value === 'number' && Number.isSafeInteger(value) && value >= 1,
      },
      colwidth: {
        default: null,
        validate: (value: unknown) =>
          value === null ||
          (Array.isArray(value) &&
            value.every((width) => Number.isSafeInteger(width) && Number(width) > 0)),
      },
    },
    parseDOM: [
      {
        tag: 'td',
        getAttrs: (node) => {
          const element = node;
          return {
            ...trackingAttrsFromDom(element),
            colspan: parsePositiveInteger(element.getAttribute('colspan'), 1),
            rowspan: parsePositiveInteger(element.getAttribute('rowspan'), 1),
            colwidth: parseColumnWidths(element.getAttribute('data-colwidth')),
          };
        },
      },
    ],
    toDOM: tableCellToDom('td'),
  },
};

function tableCellToDom(tag: 'td' | 'th'): NonNullable<NodeSpec['toDOM']> {
  return (node): DOMOutputSpec => {
    const attrs = trackingDomAttrs(node.attrs);
    const colspan = readAttr(node.attrs, 'colspan');
    const rowspan = readAttr(node.attrs, 'rowspan');
    const colwidth = readAttr(node.attrs, 'colwidth');
    if (colspan !== 1) {
      attrs['colspan'] = String(colspan);
    }
    if (rowspan !== 1) {
      attrs['rowspan'] = String(rowspan);
    }
    if (Array.isArray(colwidth)) {
      attrs['data-colwidth'] = colwidth.join(',');
    }
    return [tag, attrs, 0];
  };
}

function linkAttrsFromDom(node: HTMLElement): Attrs | false {
  const href = node.getAttribute('href');
  if (href === null) {
    return false;
  }
  return {
    href,
    title: node.getAttribute('title'),
  };
}

const marks: Record<string, MarkSpec> = {
  bold: {
    parseDOM: [{ tag: 'strong' }, { tag: 'b' }],
    toDOM: (): DOMOutputSpec => ['strong', 0],
  },
  italic: {
    parseDOM: [{ tag: 'em' }, { tag: 'i' }],
    toDOM: (): DOMOutputSpec => ['em', 0],
  },
  strike: {
    parseDOM: [{ tag: 's' }, { tag: 'strike' }],
    toDOM: (): DOMOutputSpec => ['s', 0],
  },
  code: {
    code: true,
    parseDOM: [{ tag: 'code' }],
    toDOM: (): DOMOutputSpec => ['code', 0],
  },
  link: {
    attrs: {
      href: {
        validate: (value: unknown) => typeof value === 'string' && value.length > 0,
      },
      title: { default: null, validate: isNullableString },
    },
    inclusive: false,
    parseDOM: [{ tag: 'a[href]', getAttrs: (node) => linkAttrsFromDom(node) }],
    toDOM: (mark): DOMOutputSpec => {
      const attrs: Record<string, string> = { href: String(readAttr(mark.attrs, 'href')) };
      const title = readAttr(mark.attrs, 'title');
      if (typeof title === 'string') {
        attrs['title'] = title;
      }
      return ['a', attrs, 0];
    },
  },
  diffChange: {
    attrs: {
      changeId: {
        validate: (value: unknown) => typeof value === 'string' && value.length > 0,
      },
      kind: {
        validate: (value: unknown) =>
          typeof value === 'string' && inlineDiffKinds.has(value as InlineDiffKind),
      },
    },
    inclusive: false,
    excludes: 'diffChange',
    parseDOM: [
      {
        tag: 'span[data-diff-change-id][data-diff-change-kind]',
        getAttrs: (node) => {
          const element = node;
          return {
            changeId: element.getAttribute('data-diff-change-id'),
            kind: element.getAttribute('data-diff-change-kind'),
          };
        },
      },
    ],
    toDOM: (mark): DOMOutputSpec => [
      'span',
      {
        'data-diff-change-id': String(readAttr(mark.attrs, 'changeId')),
        'data-diff-change-kind': String(readAttr(mark.attrs, 'kind')),
      },
      0,
    ],
  },
};

export function createMvpSchema(): Schema {
  return new Schema({ nodes, marks });
}

export const mvpSchema = createMvpSchema();

export const MVP_CAPABILITIES: MvpSchemaCapability = Object.freeze({
  schemaId: MVP_SCHEMA_ID,
  schemaVersion: MVP_SCHEMA_VERSION,
  nodes: MVP_NODE_TYPES,
  marks: MVP_MARK_TYPES,
  addressableNodes: ADDRESSABLE_NODE_TYPES,
  projections: Object.freeze(['review', 'final', 'original', 'clean'] as const),
});

export function createMvpAdapter(): MvpAdapter {
  return {
    schema: createMvpSchema(),
    capability: MVP_CAPABILITIES,
  };
}

export function isAddressableNodeType(value: string): value is AddressableNodeType {
  return (ADDRESSABLE_NODE_TYPES as readonly string[]).includes(value);
}
