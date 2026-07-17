import { Fragment, Mark, Node as ProseMirrorNode } from '@tiptap/pm/model';

import { readAttr } from './attrs.js';
import { validateDocument } from './canonical.js';
import { AdapterValidationError } from './errors.js';
import {
  assertFreshReplacementBlockIds,
  findBlockById,
  insertNodesAdjacentToPath,
  replaceNodeAtPath,
} from './ids.js';
import { validateChangeMetadata } from './metadata.js';
import { isAddressableNodeType, mvpSchema } from './schema.js';
import type {
  ChangeDecision,
  ChangeMetadata,
  ChangeResolutionContext,
  ChangeResolutionPlan,
  DiffChangesMetadataPort,
  DiffChangesMetadataReader,
  InlineDiffKind,
  ProjectionMode,
  ProposedBlockReplacement,
  ProseMirrorMarkJson,
} from './types.js';

export interface ProjectDocumentOptions {
  readonly metadata?: DiffChangesMetadataReader;
  readonly unresolvedCleanPolicy?: ChangeDecision;
}

function rebuildNode(
  node: ProseMirrorNode,
  children: readonly ProseMirrorNode[],
  attrs: Readonly<Record<string, unknown>> = node.attrs,
): ProseMirrorNode {
  if (node.isText) {
    return node;
  }
  return node.type.create(attrs, Fragment.fromArray([...children]), node.marks);
}

export function collectDocumentChangeIds(document: ProseMirrorNode): readonly string[] {
  const ids = new Set<string>();
  document.descendants((node) => {
    const blockChangeId = readAttr(node.attrs, 'diffChangeId');
    if (typeof blockChangeId === 'string') {
      ids.add(blockChangeId);
    }
    for (const mark of node.marks) {
      const changeId = readAttr(mark.attrs, 'changeId');
      if (mark.type.name === 'diffChange' && typeof changeId === 'string') {
        ids.add(changeId);
      }
    }
  });
  return [...ids].sort();
}

export function validateTrackingMetadata(
  document: ProseMirrorNode,
  metadata: DiffChangesMetadataReader,
): void {
  const documentIds = new Set(collectDocumentChangeIds(document));
  const records = metadata.list();
  const recordIds = new Set<string>();
  for (const record of records) {
    validateChangeMetadata(record);
    if (recordIds.has(record.id)) {
      throw new AdapterValidationError(
        'METADATA_CONFLICT',
        'The metadata port returned a duplicate change record',
      );
    }
    recordIds.add(record.id);
    if (record.status === 'pending' && !documentIds.has(record.id)) {
      throw new AdapterValidationError(
        'INCOMPLETE_CHANGE_GROUP',
        'Pending metadata has no corresponding document segment',
      );
    }
    if (record.status !== 'pending' && documentIds.has(record.id)) {
      throw new AdapterValidationError(
        'INVALID_TRACKING',
        'Resolved metadata still has a corresponding document segment',
      );
    }
  }
  for (const id of documentIds) {
    const record = metadata.get(id);
    if (record?.status !== 'pending') {
      throw new AdapterValidationError(
        'INVALID_TRACKING',
        'A tracked document segment has no pending metadata record',
      );
    }
  }
}

function normalizeReplacementNode(replacement: ProseMirrorNode): ProseMirrorNode {
  if (replacement.type.name === 'doc') {
    if (replacement.childCount !== 1) {
      throw new AdapterValidationError(
        'INVALID_DOCUMENT',
        'A block replacement must contain exactly one top-level block',
      );
    }
    const firstChild = replacement.firstChild;
    if (firstChild === null) {
      throw new AdapterValidationError('INVALID_DOCUMENT', 'Replacement block is missing');
    }
    return firstChild;
  }
  return replacement;
}

/**
 * Represent a suggested replacement as adjacent tracked blocks: the original
 * subtree is a deletion and the fresh replacement subtree is an insertion.
 * Both segments share one change ID so resolution is atomic.
 */
export function proposeBlockReplacement(
  document: ProseMirrorNode,
  targetBlockId: string,
  replacementInput: ProseMirrorNode,
  metadataInput: ChangeMetadata,
): ProposedBlockReplacement {
  validateDocument(document);
  validateChangeMetadata(metadataInput);
  if (metadataInput.status !== 'pending' || metadataInput.operation !== 'replace') {
    throw new AdapterValidationError(
      'METADATA_CONFLICT',
      'A proposed block replacement requires pending replace metadata',
    );
  }
  if (collectDocumentChangeIds(document).includes(metadataInput.id)) {
    throw new AdapterValidationError(
      'METADATA_CONFLICT',
      'The proposed change ID is already present in the document',
    );
  }

  const target = findBlockById(document, targetBlockId);
  if (collectDocumentChangeIds(target.node).length > 0) {
    throw new AdapterValidationError(
      'INVALID_TRACKING',
      'A block containing pending changes cannot be replaced by an overlapping proposal',
    );
  }
  const replacement = normalizeReplacementNode(replacementInput);
  if (!isAddressableNodeType(replacement.type.name)) {
    throw new AdapterValidationError(
      'INVALID_DOCUMENT',
      'A block replacement must produce an addressable block',
    );
  }
  if (collectDocumentChangeIds(replacement).length > 0) {
    throw new AdapterValidationError(
      'INVALID_TRACKING',
      'Replacement content cannot contain pre-existing tracking',
    );
  }
  assertFreshReplacementBlockIds(document, replacement);

  const deleted = target.node.type.create(
    {
      ...target.node.attrs,
      diffChangeId: metadataInput.id,
      diffChangeKind: 'delete',
    },
    target.node.content,
    target.node.marks,
  );
  const inserted = replacement.type.create(
    {
      ...replacement.attrs,
      diffChangeId: metadataInput.id,
      diffChangeKind: 'insert',
    },
    replacement.content,
    replacement.marks,
  );
  if (metadataInput.baseBlockId !== undefined && metadataInput.baseBlockId !== targetBlockId) {
    throw new AdapterValidationError(
      'METADATA_CONFLICT',
      'Supplied baseBlockId does not match the target block',
    );
  }
  const metadata: ChangeMetadata = {
    ...metadataInput,
    baseBlockId: targetBlockId,
  };
  validateChangeMetadata(metadata);

  const withDeletedOriginal = replaceNodeAtPath(document, target.path, deleted);
  const proposed = insertNodesAdjacentToPath(withDeletedOriginal, target.path, [inserted], 'after');
  validateDocument(proposed);
  return { document: proposed, metadata };
}

function metadataMap(
  metadata: DiffChangesMetadataReader | undefined,
): ReadonlyMap<string, ChangeMetadata> {
  return new Map((metadata?.list() ?? []).map((record) => [record.id, record]));
}

function marksFromJson(marks: readonly ProseMirrorMarkJson[]): readonly Mark[] {
  return marks.map((mark) => {
    try {
      return Mark.fromJSON(mvpSchema, mark);
    } catch (error) {
      throw new AdapterValidationError(
        'RESOLUTION_METADATA_REQUIRED',
        'Previous formatting metadata cannot be restored',
        {},
        { cause: error },
      );
    }
  });
}

function resolveInlineNode(
  node: ProseMirrorNode,
  selected: ReadonlySet<string>,
  decision: ChangeDecision,
  records: ReadonlyMap<string, ChangeMetadata>,
): ProseMirrorNode | null {
  const diffMark = node.marks.find(
    (mark) =>
      mark.type.name === 'diffChange' &&
      typeof readAttr(mark.attrs, 'changeId') === 'string' &&
      selected.has(String(readAttr(mark.attrs, 'changeId'))),
  );
  if (diffMark === undefined) {
    return node;
  }
  const kind = readAttr(diffMark.attrs, 'kind') as InlineDiffKind;
  const changeId = String(readAttr(diffMark.attrs, 'changeId'));
  if (
    (kind === 'insert' && decision === 'reject') ||
    (kind === 'delete' && decision === 'accept')
  ) {
    return null;
  }

  let marks = node.marks.filter((mark) => mark !== diffMark);
  if (kind === 'format' && decision === 'reject') {
    const previous = records.get(changeId)?.previousFormatting;
    if (previous === undefined) {
      throw new AdapterValidationError(
        'RESOLUTION_METADATA_REQUIRED',
        'Rejecting a formatting change requires previous formatting metadata',
      );
    }
    marks = [...marksFromJson(previous.marks)];
  }
  return node.mark(marks);
}

function transformForDecision(
  document: ProseMirrorNode,
  selected: ReadonlySet<string>,
  decision: ChangeDecision,
  records: ReadonlyMap<string, ChangeMetadata>,
): ProseMirrorNode {
  function visit(node: ProseMirrorNode): ProseMirrorNode | null {
    if (node.isInline) {
      return resolveInlineNode(node, selected, decision, records);
    }

    const blockChangeId = readAttr(node.attrs, 'diffChangeId');
    const selectedBlock =
      typeof blockChangeId === 'string' && selected.has(blockChangeId)
        ? {
            changeId: blockChangeId,
            kind: String(readAttr(node.attrs, 'diffChangeKind')),
          }
        : undefined;
    if (
      selectedBlock !== undefined &&
      ((selectedBlock.kind === 'insert' && decision === 'reject') ||
        (selectedBlock.kind === 'delete' && decision === 'accept'))
    ) {
      return null;
    }
    if (selectedBlock?.kind === 'modify' && decision === 'reject') {
      const previous = records.get(selectedBlock.changeId)?.previousNode;
      if (previous === undefined) {
        throw new AdapterValidationError(
          'RESOLUTION_METADATA_REQUIRED',
          'Rejecting a modified block requires a previous-node snapshot',
        );
      }
      try {
        return ProseMirrorNode.fromJSON(mvpSchema, previous);
      } catch (error) {
        throw new AdapterValidationError(
          'RESOLUTION_METADATA_REQUIRED',
          'The previous-node snapshot cannot be restored',
          {},
          { cause: error },
        );
      }
    }

    const children: ProseMirrorNode[] = [];
    for (let index = 0; index < node.childCount; index += 1) {
      const child = visit(node.child(index));
      if (child !== null) {
        children.push(child);
      }
    }
    const attrs =
      selectedBlock === undefined
        ? node.attrs
        : { ...node.attrs, diffChangeId: null, diffChangeKind: null };
    try {
      return rebuildNode(node, children, attrs);
    } catch (error) {
      throw new AdapterValidationError(
        'INVALID_DOCUMENT',
        'Resolving this change would violate the MVP schema',
        {},
        { cause: error },
      );
    }
  }

  const transformed = visit(document);
  if (transformed?.type.name !== 'doc') {
    throw new AdapterValidationError(
      'INVALID_DOCUMENT',
      'Resolving this change would remove the document root',
    );
  }
  validateDocument(transformed);
  return transformed;
}

export function planChangeResolution(
  document: ProseMirrorNode,
  changeId: string,
  decision: ChangeDecision,
  metadata: DiffChangesMetadataReader,
  context: ChangeResolutionContext,
): ChangeResolutionPlan {
  validateDocument(document);
  const target = metadata.get(changeId);
  if (target === undefined) {
    throw new AdapterValidationError('CHANGE_NOT_FOUND', 'Change metadata was not found');
  }
  validateChangeMetadata(target);
  if (target.status !== 'pending') {
    throw new AdapterValidationError('ALREADY_RESOLVED', 'The change has already been resolved');
  }

  const records =
    target.groupId === undefined
      ? [target]
      : metadata.list().filter((record) => record.groupId === target.groupId);
  if (records.length === 0 || records.some((record) => record.status !== 'pending')) {
    throw new AdapterValidationError(
      'INCOMPLETE_CHANGE_GROUP',
      'Every member of a change group must still be pending',
    );
  }
  const documentIds = new Set(collectDocumentChangeIds(document));
  if (records.some((record) => !documentIds.has(record.id))) {
    throw new AdapterValidationError(
      'INCOMPLETE_CHANGE_GROUP',
      'Every pending group member must have a document segment',
    );
  }
  const selectedIds = new Set(records.map((record) => record.id));
  const recordsById = new Map(records.map((record) => [record.id, record]));
  const resolvedDocument = transformForDecision(document, selectedIds, decision, recordsById);
  const unresolved = new Set(collectDocumentChangeIds(resolvedDocument));
  if ([...selectedIds].some((id) => unresolved.has(id))) {
    throw new AdapterValidationError(
      'INCOMPLETE_CHANGE_GROUP',
      'Resolution did not remove every selected change segment',
    );
  }

  const status = decision === 'accept' ? 'accepted' : 'rejected';
  const metadataUpdates = records
    .map((record): ChangeMetadata => ({
      ...record,
      status,
      resolvedAt: context.resolvedAt,
      resolvedBy: context.resolvedBy,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  for (const record of metadataUpdates) {
    validateChangeMetadata(record);
  }

  return {
    decision,
    document: resolvedDocument,
    ...(target.groupId === undefined ? {} : { groupId: target.groupId }),
    resolvedChangeIds: metadataUpdates.map((record) => record.id),
    metadataUpdates,
  };
}

/**
 * Convenience for unit tests and non-collaborative callers. Production Yjs
 * integration should call `planChangeResolution` and commit its document plus
 * metadata updates inside one host-owned Y.Doc transaction.
 */
export function resolveChangeInMemory(
  document: ProseMirrorNode,
  changeId: string,
  decision: ChangeDecision,
  metadata: DiffChangesMetadataPort,
  context: ChangeResolutionContext,
): ChangeResolutionPlan {
  const plan = planChangeResolution(document, changeId, decision, metadata, context);
  metadata.transact('editor-mcp:resolution', () => {
    for (const record of plan.metadataUpdates) {
      metadata.set(record);
    }
  });
  return plan;
}

export function projectDocument(
  document: ProseMirrorNode,
  mode: ProjectionMode,
  options: ProjectDocumentOptions = {},
): ProseMirrorNode {
  validateDocument(document);
  if (mode === 'review') {
    return document;
  }
  const ids = new Set(collectDocumentChangeIds(document));
  if (ids.size === 0) {
    return document;
  }
  let decision: ChangeDecision;
  if (mode === 'final') {
    decision = 'accept';
  } else if (mode === 'original') {
    decision = 'reject';
  } else if (options.unresolvedCleanPolicy !== undefined) {
    decision = options.unresolvedCleanPolicy;
  } else {
    throw new AdapterValidationError(
      'INVALID_TRACKING',
      'Clean projection requires all changes resolved or an explicit resolution policy',
    );
  }
  return transformForDecision(document, ids, decision, metadataMap(options.metadata));
}
