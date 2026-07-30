import { randomUUID } from 'node:crypto';

import {
  AdapterValidationError,
  InMemoryDiffChangesMetadataStore,
  canonicalJsonString,
  canonicalizeDocument,
  collectDocumentChangeIds,
  createUuidBlockId,
  digestBlock,
  digestCanonicalJson,
  findBlockById,
  insertNodesAdjacentToPath,
  listBlockSummaries,
  mvpSchema,
  parseAgentHtml,
  proposeBlockReplacement,
  projectDocument,
  replaceNodeAtPath,
  resolveChangeInMemory,
  serializeHtml,
  validateDocument,
  validateTrackingMetadata,
  type BlockIdFactory,
  type ChangeMetadata,
  type ProseMirrorMarkJson,
  type ProseMirrorNodeJson,
} from '@editor-mcp/adapter-tiptap-hocuspocus';
import {
  DomainError,
  assertChangeModeAllowed,
  assertReviewOperationsAllowed,
  type ApplyContext,
  type ConflictRecovery,
  type CreateContext,
  type DocumentCreationOutcome,
  type DocumentCreationPort,
  type DocumentIdentity,
  type DocumentMutationPort,
  type DocumentReadPort,
  type MutationOutcome,
  type ReadContext,
  type ReadDocumentQuery,
} from '@editor-mcp/core';
import {
  MVP_OPERATION_KINDS,
  MVP_REVIEW_MODES,
  type ApplyEditsRequest,
  type DocumentReadRequest,
  type DocumentReadResult,
  type DocumentReadResultV1,
  type EditOperation,
} from '@editor-mcp/protocol';
import {
  Fragment,
  Node as ProseMirrorNode,
  type Mark,
  type MarkType,
  type NodeType,
} from '@tiptap/pm/model';
import { Transform } from '@tiptap/pm/transform';

import {
  HocuspocusRuntime,
  RuntimeCancellationError,
  RuntimeConflictError,
  type JsonObject,
  type RuntimeDocumentIdentity,
} from '@editor-mcp/runtime-hocuspocus';

export interface TiptapDocumentServiceOptions {
  readonly runtime: HocuspocusRuntime;
  readonly blockIdFactory?: BlockIdFactory;
  readonly changeIdFactory?: () => string;
  readonly changeSetIdFactory?: () => string;
  readonly now?: () => Date;
}

export interface SeedDocumentInput {
  readonly identity: DocumentIdentity;
  readonly document: ProseMirrorNode | ProseMirrorNodeJson;
  readonly changes?: readonly ChangeMetadata[];
}

interface MutableResult {
  document: ProseMirrorNode;
  metadata: InMemoryDiffChangesMetadataStore;
  readonly affectedBlockIds: Set<string>;
  readonly generatedChangeIds: string[];
}

interface DurableMutationReceipt {
  readonly requestHash: string;
  readonly beforeRevision: string;
  readonly committedRevision: string;
  readonly changeSetId: string;
  readonly createdBlockIds: readonly string[];
  readonly affectedBlockIds: readonly string[];
  readonly generatedChangeIds: readonly string[];
}

class SemanticConflict extends Error {
  public constructor(public readonly conflict: ConflictRecovery) {
    super(conflict.code);
    this.name = 'SemanticConflict';
  }
}

function runtimeIdentity(identity: DocumentIdentity): RuntimeDocumentIdentity {
  return {
    tenantId: identity.tenantId,
    documentId: identity.documentId,
    documentIncarnation: identity.documentIncarnation,
    collaborationField: identity.collaborationField,
    schemaId: identity.schemaId,
    schemaVersion: identity.schemaVersion,
  };
}

function jsonObject(value: unknown): JsonObject {
  return structuredClone(value) as JsonObject;
}

function mutationReceiptKey(
  identity: DocumentIdentity,
  request: ApplyEditsRequest,
  context: ApplyContext,
): string {
  return digestCanonicalJson([
    identity.tenantId,
    context.authorization.principalId,
    identity.documentId,
    identity.documentIncarnation,
    identity.collaborationField,
    identity.schemaId,
    identity.schemaVersion,
    request.idempotencyKey,
  ]);
}

function storedStringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : undefined;
}

function durableMutationReceipt(value: JsonObject): DurableMutationReceipt {
  const createdBlockIds = storedStringArray(value['createdBlockIds']);
  const affectedBlockIds = storedStringArray(value['affectedBlockIds']);
  const generatedChangeIds = storedStringArray(value['generatedChangeIds']);
  if (
    value['protocolVersion'] !== 1 ||
    typeof value['requestHash'] !== 'string' ||
    typeof value['beforeRevision'] !== 'string' ||
    typeof value['committedRevision'] !== 'string' ||
    typeof value['changeSetId'] !== 'string' ||
    createdBlockIds === undefined ||
    affectedBlockIds === undefined ||
    generatedChangeIds === undefined
  ) {
    throw new DomainError(
      'INVALID_CONTENT',
      'The collaborative mutation receipt is invalid',
      false,
    );
  }
  return {
    requestHash: value['requestHash'],
    beforeRevision: value['beforeRevision'],
    committedRevision: value['committedRevision'],
    changeSetId: value['changeSetId'],
    createdBlockIds,
    affectedBlockIds,
    generatedChangeIds,
  };
}

function metadataRecord(value: JsonObject): ChangeMetadata {
  return structuredClone(value) as unknown as ChangeMetadata;
}

function metadataObject(records: readonly ChangeMetadata[]): Readonly<Record<string, JsonObject>> {
  return Object.fromEntries(records.map((record) => [record.id, jsonObject(record)]));
}

function safeMetadata(
  values: Readonly<Record<string, JsonObject>>,
): InMemoryDiffChangesMetadataStore {
  try {
    return new InMemoryDiffChangesMetadataStore(Object.values(values).map(metadataRecord));
  } catch (error) {
    throw new DomainError(
      'INVALID_CONTENT',
      'Collaborative review metadata is invalid',
      false,
      undefined,
      { cause: error },
    );
  }
}

function mapAdapterError(error: AdapterValidationError): DomainError {
  switch (error.code) {
    case 'BLOCK_NOT_FOUND':
    case 'CHANGE_NOT_FOUND':
      return new DomainError('TARGET_NOT_FOUND', 'The target block was not found', false);
    case 'DUPLICATE_BLOCK_ID':
      return new DomainError('TARGET_AMBIGUOUS', 'The target block ID is ambiguous', false);
    case 'RESOURCE_LIMIT':
      return new DomainError('PATCH_TOO_LARGE', 'Content exceeds a resource limit', false);
    case 'UNSUPPORTED_ATTRIBUTE':
    case 'UNSUPPORTED_ELEMENT':
      return new DomainError(
        'UNSUPPORTED_CONTENT',
        'Content is not supported by this schema',
        false,
      );
    case 'ALREADY_RESOLVED':
      return new DomainError('TARGET_CHANGED', 'The change is already resolved', false);
    case 'INVALID_HTML':
    case 'INVALID_DOCUMENT':
    case 'INVALID_BLOCK_ID':
    case 'INVALID_NESTING':
    case 'INVALID_TRACKING':
    case 'INCOMPLETE_CHANGE_GROUP':
    case 'METADATA_CONFLICT':
    case 'MISSING_BLOCK_ID':
    case 'MODEL_SUPPLIED_ID':
    case 'RESOLUTION_METADATA_REQUIRED':
    case 'UNSAFE_LINK':
      return new DomainError('INVALID_CONTENT', 'Content is invalid for this document', false);
  }
}

function withAdapterErrors<T>(callback: () => T): T {
  try {
    return callback();
  } catch (error) {
    if (error instanceof AdapterValidationError) {
      throw mapAdapterError(error);
    }
    throw error;
  }
}

function requireDigest(
  operationId: string,
  targetId: string,
  expected: string,
  node: ProseMirrorNode,
): void {
  const current = digestBlock(node);
  if (current !== expected) {
    throw new SemanticConflict({
      code: 'TARGET_CHANGED',
      operationId,
      targetId,
      currentDigest: current,
      retryHint: 'reread_target',
    });
  }
}

function requireBlock(
  document: ProseMirrorNode,
  operationId: string,
  blockId: string,
): ReturnType<typeof findBlockById> {
  try {
    return findBlockById(document, blockId);
  } catch (error) {
    if (error instanceof AdapterValidationError && error.code === 'BLOCK_NOT_FOUND') {
      throw new SemanticConflict({
        code: 'TARGET_NOT_FOUND',
        operationId,
        targetId: blockId,
        retryHint: 'reread_document',
      });
    }
    if (error instanceof AdapterValidationError && error.code === 'DUPLICATE_BLOCK_ID') {
      throw new SemanticConflict({
        code: 'TARGET_AMBIGUOUS',
        operationId,
        targetId: blockId,
        retryHint: 'do_not_retry',
      });
    }
    throw error;
  }
}

function rebuild(node: ProseMirrorNode, children: readonly ProseMirrorNode[]): ProseMirrorNode {
  if (node.isText) {
    return node;
  }
  return node.type.create(node.attrs, Fragment.fromArray([...children]), node.marks);
}

function trackedBlock(
  node: ProseMirrorNode,
  changeId: string,
  kind: 'delete' | 'insert' | 'modify',
): ProseMirrorNode {
  return node.type.create(
    {
      ...node.attrs,
      diffChangeId: changeId,
      diffChangeKind: kind,
    },
    node.content,
    node.marks,
  );
}

function ordinaryMarksAt(document: ProseMirrorNode, position: number): readonly Mark[] {
  const resolved = document.resolve(position);
  const marks = resolved.marks().filter((mark) => mark.type.name !== 'diffChange');
  if (marks.length > 0) {
    return marks;
  }
  return (resolved.nodeAfter?.marks ?? []).filter((mark) => mark.type.name !== 'diffChange');
}

function assertInlineTarget(
  target: ReturnType<typeof findBlockById>,
  from: number,
  to: number,
): void {
  if (!target.node.inlineContent) {
    throw new DomainError(
      'UNSUPPORTED_CONTENT',
      'Localized text operations require an inline-content block',
      false,
    );
  }
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from < 0 ||
    to < from ||
    to > target.node.content.size
  ) {
    throw new DomainError('INVALID_REQUEST', 'The text range is outside the target block', false);
  }
}

function assertNoPendingInlineChange(
  target: ReturnType<typeof findBlockById>,
  from: number,
  to: number,
): void {
  const overlap = { pending: false };
  target.node.nodesBetween(from, to, (node, position) => {
    const intersects = position < to && position + node.nodeSize > from;
    if (intersects && node.marks.some((mark) => mark.type.name === 'diffChange')) {
      overlap.pending = true;
    }
  });
  if (overlap.pending) {
    throw new DomainError(
      'INVALID_CONTENT',
      'The operation overlaps an existing pending inline change',
      false,
    );
  }
}

function assertUniformOrdinaryFormatting(
  target: ReturnType<typeof findBlockById>,
  from: number,
  to: number,
): void {
  let snapshot: string | undefined;
  target.node.nodesBetween(from, to, (node) => {
    if (!node.isText) {
      return;
    }
    const current = canonicalJsonString(
      node.marks.filter((mark) => mark.type.name !== 'diffChange').map(markJson),
    );
    snapshot ??= current;
    if (snapshot !== current) {
      throw new DomainError(
        'UNSUPPORTED_CONTENT',
        'Suggested formatting requires a uniformly formatted source range',
        false,
      );
    }
  });
}

function markJson(mark: Mark): ProseMirrorMarkJson {
  return mark.toJSON() as ProseMirrorMarkJson;
}

function changeRecord(
  id: string,
  suggestionGroupId: string,
  operationId: string,
  operation: ChangeMetadata['operation'],
  baseBlockId: string,
  request: ApplyEditsRequest,
  context: ApplyContext,
  createdAt: string,
): ChangeMetadata {
  return {
    id,
    groupId: changeGroupId(suggestionGroupId, operationId),
    ...(request.suggestionGroupName === undefined
      ? {}
      : {
          suggestionGroupId,
          suggestionGroupName: request.suggestionGroupName,
          operationId,
        }),
    status: 'pending',
    operation,
    authorId: context.authorization.principalId,
    authorType: context.authorization.principalType === 'human' ? 'human' : 'agent',
    createdAt,
    baseBlockId,
    summary: `${request.operations.length.toString()} operation edit batch`,
  };
}

function changeGroupId(changeSetId: string, operationId: string): string {
  return `${changeSetId}:${operationId}`;
}

function addMetadata(state: MutableResult, record: ChangeMetadata): void {
  state.metadata.set(record);
  state.generatedChangeIds.push(record.id);
}

function parseInserted(html: string, idFactory: BlockIdFactory): readonly ProseMirrorNode[] {
  const parsed = parseAgentHtml(html, { idFactory });
  return Array.from({ length: parsed.childCount }, (_, index) => parsed.child(index));
}

function markForOperation(operation: Extract<EditOperation, { kind: 'format_text' }>): Mark {
  if (operation.mark.type === 'link') {
    return requiredMarkType('link').create({
      href: operation.mark.href,
      title: operation.mark.title ?? null,
    });
  }
  return requiredMarkType(operation.mark.type).create();
}

function requiredMarkType(name: string): MarkType {
  const type = mvpSchema.marks[name];
  if (type === undefined) {
    throw new DomainError('INTERNAL', `Schema mark ${name} is unavailable`, false);
  }
  return type;
}

function requiredNodeType(name: string): NodeType {
  const type = mvpSchema.nodes[name];
  if (type === undefined) {
    throw new DomainError('INTERNAL', `Schema node ${name} is unavailable`, false);
  }
  return type;
}

function ensureSimpleTable(table: ProseMirrorNode): number {
  let columns: number | undefined;
  for (let rowIndex = 0; rowIndex < table.childCount; rowIndex += 1) {
    const row = table.child(rowIndex);
    columns ??= row.childCount;
    if (columns !== row.childCount || row.childCount === 0) {
      throw new DomainError('INVALID_CONTENT', 'The table is not rectangular', false);
    }
    for (let columnIndex = 0; columnIndex < row.childCount; columnIndex += 1) {
      const cell = row.child(columnIndex);
      if (cell.attrs['colspan'] !== 1 || cell.attrs['rowspan'] !== 1) {
        throw new DomainError(
          'UNSUPPORTED_CONTENT',
          'Column operations do not support spanning cells',
          false,
        );
      }
    }
  }
  return columns ?? 0;
}

function freshParagraph(idFactory: BlockIdFactory): ProseMirrorNode {
  return requiredNodeType('paragraph').create({
    blockId: idFactory(),
    diffChangeId: null,
    diffChangeKind: null,
  });
}

function freshCell(template: ProseMirrorNode, idFactory: BlockIdFactory): ProseMirrorNode {
  return template.type.create(
    {
      ...template.attrs,
      blockId: idFactory(),
      colspan: 1,
      rowspan: 1,
      colwidth: null,
      diffChangeId: null,
      diffChangeKind: null,
    },
    Fragment.from(freshParagraph(idFactory)),
  );
}

function freshRow(template: ProseMirrorNode, idFactory: BlockIdFactory): ProseMirrorNode {
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
    Fragment.fromArray(cells),
  );
}

function directOrSuggestedBlockInsert(
  state: MutableResult,
  operation: Extract<EditOperation, { kind: 'insert_after' | 'insert_before' }>,
  request: ApplyEditsRequest,
  context: ApplyContext,
  changeSetId: string,
  idFactory: BlockIdFactory,
  changeIdFactory: () => string,
  createdAt: string,
): void {
  const anchor = requireBlock(state.document, operation.operationId, operation.anchorBlockId);
  let nodes = parseInserted(operation.html, idFactory);
  if (request.changeMode === 'suggest') {
    const changeId = changeIdFactory();
    nodes = nodes.map((node) => trackedBlock(node, changeId, 'insert'));
    addMetadata(
      state,
      changeRecord(
        changeId,
        changeSetId,
        operation.operationId,
        'insert',
        operation.anchorBlockId,
        request,
        context,
        createdAt,
      ),
    );
  }
  state.document = insertNodesAdjacentToPath(
    state.document,
    anchor.path,
    nodes,
    operation.kind === 'insert_before' ? 'before' : 'after',
  );
  state.affectedBlockIds.add(operation.anchorBlockId);
}

function replaceBlock(
  state: MutableResult,
  operation: Extract<EditOperation, { kind: 'replace_block' }>,
  request: ApplyEditsRequest,
  context: ApplyContext,
  changeSetId: string,
  idFactory: BlockIdFactory,
  changeIdFactory: () => string,
  createdAt: string,
): void {
  const target = requireBlock(state.document, operation.operationId, operation.blockId);
  if (collectDocumentChangeIds(target.node).length > 0) {
    throw new DomainError(
      'INVALID_CONTENT',
      'A block containing pending changes cannot be replaced directly',
      false,
    );
  }
  const nodes = parseInserted(operation.html, idFactory);
  if (nodes.length !== 1) {
    throw new DomainError(
      'INVALID_CONTENT',
      'A block replacement must contain exactly one top-level block',
      false,
    );
  }
  const replacement = nodes[0];
  if (replacement === undefined) {
    throw new DomainError(
      'INTERNAL',
      'A validated block replacement was unexpectedly empty',
      false,
    );
  }
  if (request.changeMode === 'suggest') {
    const changeId = changeIdFactory();
    const proposed = proposeBlockReplacement(
      state.document,
      operation.blockId,
      replacement,
      changeRecord(
        changeId,
        changeSetId,
        operation.operationId,
        'replace',
        operation.blockId,
        request,
        context,
        createdAt,
      ),
    );
    state.document = proposed.document;
    addMetadata(state, proposed.metadata);
  } else {
    state.document = replaceNodeAtPath(state.document, target.path, replacement);
  }
  state.affectedBlockIds.add(operation.blockId);
}

function deleteBlock(
  state: MutableResult,
  operation: Extract<EditOperation, { kind: 'delete_block' }>,
  request: ApplyEditsRequest,
  context: ApplyContext,
  changeSetId: string,
  changeIdFactory: () => string,
  createdAt: string,
): void {
  const target = requireBlock(state.document, operation.operationId, operation.blockId);
  if (collectDocumentChangeIds(target.node).length > 0) {
    throw new DomainError(
      'INVALID_CONTENT',
      'A block containing pending changes cannot be deleted directly',
      false,
    );
  }
  if (request.changeMode === 'suggest') {
    if (target.node.attrs['diffChangeId'] !== null) {
      throw new DomainError('INVALID_CONTENT', 'The block already has a pending change', false);
    }
    const changeId = changeIdFactory();
    state.document = replaceNodeAtPath(
      state.document,
      target.path,
      trackedBlock(target.node, changeId, 'delete'),
    );
    addMetadata(
      state,
      changeRecord(
        changeId,
        changeSetId,
        operation.operationId,
        'delete',
        operation.blockId,
        request,
        context,
        createdAt,
      ),
    );
  } else {
    state.document = replaceNodeAtPath(state.document, target.path, null);
  }
  state.affectedBlockIds.add(operation.blockId);
}

function applyTextOperation(
  state: MutableResult,
  operation: Extract<
    EditOperation,
    {
      kind: 'delete_text' | 'format_text' | 'insert_text' | 'replace_text';
    }
  >,
  request: ApplyEditsRequest,
  context: ApplyContext,
  changeSetId: string,
  changeIdFactory: () => string,
  createdAt: string,
): void {
  const target = requireBlock(state.document, operation.operationId, operation.blockId);
  const from = operation.kind === 'insert_text' ? operation.offset : operation.range.from;
  const to = operation.kind === 'insert_text' ? operation.offset : operation.range.to;
  assertInlineTarget(target, from, to);
  if (target.node.attrs['diffChangeId'] !== null) {
    throw new DomainError(
      'INVALID_CONTENT',
      'Text inside a pending block change cannot be edited independently',
      false,
    );
  }
  if (request.changeMode === 'suggest') {
    assertNoPendingInlineChange(target, from, to);
    if (operation.kind === 'format_text') {
      assertUniformOrdinaryFormatting(target, from, to);
    }
  }
  const absoluteFrom = target.position + 1 + from;
  const absoluteTo = target.position + 1 + to;
  const transform = new Transform(state.document);
  const ordinaryMarks = ordinaryMarksAt(state.document, absoluteFrom);
  let record: ChangeMetadata | undefined;

  if (operation.kind === 'insert_text') {
    const marks = [...ordinaryMarks];
    if (request.changeMode === 'suggest') {
      const changeId = changeIdFactory();
      marks.push(requiredMarkType('diffChange').create({ changeId, kind: 'insert' }));
      record = changeRecord(
        changeId,
        changeSetId,
        operation.operationId,
        'insert',
        operation.blockId,
        request,
        context,
        createdAt,
      );
    }
    transform.insert(absoluteFrom, mvpSchema.text(operation.text, marks));
  } else if (operation.kind === 'delete_text') {
    if (request.changeMode === 'suggest') {
      const changeId = changeIdFactory();
      transform.addMark(
        absoluteFrom,
        absoluteTo,
        requiredMarkType('diffChange').create({ changeId, kind: 'delete' }),
      );
      record = changeRecord(
        changeId,
        changeSetId,
        operation.operationId,
        'delete',
        operation.blockId,
        request,
        context,
        createdAt,
      );
    } else {
      transform.delete(absoluteFrom, absoluteTo);
    }
  } else if (operation.kind === 'replace_text') {
    if (request.changeMode === 'suggest') {
      const changeId = changeIdFactory();
      transform.addMark(
        absoluteFrom,
        absoluteTo,
        requiredMarkType('diffChange').create({ changeId, kind: 'delete' }),
      );
      transform.insert(
        absoluteTo,
        mvpSchema.text(operation.text, [
          ...ordinaryMarks,
          requiredMarkType('diffChange').create({ changeId, kind: 'insert' }),
        ]),
      );
      record = changeRecord(
        changeId,
        changeSetId,
        operation.operationId,
        'replace',
        operation.blockId,
        request,
        context,
        createdAt,
      );
    } else {
      transform.replaceWith(
        absoluteFrom,
        absoluteTo,
        mvpSchema.text(operation.text, ordinaryMarks),
      );
    }
  } else {
    const formatMark = markForOperation(operation);
    if (operation.action === 'add') {
      transform.addMark(absoluteFrom, absoluteTo, formatMark);
    } else {
      transform.removeMark(absoluteFrom, absoluteTo, formatMark.type);
    }
    if (request.changeMode === 'suggest') {
      const changeId = changeIdFactory();
      transform.addMark(
        absoluteFrom,
        absoluteTo,
        requiredMarkType('diffChange').create({ changeId, kind: 'format' }),
      );
      record = {
        ...changeRecord(
          changeId,
          changeSetId,
          operation.operationId,
          'format',
          operation.blockId,
          request,
          context,
          createdAt,
        ),
        previousFormatting: {
          marks: ordinaryMarks.map(
            (mark) =>
              mark.toJSON() as {
                type: string;
                attrs?: Readonly<Record<string, unknown>>;
              },
          ),
        },
      };
    }
  }

  state.document = transform.doc;
  if (record !== undefined) {
    addMetadata(state, record);
  }
  state.affectedBlockIds.add(operation.blockId);
}

function applyRowOperation(
  state: MutableResult,
  operation: Extract<EditOperation, { kind: 'delete_table_row' | 'insert_table_row' }>,
  request: ApplyEditsRequest,
  context: ApplyContext,
  changeSetId: string,
  idFactory: BlockIdFactory,
  changeIdFactory: () => string,
  createdAt: string,
): void {
  const table = requireBlock(state.document, operation.operationId, operation.tableId);
  if (table.node.type.name !== 'table') {
    throw new DomainError('INVALID_CONTENT', 'The table target is not a table', false);
  }
  ensureSimpleTable(table.node);
  if (operation.rowIndex >= table.node.childCount) {
    throw new DomainError('INVALID_REQUEST', 'The table row index is out of range', false);
  }
  const row = table.node.child(operation.rowIndex);
  const rowPath = [...table.path, operation.rowIndex];
  let changeId: string | undefined;
  if (request.changeMode === 'suggest') {
    changeId = changeIdFactory();
  }

  if (operation.kind === 'insert_table_row') {
    let inserted = freshRow(row, idFactory);
    if (changeId !== undefined) {
      inserted = trackedBlock(inserted, changeId, 'insert');
    }
    state.document = insertNodesAdjacentToPath(
      state.document,
      rowPath,
      [inserted],
      operation.position ?? 'before',
    );
  } else if (changeId !== undefined) {
    state.document = replaceNodeAtPath(
      state.document,
      rowPath,
      trackedBlock(row, changeId, 'delete'),
    );
  } else {
    if (table.node.childCount <= 1) {
      throw new DomainError('INVALID_CONTENT', 'A table must retain at least one row', false);
    }
    state.document = replaceNodeAtPath(state.document, rowPath, null);
  }

  if (changeId !== undefined) {
    addMetadata(
      state,
      changeRecord(
        changeId,
        changeSetId,
        operation.operationId,
        'structure',
        operation.tableId,
        request,
        context,
        createdAt,
      ),
    );
  }
  state.affectedBlockIds.add(operation.tableId);
  state.affectedBlockIds.add(String(row.attrs['blockId']));
}

function applyColumnOperation(
  state: MutableResult,
  operation: Extract<EditOperation, { kind: 'delete_table_column' | 'insert_table_column' }>,
  request: ApplyEditsRequest,
  context: ApplyContext,
  changeSetId: string,
  idFactory: BlockIdFactory,
  changeIdFactory: () => string,
  createdAt: string,
): void {
  const table = requireBlock(state.document, operation.operationId, operation.tableId);
  if (table.node.type.name !== 'table') {
    throw new DomainError('INVALID_CONTENT', 'The table target is not a table', false);
  }
  const columns = ensureSimpleTable(table.node);
  if (operation.columnIndex >= columns) {
    throw new DomainError('INVALID_REQUEST', 'The table column index is out of range', false);
  }
  if (operation.kind === 'delete_table_column' && columns <= 1) {
    throw new DomainError('INVALID_CONTENT', 'A table must retain at least one column', false);
  }
  const changeId = request.changeMode === 'suggest' ? changeIdFactory() : undefined;
  const rows: ProseMirrorNode[] = [];
  for (let rowIndex = 0; rowIndex < table.node.childCount; rowIndex += 1) {
    const row = table.node.child(rowIndex);
    const cells = Array.from({ length: row.childCount }, (_, index) => row.child(index));
    const anchor = cells[operation.columnIndex];
    if (anchor === undefined) {
      throw new DomainError(
        'INTERNAL',
        'A validated table column target was unexpectedly absent',
        false,
      );
    }
    if (operation.kind === 'insert_table_column') {
      let inserted = freshCell(anchor, idFactory);
      if (changeId !== undefined) {
        inserted = trackedBlock(inserted, changeId, 'insert');
      }
      const at = operation.columnIndex + ((operation.position ?? 'before') === 'after' ? 1 : 0);
      cells.splice(at, 0, inserted);
    } else if (changeId !== undefined) {
      cells[operation.columnIndex] = trackedBlock(anchor, changeId, 'delete');
    } else {
      cells.splice(operation.columnIndex, 1);
    }
    rows.push(rebuild(row, cells));
  }
  state.document = replaceNodeAtPath(state.document, table.path, rebuild(table.node, rows));
  if (changeId !== undefined) {
    addMetadata(
      state,
      changeRecord(
        changeId,
        changeSetId,
        operation.operationId,
        'structure',
        operation.tableId,
        request,
        context,
        createdAt,
      ),
    );
  }
  state.affectedBlockIds.add(operation.tableId);
}

function resolveChange(
  state: MutableResult,
  operation: Extract<EditOperation, { kind: 'accept_change' | 'reject_change' }>,
  context: ApplyContext,
  resolvedAt: string,
): void {
  const current = state.metadata.get(operation.changeId);
  if (current === undefined) {
    throw new DomainError('TARGET_NOT_FOUND', 'The pending change was not found', false);
  }
  if (current.status !== 'pending') {
    // Accept/reject is idempotent when the same semantic decision won.
    const expected = operation.kind === 'accept_change' ? 'accepted' : 'rejected';
    if (current.status === expected) {
      return;
    }
    throw new DomainError(
      'TARGET_CHANGED',
      'The change was already resolved with a conflicting decision',
      false,
    );
  }
  const plan = resolveChangeInMemory(
    state.document,
    operation.changeId,
    operation.kind === 'accept_change' ? 'accept' : 'reject',
    state.metadata,
    {
      resolvedAt,
      resolvedBy: context.authorization.principalId,
    },
  );
  state.document = plan.document;
  for (const changeId of plan.resolvedChangeIds) {
    const record = state.metadata.get(changeId);
    if (record?.baseBlockId !== undefined) {
      state.affectedBlockIds.add(record.baseBlockId);
    }
  }
}

function validateOperationPrecondition(
  document: ProseMirrorNode,
  metadata: InMemoryDiffChangesMetadataStore,
  operation: EditOperation,
): void {
  switch (operation.kind) {
    case 'insert_before':
    case 'insert_after': {
      const target = requireBlock(document, operation.operationId, operation.anchorBlockId);
      if (operation.expectedAnchorDigest !== undefined) {
        requireDigest(
          operation.operationId,
          operation.anchorBlockId,
          operation.expectedAnchorDigest,
          target.node,
        );
      }
      return;
    }
    case 'replace_block':
    case 'delete_block':
    case 'insert_text':
    case 'delete_text':
    case 'replace_text':
    case 'format_text': {
      const target = requireBlock(document, operation.operationId, operation.blockId);
      requireDigest(
        operation.operationId,
        operation.blockId,
        operation.expectedBlockDigest,
        target.node,
      );
      return;
    }
    case 'insert_table_row':
    case 'delete_table_row':
    case 'insert_table_column':
    case 'delete_table_column': {
      const target = requireBlock(document, operation.operationId, operation.tableId);
      requireDigest(
        operation.operationId,
        operation.tableId,
        operation.expectedTableDigest,
        target.node,
      );
      return;
    }
    case 'accept_change':
    case 'reject_change': {
      const current = metadata.get(operation.changeId);
      if (
        current !== undefined &&
        operation.expectedChangeRevision !== undefined &&
        operation.expectedChangeRevision !== digestCanonicalJson(current)
      ) {
        throw new SemanticConflict({
          code: 'TARGET_CHANGED',
          operationId: operation.operationId,
          targetId: operation.changeId,
          currentDigest: digestCanonicalJson(current),
          retryHint: 'reread_target',
        });
      }
      return;
    }
  }
}

function applyOperation(
  state: MutableResult,
  operation: EditOperation,
  request: ApplyEditsRequest,
  context: ApplyContext,
  changeSetId: string,
  idFactory: BlockIdFactory,
  changeIdFactory: () => string,
  timestamp: string,
): void {
  switch (operation.kind) {
    case 'insert_before':
    case 'insert_after':
      directOrSuggestedBlockInsert(
        state,
        operation,
        request,
        context,
        changeSetId,
        idFactory,
        changeIdFactory,
        timestamp,
      );
      break;
    case 'replace_block':
      replaceBlock(
        state,
        operation,
        request,
        context,
        changeSetId,
        idFactory,
        changeIdFactory,
        timestamp,
      );
      break;
    case 'delete_block':
      deleteBlock(state, operation, request, context, changeSetId, changeIdFactory, timestamp);
      break;
    case 'insert_text':
    case 'delete_text':
    case 'replace_text':
    case 'format_text':
      applyTextOperation(
        state,
        operation,
        request,
        context,
        changeSetId,
        changeIdFactory,
        timestamp,
      );
      break;
    case 'insert_table_row':
    case 'delete_table_row':
      applyRowOperation(
        state,
        operation,
        request,
        context,
        changeSetId,
        idFactory,
        changeIdFactory,
        timestamp,
      );
      break;
    case 'insert_table_column':
    case 'delete_table_column':
      applyColumnOperation(
        state,
        operation,
        request,
        context,
        changeSetId,
        idFactory,
        changeIdFactory,
        timestamp,
      );
      break;
    case 'accept_change':
    case 'reject_change':
      resolveChange(state, operation, context, timestamp);
      break;
    default: {
      const exhaustive: never = operation;
      throw new DomainError(
        'INVALID_REQUEST',
        `Unsupported operation ${(exhaustive as EditOperation).kind}`,
        false,
      );
    }
  }
  validateDocument(state.document);
}

function projectReadDocument(document: ProseMirrorNode, query: ReadDocumentQuery): ProseMirrorNode {
  if (query.blockIds !== undefined && query.blockIds.length > 0) {
    const rootIndexes = new Set<number>();
    for (const id of query.blockIds) {
      const target = withAdapterErrors(() => findBlockById(document, id));
      const rootIndex = target.path[0];
      if (rootIndex !== undefined) {
        rootIndexes.add(rootIndex);
      }
    }
    const children = [...rootIndexes]
      .toSorted((left, right) => left - right)
      .map((index) => document.child(index));
    return document.type.create(document.attrs, Fragment.fromArray(children));
  }
  if (query.maxBlocks !== undefined && query.maxBlocks < document.childCount) {
    const children = Array.from({ length: query.maxBlocks }, (_, index) => document.child(index));
    return document.type.create(document.attrs, Fragment.fromArray(children));
  }
  return document;
}

function readV1Representation(
  document: ProseMirrorNode,
  metadata: InMemoryDiffChangesMetadataStore,
  profile: DocumentReadRequest['representationProfile'],
): DocumentReadResultV1['representation'] {
  switch (profile) {
    case 'agent-html/v1':
      return {
        profile,
        html: serializeHtml(document, {
          mode: 'review',
          includeBlockIds: true,
          metadata,
        }),
      };
    case 'prosemirror-json/v1':
      return {
        profile,
        json: document.toJSON() as Extract<
          DocumentReadResultV1['representation'],
          { profile: 'prosemirror-json/v1' }
        >['json'],
      };
    case 'plain-text/v1':
      return {
        profile,
        text: document.textBetween(0, document.content.size, '\n', '\n'),
      };
    case 'outline/v1':
      return {
        profile,
        entries: listBlockSummaries(document).map(({ id, nodeType }) => {
          const node = findBlockById(document, id).node;
          const level = node.attrs['level'] as unknown;
          return {
            id,
            nodeType,
            ...(typeof level === 'number' ? { level } : {}),
            ...(node.textContent.length === 0 ? {} : { text: node.textContent.slice(0, 10_000) }),
          };
        }),
      };
  }
}

function trimLastRoot(document: ProseMirrorNode): ProseMirrorNode {
  const children = Array.from({ length: Math.max(0, document.childCount - 1) }, (_, index) =>
    document.child(index),
  );
  return document.type.create(document.attrs, Fragment.fromArray(children));
}

export class TiptapDocumentService
  implements DocumentReadPort, DocumentMutationPort, DocumentCreationPort
{
  readonly #runtime: HocuspocusRuntime;
  readonly #blockIdFactory: BlockIdFactory;
  readonly #changeIdFactory: () => string;
  readonly #changeSetIdFactory: () => string;
  readonly #now: () => Date;

  public constructor(options: TiptapDocumentServiceOptions) {
    this.#runtime = options.runtime;
    this.#blockIdFactory = options.blockIdFactory ?? createUuidBlockId;
    this.#changeIdFactory = options.changeIdFactory ?? (() => `chg_${randomUUID()}`);
    this.#changeSetIdFactory = options.changeSetIdFactory ?? (() => `set_${randomUUID()}`);
    this.#now = options.now ?? (() => new Date());
  }

  public async seed(input: SeedDocumentInput): Promise<void> {
    const document = withAdapterErrors(() => canonicalizeDocument(input.document));
    const metadata = new InMemoryDiffChangesMetadataStore(input.changes);
    await this.#runtime.seed(
      runtimeIdentity(input.identity),
      jsonObject(document.toJSON()),
      metadataObject(metadata.list()),
    );
  }

  public async createBlank(
    identity: DocumentIdentity,
    _context: CreateContext,
  ): Promise<DocumentCreationOutcome> {
    void _context;
    const existing = await this.#runtime.read(runtimeIdentity(identity));
    if (existing !== undefined) {
      return {
        created: false,
        revision: existing.revision,
        acknowledgement: existing.acknowledgement,
      };
    }
    const document = mvpSchema.node('doc', undefined, [
      mvpSchema.node('paragraph', {
        blockId: this.#blockIdFactory(),
        diffChangeId: null,
        diffChangeKind: null,
      }),
    ]);
    const acknowledgement = await this.#runtime.seed(
      runtimeIdentity(identity),
      jsonObject(document.toJSON()),
    );
    const created = await this.#runtime.read(runtimeIdentity(identity));
    if (created === undefined) {
      throw new DomainError(
        'DOCUMENT_UNAVAILABLE',
        'The created document could not be loaded',
        true,
      );
    }
    return {
      created: true,
      revision: created.revision,
      acknowledgement,
    };
  }

  public async readDocument(
    identity: DocumentIdentity,
    query: ReadDocumentQuery,
    _context: ReadContext,
  ): Promise<DocumentReadResult | undefined> {
    void _context;
    const state = await this.#runtime.read(runtimeIdentity(identity));
    if (state === undefined) {
      return undefined;
    }
    const document = withAdapterErrors(() =>
      canonicalizeDocument(state.document as unknown as ProseMirrorNodeJson),
    );
    const metadata = safeMetadata(state.changes);
    const projection = projectReadDocument(document, query);
    const allSummaries = listBlockSummaries(document);
    const requested = query.blockIds;
    const blocks =
      requested === undefined
        ? allSummaries.slice(0, query.maxBlocks)
        : requested.map((id) => {
            const summary = allSummaries.find((entry) => entry.id === id);
            if (summary === undefined) {
              throw new DomainError('TARGET_NOT_FOUND', 'A requested block was not found', false, {
                targetId: id,
              });
            }
            return summary;
          });
    return {
      documentId: identity.documentId,
      documentIncarnation: identity.documentIncarnation,
      revision: state.revision,
      schemaId: 'editor-mcp/mvp',
      schemaVersion: 1,
      html: serializeHtml(projection, {
        mode: 'review',
        includeBlockIds: true,
        metadata,
      }),
      blocks: blocks.map(({ id, nodeType, contentDigest }) => ({
        id,
        nodeType: nodeType as DocumentReadResult['blocks'][number]['nodeType'],
        contentDigest,
      })),
    };
  }

  public async readDocumentV1(
    identity: DocumentIdentity,
    request: DocumentReadRequest,
    _context: ReadContext,
  ): Promise<DocumentReadResultV1 | undefined> {
    void _context;
    const state = await this.#runtime.read(runtimeIdentity(identity));
    if (state === undefined) {
      return undefined;
    }
    const document = withAdapterErrors(() =>
      canonicalizeDocument(state.document as unknown as ProseMirrorNodeJson),
    );
    const metadata = safeMetadata(state.changes);
    let projection = projectReadDocument(document, {
      documentId: identity.documentId,
      documentIncarnation: identity.documentIncarnation,
      collaborationField: identity.collaborationField,
      schemaId: identity.schemaId,
      schemaVersion: identity.schemaVersion,
      ...(request.selection.kind === 'blocks' ? { blockIds: request.selection.blockIds } : {}),
    });
    let truncated = false;
    const createResult = (): DocumentReadResultV1 => {
      const summaries = listBlockSummaries(projection);
      const boundedSummaries = summaries.slice(0, 10_000);
      const blocksTruncated = boundedSummaries.length !== summaries.length;
      return {
        protocolVersion: 1,
        ...identity,
        revision: state.revision,
        capabilities: {
          reviewModes: [...MVP_REVIEW_MODES],
          operations: [...MVP_OPERATION_KINDS],
          representationProfiles: [
            'agent-html/v1',
            'prosemirror-json/v1',
            'plain-text/v1',
            'outline/v1',
          ],
        },
        representation: readV1Representation(projection, metadata, request.representationProfile),
        blocks: boundedSummaries.map(({ id, nodeType, contentDigest }) => ({
          id,
          nodeType: nodeType as DocumentReadResultV1['blocks'][number]['nodeType'],
          contentDigest,
        })),
        truncated: truncated || blocksTruncated,
      };
    };

    let result = createResult();
    if (request.maxBytes !== undefined) {
      while (
        Buffer.byteLength(JSON.stringify(result), 'utf8') > request.maxBytes &&
        projection.childCount > 0
      ) {
        projection = trimLastRoot(projection);
        truncated = true;
        result = createResult();
      }
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') > request.maxBytes) {
        throw new DomainError(
          'PATCH_TOO_LARGE',
          'maxBytes is too small for the versioned read envelope',
          false,
          { maxBytes: request.maxBytes },
        );
      }
    }
    return result;
  }

  public async applyAtomic(
    identity: DocumentIdentity,
    request: ApplyEditsRequest,
    context: ApplyContext,
  ): Promise<MutationOutcome> {
    assertChangeModeAllowed(request.changeMode, context.authorization);
    assertReviewOperationsAllowed(request.operations, context.authorization);
    const requestHash = digestCanonicalJson(request);
    const receiptKey = mutationReceiptKey(identity, request, context);
    const before = await this.#runtime.read(runtimeIdentity(identity));
    if (before === undefined) {
      throw new DomainError('DOCUMENT_NOT_FOUND', 'The requested document was not found', false);
    }
    const storedReceiptValue = before.mutationReceipts[receiptKey];
    if (storedReceiptValue !== undefined) {
      const storedReceipt = durableMutationReceipt(storedReceiptValue);
      if (storedReceipt.requestHash !== requestHash) {
        throw new DomainError(
          'IDEMPOTENCY_MISMATCH',
          'The idempotency key was already used for a different request',
          false,
        );
      }
      return {
        status: 'applied',
        idempotentReplay: true,
        beforeRevision: storedReceipt.beforeRevision,
        revision: storedReceipt.committedRevision,
        changeSetId: storedReceipt.changeSetId,
        createdBlockIds: [...storedReceipt.createdBlockIds],
        affectedBlockIds: [...storedReceipt.affectedBlockIds],
        changeIds: [...storedReceipt.generatedChangeIds],
        conflicts: [],
        acknowledgement: {
          level: 'snapshot',
          sequence: before.acknowledgement.sequence,
          storedAt: before.acknowledgement.storedAt,
        },
      };
    }
    if (request.readRevision !== undefined && request.readRevision !== before.revision) {
      return {
        status: 'conflict',
        beforeRevision: before.revision,
        revision: before.revision,
        createdBlockIds: [],
        affectedBlockIds: [],
        changeIds: [],
        conflicts: [
          {
            code: 'TARGET_CHANGED',
            currentRevision: before.revision,
            retryHint: 'reread_document',
          },
        ],
      };
    }
    const beforeDocument = withAdapterErrors(() =>
      canonicalizeDocument(before.document as unknown as ProseMirrorNodeJson),
    );
    const beforeIds = new Set(listBlockSummaries(beforeDocument).map(({ id }) => id));
    const usedIds = new Set(beforeIds);
    const idFactory: BlockIdFactory = () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const id = this.#blockIdFactory();
        if (!usedIds.has(id)) {
          usedIds.add(id);
          return id;
        }
      }
      throw new DomainError(
        'INTERNAL',
        'The block ID generator could not produce a unique ID',
        false,
      );
    };
    const changeSetId = this.#changeSetIdFactory();
    const timestamp = this.#now().toISOString();
    let conflict: ConflictRecovery | undefined;

    try {
      const commit = await this.#runtime.mutate(
        runtimeIdentity(identity),
        before.revision,
        {
          kind: request.operations.some(
            ({ kind }) => kind === 'accept_change' || kind === 'reject_change',
          )
            ? 'resolution'
            : 'agent',
          actorId: context.authorization.principalId,
          traceId: context.authorization.traceId,
        },
        (runtimeState) =>
          withAdapterErrors(() => {
            const state: MutableResult = {
              document: canonicalizeDocument(
                runtimeState.document as unknown as ProseMirrorNodeJson,
              ),
              metadata: safeMetadata(runtimeState.changes),
              affectedBlockIds: new Set(),
              generatedChangeIds: [],
            };
            for (const operation of request.operations) {
              validateOperationPrecondition(state.document, state.metadata, operation);
            }
            for (const operation of request.operations) {
              applyOperation(
                state,
                operation,
                request,
                context,
                changeSetId,
                idFactory,
                this.#changeIdFactory,
                timestamp,
              );
            }
            validateTrackingMetadata(state.document, state.metadata);
            projectDocument(state.document, 'final', { metadata: state.metadata });
            projectDocument(state.document, 'original', { metadata: state.metadata });
            const afterIds = new Set(listBlockSummaries(state.document).map(({ id }) => id));
            const createdBlockIds = [...afterIds].filter((id) => !beforeIds.has(id));
            const affectedBlockIds = [...state.affectedBlockIds];
            const generatedChangeIds = [...state.generatedChangeIds];
            return {
              document: jsonObject(state.document.toJSON()),
              changes: metadataObject(state.metadata.list()),
              finalizeMutationReceipts: (committedRevision: string) => ({
                ...runtimeState.mutationReceipts,
                [receiptKey]: jsonObject({
                  protocolVersion: 1,
                  requestHash,
                  beforeRevision: runtimeState.revision,
                  committedRevision,
                  changeSetId,
                  createdBlockIds,
                  affectedBlockIds,
                  generatedChangeIds,
                }),
              }),
              result: {
                createdBlockIds,
                affectedBlockIds,
                generatedChangeIds,
              },
            };
          }),
        {
          ...(context.signal === undefined ? {} : { signal: context.signal }),
          ...(context.deadline === undefined ? {} : { deadline: context.deadline }),
        },
      );
      return {
        status: 'applied',
        beforeRevision: before.revision,
        revision: commit.revision,
        changeSetId,
        createdBlockIds: commit.result.createdBlockIds,
        affectedBlockIds: commit.result.affectedBlockIds,
        changeIds: commit.result.generatedChangeIds,
        conflicts: [],
        acknowledgement: {
          level: 'snapshot',
          sequence: commit.acknowledgement.sequence,
          storedAt: commit.acknowledgement.storedAt,
        },
      };
    } catch (error) {
      if (error instanceof RuntimeCancellationError) {
        throw new DomainError(
          'DEADLINE_EXCEEDED',
          'The operation was cancelled before commit',
          true,
          undefined,
          { cause: error },
        );
      } else if (error instanceof SemanticConflict) {
        conflict = {
          ...error.conflict,
          currentRevision: before.revision,
        };
      } else if (error instanceof RuntimeConflictError) {
        conflict = {
          code: 'TARGET_CHANGED',
          currentRevision: error.actualRevision,
          retryHint: 'reread_document',
        };
      } else {
        throw error;
      }
    }

    return {
      status: 'conflict',
      beforeRevision: before.revision,
      revision: conflict.currentRevision ?? before.revision,
      createdBlockIds: [],
      affectedBlockIds: [],
      changeIds: [],
      conflicts: [conflict],
    };
  }

  public async cleanJson(identity: DocumentIdentity): Promise<string | undefined> {
    const state = await this.#runtime.read(runtimeIdentity(identity));
    if (state === undefined) {
      return undefined;
    }
    const document = canonicalizeDocument(state.document as unknown as ProseMirrorNodeJson);
    const metadata = safeMetadata(state.changes);
    return canonicalJsonString({
      document: projectDocument(document, 'clean', {
        metadata,
        unresolvedCleanPolicy: 'accept',
      }).toJSON() as unknown,
      changes: metadata.list(),
    });
  }

  public async pendingChangeIds(identity: DocumentIdentity): Promise<readonly string[]> {
    const state = await this.#runtime.read(runtimeIdentity(identity));
    if (state === undefined) {
      return [];
    }
    return collectDocumentChangeIds(
      canonicalizeDocument(state.document as unknown as ProseMirrorNodeJson),
    );
  }
}
