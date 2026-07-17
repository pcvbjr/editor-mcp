import { createHash } from 'node:crypto';

import { Node as ProseMirrorNode } from '@tiptap/pm/model';

import { readAttr } from './attrs.js';
import { AdapterValidationError } from './errors.js';
import { isAddressableNodeType, mvpSchema } from './schema.js';
import type {
  BlockDiffKind,
  InlineDiffKind,
  ProseMirrorMarkJson,
  ProseMirrorNodeJson,
  ResourceLimits,
} from './types.js';

export const DEFAULT_RESOURCE_LIMITS: ResourceLimits = Object.freeze({
  maxBlocks: 5_000,
  maxDepth: 64,
  maxHtmlBytes: 100_000,
  maxNodes: 10_000,
  maxTableColumns: 256,
  maxTableRows: 2_000,
  maxTextBytes: 1_000_000,
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const blockDiffKinds = new Set<BlockDiffKind>(['delete', 'insert', 'modify']);
const inlineDiffKinds = new Set<InlineDiffKind>(['delete', 'format', 'insert']);
const nodeJsonKeys = new Set(['attrs', 'content', 'marks', 'text', 'type']);
const markJsonKeys = new Set(['attrs', 'type']);

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export function resolveResourceLimits(
  limits: Partial<ResourceLimits> = {},
): Readonly<ResourceLimits> {
  const resolved: ResourceLimits = { ...DEFAULT_RESOURCE_LIMITS, ...limits };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new AdapterValidationError(
        'RESOURCE_LIMIT',
        'Resource limits must be positive integers',
        {
          limit: name,
        },
      );
    }
  }
  return Object.freeze(resolved);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertKnownKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  description: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new AdapterValidationError(
        'INVALID_DOCUMENT',
        `${description} contains an unknown property`,
        { property: key },
      );
    }
  }
}

function assertAttrs(value: unknown, allowedNames: ReadonlySet<string>, description: string): void {
  if (!isObject(value)) {
    throw new AdapterValidationError(
      'INVALID_DOCUMENT',
      `${description} attributes must be an object`,
    );
  }
  for (const name of Object.keys(value)) {
    if (!allowedNames.has(name)) {
      throw new AdapterValidationError(
        'INVALID_DOCUMENT',
        `${description} contains an unknown attribute`,
        { attribute: name },
      );
    }
  }
}

function assertMarkJson(value: unknown): asserts value is ProseMirrorMarkJson {
  if (!isObject(value)) {
    throw new AdapterValidationError('INVALID_DOCUMENT', 'A mark must be an object');
  }
  assertKnownKeys(value, markJsonKeys, 'Mark');
  if (typeof value['type'] !== 'string') {
    throw new AdapterValidationError('INVALID_DOCUMENT', 'A mark type must be a string');
  }
  const markType = mvpSchema.marks[value['type']];
  if (markType === undefined) {
    throw new AdapterValidationError(
      'INVALID_DOCUMENT',
      'The document contains an unsupported mark',
      {
        mark: value['type'],
      },
    );
  }
  if (value['attrs'] !== undefined) {
    assertAttrs(value['attrs'], new Set(Object.keys(markType.spec.attrs ?? {})), 'Mark');
  }
}

function assertNodeJson(value: unknown): asserts value is ProseMirrorNodeJson {
  if (!isObject(value)) {
    throw new AdapterValidationError('INVALID_DOCUMENT', 'A ProseMirror node must be an object');
  }
  assertKnownKeys(value, nodeJsonKeys, 'Node');
  if (typeof value['type'] !== 'string') {
    throw new AdapterValidationError('INVALID_DOCUMENT', 'A node type must be a string');
  }
  const nodeType = mvpSchema.nodes[value['type']];
  if (nodeType === undefined) {
    throw new AdapterValidationError(
      'INVALID_DOCUMENT',
      'The document contains an unsupported node',
      {
        nodeType: value['type'],
      },
    );
  }
  if (value['attrs'] !== undefined) {
    assertAttrs(value['attrs'], new Set(Object.keys(nodeType.spec.attrs ?? {})), 'Node');
  }
  if (value['text'] !== undefined && typeof value['text'] !== 'string') {
    throw new AdapterValidationError('INVALID_DOCUMENT', 'Node text must be a string');
  }
  if (nodeType.isText) {
    if (typeof value['text'] !== 'string' || value['text'].length === 0) {
      throw new AdapterValidationError('INVALID_DOCUMENT', 'Text nodes require nonempty text');
    }
    if (value['content'] !== undefined || value['attrs'] !== undefined) {
      throw new AdapterValidationError(
        'INVALID_DOCUMENT',
        'Text nodes cannot contain content or attributes',
      );
    }
  } else if (value['text'] !== undefined) {
    throw new AdapterValidationError('INVALID_DOCUMENT', 'Only text nodes may contain text');
  }
  if (nodeType.isLeaf && value['content'] !== undefined) {
    throw new AdapterValidationError('INVALID_DOCUMENT', 'Leaf nodes cannot contain content');
  }
  if (!nodeType.isInline && value['marks'] !== undefined) {
    throw new AdapterValidationError(
      'INVALID_DOCUMENT',
      'Marks may only be attached to inline nodes',
    );
  }
  if (value['content'] !== undefined) {
    if (!Array.isArray(value['content'])) {
      throw new AdapterValidationError('INVALID_DOCUMENT', 'Node content must be an array');
    }
    for (const child of value['content']) {
      assertNodeJson(child);
    }
  }
  if (value['marks'] !== undefined) {
    if (!Array.isArray(value['marks'])) {
      throw new AdapterValidationError('INVALID_DOCUMENT', 'Node marks must be an array');
    }
    for (const mark of value['marks']) {
      assertMarkJson(mark);
    }
  }
}

export function canonicalizeDocument(
  input: ProseMirrorNode | ProseMirrorNodeJson,
  limits: Partial<ResourceLimits> = {},
): ProseMirrorNode {
  const json: unknown = input instanceof ProseMirrorNode ? input.toJSON() : input;
  assertNodeJson(json);

  let document: ProseMirrorNode;
  try {
    document = ProseMirrorNode.fromJSON(mvpSchema, json);
    document.check();
  } catch (error) {
    throw new AdapterValidationError(
      'INVALID_DOCUMENT',
      'The ProseMirror document does not satisfy the MVP schema',
      {},
      { cause: error },
    );
  }
  if (document.type !== mvpSchema.topNodeType) {
    throw new AdapterValidationError('INVALID_DOCUMENT', 'The canonical root node must be doc');
  }
  validateDocument(document, limits);
  return document;
}

export function validateDocument(
  document: ProseMirrorNode,
  limits: Partial<ResourceLimits> = {},
): void {
  const resolvedLimits = resolveResourceLimits(limits);
  if (document.type.name !== 'doc') {
    throw new AdapterValidationError('INVALID_DOCUMENT', 'The root node must be doc');
  }

  try {
    document.check();
  } catch (error) {
    throw new AdapterValidationError(
      'INVALID_DOCUMENT',
      'The ProseMirror document does not satisfy its schema',
      {},
      { cause: error },
    );
  }

  let blockCount = 0;
  let nodeCount = 0;
  let textBytes = 0;
  const blockIds = new Set<string>();

  function visit(node: ProseMirrorNode, depth: number): void {
    nodeCount += 1;
    if (nodeCount > resolvedLimits.maxNodes) {
      throwResourceLimit('maxNodes', resolvedLimits.maxNodes);
    }
    if (depth > resolvedLimits.maxDepth) {
      throwResourceLimit('maxDepth', resolvedLimits.maxDepth);
    }
    if (node.isText) {
      textBytes += Buffer.byteLength(node.text ?? '', 'utf8');
      if (textBytes > resolvedLimits.maxTextBytes) {
        throwResourceLimit('maxTextBytes', resolvedLimits.maxTextBytes);
      }
    }

    validateMarks(node);
    if (isAddressableNodeType(node.type.name)) {
      blockCount += 1;
      if (blockCount > resolvedLimits.maxBlocks) {
        throwResourceLimit('maxBlocks', resolvedLimits.maxBlocks);
      }
      validateBlockAttrs(node, blockIds);
    }
    if (node.type.name === 'table') {
      validateRectangularTable(node, resolvedLimits);
    }

    for (let index = 0; index < node.childCount; index += 1) {
      visit(node.child(index), depth + 1);
    }
  }

  visit(document, 0);
}

function throwResourceLimit(name: keyof ResourceLimits, limit: number): never {
  throw new AdapterValidationError(
    'RESOURCE_LIMIT',
    'Content exceeds a configured resource limit',
    {
      limit,
      resource: name,
    },
  );
}

function validateBlockAttrs(node: ProseMirrorNode, ids: Set<string>): void {
  const id = readAttr(node.attrs, 'blockId');
  if (typeof id !== 'string' || id.length === 0) {
    throw new AdapterValidationError(
      'MISSING_BLOCK_ID',
      'Every addressable node requires a blockId',
      {
        nodeType: node.type.name,
      },
    );
  }
  if (!isUuid(id)) {
    throw new AdapterValidationError('INVALID_BLOCK_ID', 'blockId must be a UUID', {
      nodeType: node.type.name,
    });
  }
  if (ids.has(id)) {
    throw new AdapterValidationError('DUPLICATE_BLOCK_ID', 'blockId values must be unique', {
      blockId: id,
    });
  }
  ids.add(id);

  const changeId = readAttr(node.attrs, 'diffChangeId');
  const changeKind = readAttr(node.attrs, 'diffChangeKind');
  if ((changeId === null) !== (changeKind === null)) {
    throw new AdapterValidationError(
      'INVALID_TRACKING',
      'Block diffChangeId and diffChangeKind must either both be set or both be null',
      { blockId: id },
    );
  }
  if (
    changeId !== null &&
    (typeof changeId !== 'string' ||
      changeId.length === 0 ||
      typeof changeKind !== 'string' ||
      !blockDiffKinds.has(changeKind as BlockDiffKind))
  ) {
    throw new AdapterValidationError('INVALID_TRACKING', 'Block tracking attributes are invalid', {
      blockId: id,
    });
  }

  if (node.type.name === 'heading') {
    const level = readAttr(node.attrs, 'level');
    if (typeof level !== 'number' || !Number.isInteger(level) || level < 1 || level > 6) {
      throw new AdapterValidationError(
        'INVALID_DOCUMENT',
        'Heading level must be from 1 through 6',
      );
    }
  }
  if (node.type.name === 'orderedList') {
    const start = readAttr(node.attrs, 'start');
    if (typeof start !== 'number' || !Number.isSafeInteger(start) || start < 1) {
      throw new AdapterValidationError('INVALID_DOCUMENT', 'Ordered-list start must be at least 1');
    }
  }
  if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') {
    const colspan = readAttr(node.attrs, 'colspan');
    const rowspan = readAttr(node.attrs, 'rowspan');
    const colwidth = readAttr(node.attrs, 'colwidth');
    if (
      typeof colspan !== 'number' ||
      !Number.isSafeInteger(colspan) ||
      colspan < 1 ||
      typeof rowspan !== 'number' ||
      !Number.isSafeInteger(rowspan) ||
      rowspan < 1
    ) {
      throw new AdapterValidationError('INVALID_DOCUMENT', 'Table spans must be positive integers');
    }
    if (
      colwidth !== null &&
      (!Array.isArray(colwidth) ||
        colwidth.length !== colspan ||
        !colwidth.every((width) => Number.isSafeInteger(width) && Number(width) > 0))
    ) {
      throw new AdapterValidationError(
        'INVALID_DOCUMENT',
        'colwidth must contain one positive width per spanned column',
      );
    }
  }
}

function validateMarks(node: ProseMirrorNode): void {
  let diffCount = 0;
  for (const mark of node.marks) {
    if (mark.type.name === 'link') {
      const href = readAttr(mark.attrs, 'href');
      if (typeof href !== 'string' || !isAllowedHref(href)) {
        throw new AdapterValidationError('UNSAFE_LINK', 'Link href is not allowed');
      }
    }
    if (mark.type.name === 'diffChange') {
      diffCount += 1;
      const changeId = readAttr(mark.attrs, 'changeId');
      const kind = readAttr(mark.attrs, 'kind');
      if (
        typeof changeId !== 'string' ||
        changeId.length === 0 ||
        typeof kind !== 'string' ||
        !inlineDiffKinds.has(kind as InlineDiffKind)
      ) {
        throw new AdapterValidationError('INVALID_TRACKING', 'Inline tracking mark is invalid');
      }
    }
  }
  if (diffCount > 1) {
    throw new AdapterValidationError(
      'INVALID_TRACKING',
      'Inline content cannot carry overlapping diffChange marks',
    );
  }
}

export function isAllowedHref(href: string): boolean {
  if (href.length === 0 || href.trim() !== href || containsAsciiControl(href)) {
    return false;
  }
  if (href.startsWith('//') || href.startsWith('\\\\')) {
    return false;
  }
  const scheme = /^([a-z][a-z\d+.-]*):/iu.exec(href)?.[1]?.toLowerCase();
  return scheme === undefined || scheme === 'http' || scheme === 'https' || scheme === 'mailto';
}

function containsAsciiControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
      return true;
    }
  }
  return false;
}

function validateRectangularTable(table: ProseMirrorNode, limits: ResourceLimits): void {
  if (table.childCount > limits.maxTableRows) {
    throwResourceLimit('maxTableRows', limits.maxTableRows);
  }
  const grid: boolean[][] = Array.from({ length: table.childCount }, () => []);
  let width = 0;

  for (let rowIndex = 0; rowIndex < table.childCount; rowIndex += 1) {
    const row = table.child(rowIndex);
    const rowGrid = grid[rowIndex];
    if (rowGrid === undefined) {
      throw new AdapterValidationError('INVALID_DOCUMENT', 'Table grid could not be constructed');
    }
    let column = 0;
    for (let cellIndex = 0; cellIndex < row.childCount; cellIndex += 1) {
      while (rowGrid[column] === true) {
        column += 1;
      }
      const cell = row.child(cellIndex);
      const colspan = Number(readAttr(cell.attrs, 'colspan'));
      const rowspan = Number(readAttr(cell.attrs, 'rowspan'));
      if (column + colspan > limits.maxTableColumns) {
        throwResourceLimit('maxTableColumns', limits.maxTableColumns);
      }
      if (rowIndex + rowspan > table.childCount) {
        throw new AdapterValidationError(
          'INVALID_DOCUMENT',
          'A table cell rowspan extends beyond the final row',
        );
      }
      for (let y = rowIndex; y < rowIndex + rowspan; y += 1) {
        const targetRow = grid[y];
        if (targetRow === undefined) {
          throw new AdapterValidationError('INVALID_DOCUMENT', 'Table grid is invalid');
        }
        for (let x = column; x < column + colspan; x += 1) {
          if (targetRow[x] === true) {
            throw new AdapterValidationError('INVALID_DOCUMENT', 'Table cell spans overlap');
          }
          targetRow[x] = true;
        }
      }
      column += colspan;
      width = Math.max(width, column);
    }
  }

  if (width < 1) {
    throw new AdapterValidationError('INVALID_DOCUMENT', 'Tables must contain at least one column');
  }
  for (const row of grid) {
    for (let column = 0; column < width; column += 1) {
      if (row[column] !== true) {
        throw new AdapterValidationError(
          'INVALID_DOCUMENT',
          'Tables must be rectangular after accounting for spans',
        );
      }
    }
  }
}

type CanonicalJson =
  | boolean
  | null
  | number
  | string
  | readonly CanonicalJson[]
  | { readonly [key: string]: CanonicalJson };

function normalizeJson(value: unknown): CanonicalJson {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeJson(item));
  }
  if (isObject(value)) {
    const result: Record<string, CanonicalJson> = {};
    for (const key of Object.keys(value).sort()) {
      const child = value[key];
      if (child === undefined) {
        throw new AdapterValidationError(
          'INVALID_DOCUMENT',
          'Canonical JSON cannot contain undefined',
        );
      }
      result[key] = normalizeJson(child);
    }
    return result;
  }
  throw new AdapterValidationError('INVALID_DOCUMENT', 'Value is not canonical JSON');
}

export function canonicalJsonString(value: unknown): string {
  const json: unknown = value instanceof ProseMirrorNode ? (value.toJSON() as unknown) : value;
  return JSON.stringify(normalizeJson(json));
}

export function digestCanonicalJson(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalJsonString(value), 'utf8').digest('hex')}`;
}
