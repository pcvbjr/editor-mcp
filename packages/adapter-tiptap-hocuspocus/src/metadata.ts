import { canonicalJsonString, isUuid } from './canonical.js';
import { AdapterValidationError } from './errors.js';
import type {
  ChangeMetadata,
  ChangeStatus,
  DiffChangesMetadataPort,
  ProseMirrorMarkJson,
  ProseMirrorNodeJson,
} from './types.js';

const statuses = new Set<ChangeStatus>(['accepted', 'pending', 'rejected']);
const operations = new Set(['delete', 'format', 'insert', 'replace', 'structure']);
const authorTypes = new Set(['agent', 'human']);

function assertNonempty(value: string, field: string): void {
  if (value.length === 0 || value.length > 256) {
    throw new AdapterValidationError('METADATA_CONFLICT', `${field} must be a nonempty opaque ID`);
  }
}

function assertTimestamp(value: string, field: string): void {
  if (value.length === 0 || !Number.isFinite(Date.parse(value))) {
    throw new AdapterValidationError(
      'METADATA_CONFLICT',
      `${field} must be an ISO-compatible date`,
    );
  }
}

function assertMarkSnapshot(marks: readonly ProseMirrorMarkJson[]): void {
  for (const mark of marks) {
    if (typeof mark.type !== 'string' || mark.type.length === 0 || mark.type === 'diffChange') {
      throw new AdapterValidationError(
        'METADATA_CONFLICT',
        'Previous formatting may contain only ordinary mark snapshots',
      );
    }
  }
}

export function validateChangeMetadata(record: ChangeMetadata): void {
  assertNonempty(record.id, 'Change ID');
  if (record.groupId !== undefined) {
    assertNonempty(record.groupId, 'Group ID');
  }
  if (!statuses.has(record.status)) {
    throw new AdapterValidationError('METADATA_CONFLICT', 'Change status is invalid');
  }
  if (!operations.has(record.operation)) {
    throw new AdapterValidationError('METADATA_CONFLICT', 'Change operation is invalid');
  }
  assertNonempty(record.authorId, 'Author ID');
  if (!authorTypes.has(record.authorType)) {
    throw new AdapterValidationError('METADATA_CONFLICT', 'Author type is invalid');
  }
  assertTimestamp(record.createdAt, 'createdAt');
  if (record.baseBlockId !== undefined && !isUuid(record.baseBlockId)) {
    throw new AdapterValidationError('METADATA_CONFLICT', 'baseBlockId must be a UUID');
  }
  if (record.status === 'pending') {
    if (record.resolvedAt !== undefined || record.resolvedBy !== undefined) {
      throw new AdapterValidationError(
        'METADATA_CONFLICT',
        'Pending metadata cannot contain resolution fields',
      );
    }
  } else {
    if (record.resolvedAt === undefined || record.resolvedBy === undefined) {
      throw new AdapterValidationError(
        'METADATA_CONFLICT',
        'Resolved metadata requires resolvedAt and resolvedBy',
      );
    }
    assertTimestamp(record.resolvedAt, 'resolvedAt');
    assertNonempty(record.resolvedBy, 'resolvedBy');
  }
  if (record.previousFormatting !== undefined) {
    assertMarkSnapshot(record.previousFormatting.marks);
  }
  if (record.previousNode !== undefined) {
    assertNodeSnapshot(record.previousNode);
  }
}

function assertNodeSnapshot(node: ProseMirrorNodeJson): void {
  if (typeof node.type !== 'string' || node.type.length === 0) {
    throw new AdapterValidationError('METADATA_CONFLICT', 'Previous node snapshot is invalid');
  }
  if (node.content !== undefined) {
    for (const child of node.content) {
      assertNodeSnapshot(child);
    }
  }
}

function cloneRecord(record: ChangeMetadata): ChangeMetadata {
  return structuredClone(record);
}

function immutableIdentity(record: ChangeMetadata): string {
  const identity = {
    id: record.id,
    ...(record.groupId === undefined ? {} : { groupId: record.groupId }),
    operation: record.operation,
    authorId: record.authorId,
    authorType: record.authorType,
    createdAt: record.createdAt,
    ...(record.summary === undefined ? {} : { summary: record.summary }),
    ...(record.baseBlockId === undefined ? {} : { baseBlockId: record.baseBlockId }),
    ...(record.previousNode === undefined ? {} : { previousNode: record.previousNode }),
    ...(record.previousFormatting === undefined
      ? {}
      : { previousFormatting: record.previousFormatting }),
  };
  return canonicalJsonString(identity);
}

/**
 * Deterministic test/standalone implementation of the Yjs metadata port. It
 * provides rollback for metadata-only transactions, but cannot make an
 * external ProseMirror/Yjs document commit atomic; production callers should
 * use `planChangeResolution` inside their own shared Y.Doc transaction.
 */
export class InMemoryDiffChangesMetadataStore implements DiffChangesMetadataPort {
  readonly #records = new Map<string, ChangeMetadata>();

  constructor(records: Iterable<ChangeMetadata> = []) {
    for (const record of records) {
      this.set(record);
    }
  }

  get(changeId: string): ChangeMetadata | undefined {
    const record = this.#records.get(changeId);
    return record === undefined ? undefined : cloneRecord(record);
  }

  list(): readonly ChangeMetadata[] {
    return [...this.#records.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((record) => cloneRecord(record));
  }

  set(record: ChangeMetadata): void {
    validateChangeMetadata(record);
    const current = this.#records.get(record.id);
    if (current !== undefined) {
      if (immutableIdentity(current) !== immutableIdentity(record)) {
        throw new AdapterValidationError(
          'METADATA_CONFLICT',
          'A change ID cannot be reused with different immutable metadata',
        );
      }
      if (
        current.status !== 'pending' &&
        (record.status !== current.status ||
          record.resolvedAt !== current.resolvedAt ||
          record.resolvedBy !== current.resolvedBy)
      ) {
        throw new AdapterValidationError(
          'METADATA_CONFLICT',
          'Resolved change metadata is immutable',
        );
      }
    }
    this.#records.set(record.id, cloneRecord(record));
  }

  transact<T>(_origin: string, callback: () => T): T {
    const snapshot = new Map(
      [...this.#records].map(([id, record]) => [id, cloneRecord(record)] as const),
    );
    try {
      return callback();
    } catch (error) {
      this.#records.clear();
      for (const [id, record] of snapshot) {
        this.#records.set(id, record);
      }
      throw error;
    }
  }
}
