import { randomUUID } from 'node:crypto';

import { Fragment, Node as ProseMirrorNode } from '@tiptap/pm/model';

import { readAttr } from './attrs.js';
import { isUuid, validateDocument } from './canonical.js';
import { AdapterValidationError } from './errors.js';
import { isAddressableNodeType } from './schema.js';
import type {
  BlockIdFactory,
  BlockJoinIdentity,
  BlockLookup,
  BlockSplitIdentity,
  ResourceLimits,
} from './types.js';

export function createUuidBlockId(): string {
  return randomUUID();
}

export function createSplitBlockIdentity(
  retainedBlockId: string,
  idFactory: BlockIdFactory = createUuidBlockId,
): BlockSplitIdentity {
  if (!isUuid(retainedBlockId)) {
    throw new AdapterValidationError('INVALID_BLOCK_ID', 'A split requires a valid retained UUID');
  }
  return {
    retainedBlockId,
    newBlockId: createUniqueId(idFactory, new Set([retainedBlockId])),
  };
}

export function createJoinBlockIdentity(
  retainedBlockId: string,
  retiredBlockIds: readonly string[],
): BlockJoinIdentity {
  if (!isUuid(retainedBlockId)) {
    throw new AdapterValidationError('INVALID_BLOCK_ID', 'A join requires a valid retained UUID');
  }
  const uniqueRetired = new Set<string>();
  for (const retiredBlockId of retiredBlockIds) {
    if (
      !isUuid(retiredBlockId) ||
      retiredBlockId === retainedBlockId ||
      uniqueRetired.has(retiredBlockId)
    ) {
      throw new AdapterValidationError(
        'INVALID_BLOCK_ID',
        'Joined block IDs must be distinct valid UUIDs',
      );
    }
    uniqueRetired.add(retiredBlockId);
  }
  return { retainedBlockId, retiredBlockIds: [...uniqueRetired] };
}

function createUniqueId(factory: BlockIdFactory, used: Set<string>): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = factory();
    if (!isUuid(id)) {
      throw new AdapterValidationError(
        'INVALID_BLOCK_ID',
        'The server block-ID factory must return UUIDs',
      );
    }
    if (!used.has(id)) {
      used.add(id);
      return id;
    }
  }
  throw new AdapterValidationError(
    'DUPLICATE_BLOCK_ID',
    'The server block-ID factory repeatedly generated duplicate IDs',
  );
}

function rebuildNode(
  node: ProseMirrorNode,
  children: readonly ProseMirrorNode[],
  attrs: Readonly<Record<string, unknown>>,
): ProseMirrorNode {
  if (node.isText) {
    return node;
  }
  return node.type.create(attrs, Fragment.fromArray([...children]), node.marks);
}

function rewriteBlockIds(
  document: ProseMirrorNode,
  regenerateAll: boolean,
  idFactory: BlockIdFactory,
): ProseMirrorNode {
  const used = new Set<string>();

  if (!regenerateAll) {
    document.descendants((node) => {
      if (!isAddressableNodeType(node.type.name)) {
        return;
      }
      const id = readAttr(node.attrs, 'blockId');
      if (id === null) {
        return;
      }
      if (typeof id !== 'string' || !isUuid(id)) {
        throw new AdapterValidationError('INVALID_BLOCK_ID', 'An existing blockId is not a UUID');
      }
      if (used.has(id)) {
        throw new AdapterValidationError(
          'DUPLICATE_BLOCK_ID',
          'Existing block IDs are duplicated',
          {
            blockId: id,
          },
        );
      }
      used.add(id);
    });
  }

  function visit(node: ProseMirrorNode): ProseMirrorNode {
    if (node.isText) {
      return node;
    }
    let attrs = node.attrs;
    if (isAddressableNodeType(node.type.name)) {
      const current = readAttr(node.attrs, 'blockId');
      if (!regenerateAll && current !== null && typeof current !== 'string') {
        throw new AdapterValidationError('INVALID_BLOCK_ID', 'An existing blockId is not a string');
      }
      const blockId = regenerateAll || current === null ? createUniqueId(idFactory, used) : current;
      attrs = { ...node.attrs, blockId };
    }
    const children: ProseMirrorNode[] = [];
    for (let index = 0; index < node.childCount; index += 1) {
      children.push(visit(node.child(index)));
    }
    return rebuildNode(node, children, attrs);
  }

  return visit(document);
}

/**
 * Assign IDs only to addressable nodes that do not yet have one. Existing IDs
 * remain stable and are checked for uniqueness.
 */
export function assignBlockIds(
  document: ProseMirrorNode,
  idFactory: BlockIdFactory = createUuidBlockId,
  limits: Partial<ResourceLimits> = {},
): ProseMirrorNode {
  const result = rewriteBlockIds(document, false, idFactory);
  validateDocument(result, limits);
  return result;
}

/**
 * Clipboard/copy helper: every addressable node in the copied subtree gets a
 * fresh server-owned UUID.
 */
export function cloneWithFreshBlockIds(
  document: ProseMirrorNode,
  idFactory: BlockIdFactory = createUuidBlockId,
  limits: Partial<ResourceLimits> = {},
): ProseMirrorNode {
  const result = rewriteBlockIds(document, true, idFactory);
  validateDocument(result, limits);
  return result;
}

function collectAddressableBlockIds(
  root: ProseMirrorNode,
  duplicateMessage: string,
): ReadonlySet<string> {
  const ids = new Set<string>();

  function visit(node: ProseMirrorNode): void {
    if (isAddressableNodeType(node.type.name)) {
      const blockId = readAttr(node.attrs, 'blockId');
      if (typeof blockId !== 'string' || !isUuid(blockId)) {
        throw new AdapterValidationError(
          'INVALID_BLOCK_ID',
          'Every replacement block requires a valid server-owned block ID',
        );
      }
      if (ids.has(blockId)) {
        throw new AdapterValidationError('DUPLICATE_BLOCK_ID', duplicateMessage, {
          blockId,
        });
      }
      ids.add(blockId);
    }
    for (let index = 0; index < node.childCount; index += 1) {
      visit(node.child(index));
    }
  }

  visit(root);
  return ids;
}

/**
 * A replacement is a new subtree, not a continuation of the target block.
 * Its server-owned IDs must therefore be disjoint from every ID in the
 * document, including IDs in the subtree that the direct edit will retire.
 */
export function assertFreshReplacementBlockIds(
  document: ProseMirrorNode,
  replacement: ProseMirrorNode,
): void {
  validateDocument(document);
  if (!isAddressableNodeType(replacement.type.name)) {
    throw new AdapterValidationError(
      'INVALID_DOCUMENT',
      'A replacement must be an addressable block',
    );
  }
  const documentIds = collectAddressableBlockIds(
    document,
    'The existing document contains duplicate block IDs',
  );
  const replacementIds = collectAddressableBlockIds(
    replacement,
    'The replacement subtree contains duplicate block IDs',
  );

  for (const blockId of replacementIds) {
    if (documentIds.has(blockId)) {
      throw new AdapterValidationError(
        'DUPLICATE_BLOCK_ID',
        'Replacement block IDs must be fresh and cannot reuse retired or live document IDs',
        { blockId },
      );
    }
  }
}

export function findBlockById(document: ProseMirrorNode, blockId: string): BlockLookup {
  let found: BlockLookup | undefined;

  function visit(node: ProseMirrorNode, position: number, path: readonly number[]): void {
    if (isAddressableNodeType(node.type.name) && readAttr(node.attrs, 'blockId') === blockId) {
      if (found !== undefined) {
        throw new AdapterValidationError(
          'DUPLICATE_BLOCK_ID',
          'The requested block ID is ambiguous',
          { blockId },
        );
      }
      found = { id: blockId, node, position, path };
    }
    let childPosition = node.type.name === 'doc' ? 0 : position + 1;
    for (let index = 0; index < node.childCount; index += 1) {
      const child = node.child(index);
      visit(child, childPosition, [...path, index]);
      childPosition += child.nodeSize;
    }
  }

  visit(document, 0, []);
  if (found === undefined) {
    throw new AdapterValidationError('BLOCK_NOT_FOUND', 'No block exists with the requested ID', {
      blockId,
    });
  }
  return found;
}

export function replaceNodeAtPath(
  document: ProseMirrorNode,
  path: readonly number[],
  replacement: ProseMirrorNode | null,
): ProseMirrorNode {
  if (path.length === 0) {
    if (replacement?.type.name !== 'doc') {
      throw new AdapterValidationError(
        'INVALID_DOCUMENT',
        'The doc root cannot be removed or replaced',
      );
    }
    return replacement;
  }

  function visit(node: ProseMirrorNode, depth: number): ProseMirrorNode {
    const targetIndex = path[depth];
    if (targetIndex === undefined || targetIndex < 0 || targetIndex >= node.childCount) {
      throw new AdapterValidationError('INVALID_DOCUMENT', 'Block path is no longer valid');
    }
    const children: ProseMirrorNode[] = [];
    for (let index = 0; index < node.childCount; index += 1) {
      const child = node.child(index);
      if (index !== targetIndex) {
        children.push(child);
      } else if (depth === path.length - 1) {
        if (replacement !== null) {
          children.push(replacement);
        }
      } else {
        children.push(visit(child, depth + 1));
      }
    }
    return rebuildNode(node, children, node.attrs);
  }

  return visit(document, 0);
}

/**
 * Insert already-certified sibling nodes next to a node path. The helper
 * rebuilds only ancestors on that path and validates the complete result.
 */
export function insertNodesAdjacentToPath(
  document: ProseMirrorNode,
  path: readonly number[],
  nodes: readonly ProseMirrorNode[],
  side: 'after' | 'before',
): ProseMirrorNode {
  if (path.length === 0) {
    throw new AdapterValidationError(
      'INVALID_DOCUMENT',
      'Nodes cannot be inserted adjacent to the doc root',
    );
  }
  if (nodes.length === 0) {
    return document;
  }

  function visit(parent: ProseMirrorNode, depth: number): ProseMirrorNode {
    const targetIndex = path[depth];
    if (targetIndex === undefined || targetIndex < 0 || targetIndex >= parent.childCount) {
      throw new AdapterValidationError('INVALID_DOCUMENT', 'Block path is no longer valid');
    }
    const children: ProseMirrorNode[] = [];
    for (let index = 0; index < parent.childCount; index += 1) {
      if (depth === path.length - 1 && index === targetIndex && side === 'before') {
        children.push(...nodes);
      }
      const child = parent.child(index);
      children.push(
        index === targetIndex && depth < path.length - 1 ? visit(child, depth + 1) : child,
      );
      if (depth === path.length - 1 && index === targetIndex && side === 'after') {
        children.push(...nodes);
      }
    }
    try {
      return rebuildNode(parent, children, parent.attrs);
    } catch (error) {
      throw new AdapterValidationError(
        'INVALID_DOCUMENT',
        'Adjacent insertion violates the parent content schema',
        {},
        { cause: error },
      );
    }
  }

  const result = visit(document, 0);
  validateDocument(result);
  return result;
}
