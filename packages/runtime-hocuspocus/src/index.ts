import { createHash } from 'node:crypto';

import { Hocuspocus, type DirectConnection, type Document } from '@hocuspocus/server';
import { ProsemirrorTransformer } from '@hocuspocus/transformer';
import type { Schema } from '@tiptap/pm/model';
import { Doc, XmlElement, XmlText, applyUpdate, encodeStateAsUpdate } from 'yjs';

export {
  DurableYjsIdempotencyLedger,
  type DurableYjsIdempotencyLedgerOptions,
} from './idempotency.js';
export { DurableYjsAuditSink, type DurableYjsAuditSinkOptions } from './audit.js';

export const COLLABORATION_STATE_MAP = 'editorMcpState';
export const CHANGE_METADATA_MAP = 'diffChanges';
export const MUTATION_RECEIPTS_MAP = 'editorMcpMutationReceipts';

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface RuntimeDocumentIdentity {
  readonly tenantId: string;
  readonly documentId: string;
  readonly documentIncarnation: string;
  readonly collaborationField: string;
  readonly schemaId: string;
  readonly schemaVersion: number;
}

export type TransactionOriginKind = 'agent' | 'human' | 'resolution' | 'system';

export interface TransactionContext {
  readonly kind: TransactionOriginKind;
  readonly actorId: string;
  readonly traceId: string;
}

export interface RuntimeCommitControl {
  readonly signal?: AbortSignal;
  readonly deadline?: Date;
}

export interface PersistedSnapshot {
  readonly update: Uint8Array;
  readonly storedAt: string;
  readonly sequence: number;
}

export interface PersistenceAcknowledgement {
  readonly level: 'snapshot';
  readonly sequence: number;
  readonly storedAt: string;
}

export interface YjsPersistence {
  load(documentName: string): Promise<PersistedSnapshot | undefined>;
  store(documentName: string, update: Uint8Array): Promise<PersistenceAcknowledgement>;
  /**
   * Stores only when the currently persisted sequence is the one observed by
   * the caller. An undefined expected sequence means the document must not
   * exist. Implementations must make the comparison and write atomic.
   */
  storeIfSequence(
    documentName: string,
    expectedSequence: number | undefined,
    update: Uint8Array,
  ): Promise<PersistenceAcknowledgement | undefined>;
}

export interface YjsDocumentCodec {
  read(document: Doc, identity: RuntimeDocumentIdentity): JsonObject | undefined;
  replace(document: Doc, identity: RuntimeDocumentIdentity, value: JsonObject): void;
}

/**
 * Stores ProseMirror content in the named Y.XmlFragment used by real
 * y-prosemirror clients. The semantic JSON is a projection of that
 * collaborative field, never a parallel authoritative copy.
 */
export class ProseMirrorYjsDocumentCodec implements YjsDocumentCodec {
  public constructor(private readonly schema: Schema) {}

  public read(document: Doc, identity: RuntimeDocumentIdentity): JsonObject | undefined {
    if (!document.share.has(identity.collaborationField)) {
      return undefined;
    }
    const value = ProsemirrorTransformer.fromYdoc(document, identity.collaborationField) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('The collaborative ProseMirror field is invalid');
    }
    return structuredClone(value) as JsonObject;
  }

  public replace(document: Doc, identity: RuntimeDocumentIdentity, value: JsonObject): void {
    const replacement = ProsemirrorTransformer.toYdoc(
      structuredClone(value),
      identity.collaborationField,
      this.schema,
    );
    try {
      const source = replacement.getXmlFragment(identity.collaborationField);
      const target = document.getXmlFragment(identity.collaborationField);
      if (target.length > 0) {
        target.delete(0, target.length);
      }
      target.insert(
        0,
        source
          .toArray()
          .filter(
            (child): child is XmlElement | XmlText =>
              child instanceof XmlElement || child instanceof XmlText,
          )
          .map((child) => child.clone()),
      );
    } finally {
      replacement.destroy();
    }
  }
}

export interface RuntimeDocumentState<TDocument extends JsonObject = JsonObject> {
  readonly document: TDocument;
  readonly changes: Readonly<Record<string, JsonObject>>;
  readonly mutationReceipts: Readonly<Record<string, JsonObject>>;
  readonly revision: string;
  readonly acknowledgement: PersistenceAcknowledgement;
}

export interface RuntimeMutation<TDocument extends JsonObject, TResult> {
  readonly document: TDocument;
  readonly changes: Readonly<Record<string, JsonObject>>;
  readonly mutationReceipts?: Readonly<Record<string, JsonObject>>;
  readonly finalizeMutationReceipts?: (
    committedRevision: string,
  ) => Readonly<Record<string, JsonObject>>;
  readonly result: TResult;
}

export interface RuntimeCommit<TResult> {
  readonly result: TResult;
  readonly revision: string;
  readonly acknowledgement: PersistenceAcknowledgement;
}

export interface RuntimeReplica {
  readonly document: Doc;
  flush(): Promise<PersistenceAcknowledgement | undefined>;
  disconnect(): Promise<void>;
}

export class RuntimeConflictError extends Error {
  public constructor(
    public readonly expectedRevision: string,
    public readonly actualRevision: string,
  ) {
    super('The collaborative document changed before the mutation committed');
    this.name = 'RuntimeConflictError';
  }
}

export class RuntimePersistenceError extends Error {
  public constructor(
    message: string,
    public readonly causeValue?: unknown,
  ) {
    super(message);
    this.name = 'RuntimePersistenceError';
  }
}

export class RuntimeCancellationError extends Error {
  public constructor() {
    super('The mutation was cancelled before its collaborative commit');
    this.name = 'RuntimeCancellationError';
  }
}

function cloneBytes(value: Uint8Array): Uint8Array {
  return new Uint8Array(value);
}

function cloneJson<T extends JsonValue>(value: T): T {
  return structuredClone(value);
}

function assertNonEmpty(value: string, label: string): void {
  if (value.length === 0) {
    throw new TypeError(`${label} must not be empty`);
  }
}

function assertCommitAllowed(control: RuntimeCommitControl): void {
  if (
    control.signal?.aborted === true ||
    (control.deadline !== undefined && Date.now() >= control.deadline.getTime())
  ) {
    throw new RuntimeCancellationError();
  }
}

function assertIdentity(identity: RuntimeDocumentIdentity): void {
  assertNonEmpty(identity.tenantId, 'tenantId');
  assertNonEmpty(identity.documentId, 'documentId');
  assertNonEmpty(identity.documentIncarnation, 'documentIncarnation');
  assertNonEmpty(identity.collaborationField, 'collaborationField');
  assertNonEmpty(identity.schemaId, 'schemaId');
  if (!Number.isSafeInteger(identity.schemaVersion) || identity.schemaVersion < 1) {
    throw new TypeError('schemaVersion must be a positive integer');
  }
}

function encodeNamePart(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

export function documentNameFor(identity: RuntimeDocumentIdentity): string {
  assertIdentity(identity);
  return [
    'editor-mcp',
    encodeNamePart(identity.tenantId),
    encodeNamePart(identity.documentId),
    encodeNamePart(identity.documentIncarnation),
    encodeNamePart(identity.collaborationField),
    encodeNamePart(identity.schemaId),
    String(identity.schemaVersion),
  ].join('.');
}

function canonicalRuntimeJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(canonicalRuntimeJson);
  }
  if (value !== null && typeof value === 'object') {
    const result: JsonObject = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = canonicalRuntimeJson(value[key] as JsonValue);
    }
    return result;
  }
  return value;
}

function revisionFor(
  document: Doc,
  identity: RuntimeDocumentIdentity,
  codec: YjsDocumentCodec,
): string {
  const semanticDocument = readStoredDocument(document, identity, codec);
  if (semanticDocument === undefined) {
    throw new Error('Collaborative document has no semantic state');
  }
  const revisionInput = canonicalRuntimeJson({
    document: semanticDocument,
    changes: readChanges(document),
  });
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(revisionInput), 'utf8')
    .digest('hex')}`;
}

class JsonMapDocumentCodec implements YjsDocumentCodec {
  public read(document: Doc): JsonObject | undefined {
    const value = document.getMap<JsonValue>(COLLABORATION_STATE_MAP).get('document');
    if (value === undefined) {
      return undefined;
    }
    return cloneJson(value) as JsonObject;
  }

  public replace(document: Doc, _identity: RuntimeDocumentIdentity, value: JsonObject): void {
    document.getMap<JsonValue>(COLLABORATION_STATE_MAP).set('document', cloneJson(value));
  }
}

function readStoredDocument(
  document: Doc,
  identity: RuntimeDocumentIdentity,
  codec: YjsDocumentCodec,
): JsonObject | undefined {
  const value = codec.read(document, identity);
  if (value === undefined) {
    return undefined;
  }
  return cloneJson(value);
}

function readChanges(document: Doc): Readonly<Record<string, JsonObject>> {
  const changes: Record<string, JsonObject> = {};
  for (const [key, value] of document.getMap<JsonObject>(CHANGE_METADATA_MAP).entries()) {
    changes[key] = cloneJson(value);
  }
  return changes;
}

function replaceChanges(document: Doc, changes: Readonly<Record<string, JsonObject>>): void {
  const map = document.getMap<JsonObject>(CHANGE_METADATA_MAP);
  for (const key of Array.from(map.keys())) {
    if (!(key in changes)) {
      map.delete(key);
    }
  }
  for (const [key, value] of Object.entries(changes)) {
    map.set(key, cloneJson(value));
  }
}

function readMutationReceipts(document: Doc): Readonly<Record<string, JsonObject>> {
  const receipts: Record<string, JsonObject> = {};
  for (const [key, value] of document.getMap<JsonObject>(MUTATION_RECEIPTS_MAP).entries()) {
    receipts[key] = cloneJson(value);
  }
  return receipts;
}

function replaceMutationReceipts(
  document: Doc,
  receipts: Readonly<Record<string, JsonObject>>,
): void {
  const map = document.getMap<JsonObject>(MUTATION_RECEIPTS_MAP);
  for (const key of Array.from(map.keys())) {
    if (!(key in receipts)) {
      map.delete(key);
    }
  }
  for (const [key, value] of Object.entries(receipts)) {
    map.set(key, cloneJson(value));
  }
}

class KeyedMutex {
  readonly #tails = new Map<string, Promise<void>>();

  public async run<T>(key: string, callback: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.#tails.set(key, tail);
    await previous;
    try {
      return await callback();
    } finally {
      release?.();
      if (this.#tails.get(key) === tail) {
        this.#tails.delete(key);
      }
    }
  }
}

export class MemoryYjsPersistence implements YjsPersistence {
  readonly #snapshots = new Map<string, PersistedSnapshot>();
  readonly #journal = new Map<string, readonly Uint8Array[]>();
  #nextFailure: { readonly error: unknown } | undefined;

  public failNextStore(error: unknown = new Error('Injected store failure')): void {
    this.#nextFailure = { error };
  }

  public load(documentName: string): Promise<PersistedSnapshot | undefined> {
    const snapshot = this.#snapshots.get(documentName);
    return Promise.resolve(
      snapshot === undefined
        ? undefined
        : {
            ...snapshot,
            update: cloneBytes(snapshot.update),
          },
    );
  }

  public store(documentName: string, update: Uint8Array): Promise<PersistenceAcknowledgement> {
    return Promise.resolve().then(() => {
      return this.#store(documentName, update);
    });
  }

  public storeIfSequence(
    documentName: string,
    expectedSequence: number | undefined,
    update: Uint8Array,
  ): Promise<PersistenceAcknowledgement | undefined> {
    return Promise.resolve().then(() => {
      if (this.#snapshots.get(documentName)?.sequence !== expectedSequence) {
        return undefined;
      }
      return this.#store(documentName, update);
    });
  }

  public journal(documentName: string): readonly Uint8Array[] {
    return (this.#journal.get(documentName) ?? []).map(cloneBytes);
  }

  #store(documentName: string, update: Uint8Array): PersistenceAcknowledgement {
    if (this.#nextFailure !== undefined) {
      const { error } = this.#nextFailure;
      this.#nextFailure = undefined;
      throw error instanceof Error
        ? error
        : new Error('Injected persistence failure', { cause: error });
    }

    const previous = this.#snapshots.get(documentName);
    const sequence = (previous?.sequence ?? 0) + 1;
    const storedAt = new Date().toISOString();
    const copiedUpdate = cloneBytes(update);
    this.#snapshots.set(documentName, {
      update: copiedUpdate,
      storedAt,
      sequence,
    });
    const journal = this.#journal.get(documentName) ?? [];
    this.#journal.set(documentName, [...journal, cloneBytes(update)]);
    return { level: 'snapshot', sequence, storedAt };
  }

  public clearVolatileHistory(): void {
    this.#journal.clear();
  }
}

export interface HocuspocusRuntimeOptions {
  readonly persistence: YjsPersistence;
  readonly documentCodec?: YjsDocumentCodec;
}

export class HocuspocusRuntime {
  readonly #persistence: YjsPersistence;
  readonly #documentCodec: YjsDocumentCodec;
  readonly #mutex = new KeyedMutex();
  readonly #hocuspocus: Hocuspocus<TransactionContext>;

  public constructor(options: HocuspocusRuntimeOptions) {
    this.#persistence = options.persistence;
    this.#documentCodec = options.documentCodec ?? new JsonMapDocumentCodec();
    this.#hocuspocus = new Hocuspocus<TransactionContext>({
      debounce: 0,
      maxDebounce: 0,
      unloadImmediately: true,
      onLoadDocument: async ({ documentName }) => {
        const snapshot = await this.#persistence.load(documentName);
        return snapshot?.update;
      },
      // Direct agent mutations persist before publishing to the live document.
      // This hook covers ordinary WebSocket-originated Yjs transactions, which
      // have no request-level durability acknowledgement to return.
      onStoreDocument: async ({ document, documentName, lastTransactionOrigin }) => {
        if (
          lastTransactionOrigin !== null &&
          typeof lastTransactionOrigin === 'object' &&
          'source' in lastTransactionOrigin &&
          lastTransactionOrigin.source === 'local'
        ) {
          return;
        }
        const update = encodeStateAsUpdate(document);
        const current = await this.#persistence.load(documentName);
        if (current !== undefined && Buffer.from(current.update).equals(Buffer.from(update))) {
          return;
        }
        await this.#persistence.store(documentName, update);
      },
    });
  }

  public get hocuspocus(): Hocuspocus<TransactionContext> {
    return this.#hocuspocus;
  }

  public async seed(
    identity: RuntimeDocumentIdentity,
    document: JsonObject,
    changes: Readonly<Record<string, JsonObject>> = {},
  ): Promise<PersistenceAcknowledgement> {
    const name = documentNameFor(identity);
    return this.#mutex.run(name, async () => {
      const existing = await this.#persistence.load(name);
      if (existing !== undefined) {
        throw new Error(`Document ${identity.documentId} is already seeded`);
      }
      const seed = new Doc();
      seed.transact(
        () => {
          this.#documentCodec.replace(seed, identity, cloneJson(document));
          replaceChanges(seed, changes);
        },
        { source: 'system' },
      );
      return this.#persistence.store(name, encodeStateAsUpdate(seed));
    });
  }

  public async read<TDocument extends JsonObject>(
    identity: RuntimeDocumentIdentity,
  ): Promise<RuntimeDocumentState<TDocument> | undefined> {
    const name = documentNameFor(identity);
    return this.#mutex.run(name, async () => {
      const snapshot = await this.#persistence.load(name);
      if (snapshot === undefined) {
        return undefined;
      }
      const connection = await this.#open(name, {
        kind: 'system',
        actorId: 'runtime',
        traceId: 'read',
      });
      try {
        const document = await this.#document(connection);
        const state = readStoredDocument(document, identity, this.#documentCodec) as
          TDocument | undefined;
        return state === undefined
          ? undefined
          : {
              document: state,
              changes: readChanges(document),
              mutationReceipts: readMutationReceipts(document),
              revision: revisionFor(document, identity, this.#documentCodec),
              acknowledgement: {
                level: 'snapshot',
                sequence: snapshot.sequence,
                storedAt: snapshot.storedAt,
              },
            };
      } finally {
        await connection.disconnect();
      }
    });
  }

  public async mutate<TDocument extends JsonObject, TResult>(
    identity: RuntimeDocumentIdentity,
    expectedRevision: string,
    context: TransactionContext,
    plan: (
      current: RuntimeDocumentState<TDocument>,
    ) => RuntimeMutation<TDocument, TResult> | Promise<RuntimeMutation<TDocument, TResult>>,
    control: RuntimeCommitControl = {},
  ): Promise<RuntimeCommit<TResult>> {
    const name = documentNameFor(identity);
    return this.#mutex.run(name, async () => {
      assertCommitAllowed(control);
      const persistedBefore = await this.#persistence.load(name);
      if (persistedBefore === undefined) {
        throw new Error(`Document ${identity.documentId} is not registered`);
      }
      const connection = await this.#open(name, context);
      try {
        assertCommitAllowed(control);
        const live = await this.#document(connection);
        const beforeDocument = readStoredDocument(live, identity, this.#documentCodec) as
          TDocument | undefined;
        if (beforeDocument === undefined) {
          throw new Error('Collaborative document has no semantic state');
        }
        const beforeChanges = readChanges(live);
        const beforeMutationReceipts = readMutationReceipts(live);
        const beforeRevision = revisionFor(live, identity, this.#documentCodec);
        if (expectedRevision !== beforeRevision) {
          throw new RuntimeConflictError(expectedRevision, beforeRevision);
        }

        const mutation = await plan({
          document: beforeDocument,
          changes: beforeChanges,
          mutationReceipts: beforeMutationReceipts,
          revision: beforeRevision,
          acknowledgement: {
            level: 'snapshot',
            sequence: persistedBefore.sequence,
            storedAt: persistedBefore.storedAt,
          },
        });
        assertCommitAllowed(control);
        const nextDocument = cloneJson(mutation.document);
        const nextChanges = cloneJson(mutation.changes);
        if (
          mutation.mutationReceipts !== undefined &&
          mutation.finalizeMutationReceipts !== undefined
        ) {
          throw new TypeError('A runtime mutation must use one mutation-receipt source');
        }

        const staged = new Doc();
        applyUpdate(staged, encodeStateAsUpdate(live));
        staged.transact(() => {
          this.#documentCodec.replace(staged, identity, nextDocument);
          replaceChanges(staged, nextChanges);
        });
        const stagedRevision = revisionFor(staged, identity, this.#documentCodec);
        const nextMutationReceipts = cloneJson(
          mutation.finalizeMutationReceipts?.(stagedRevision) ??
            mutation.mutationReceipts ??
            beforeMutationReceipts,
        );
        staged.transact(() => {
          replaceMutationReceipts(staged, nextMutationReceipts);
        });

        let acknowledgement: PersistenceAcknowledgement;
        try {
          const stored = await this.#persistence.storeIfSequence(
            name,
            persistedBefore.sequence,
            encodeStateAsUpdate(staged),
          );
          if (stored === undefined) {
            throw new RuntimeConflictError(
              beforeRevision,
              revisionFor(live, identity, this.#documentCodec),
            );
          }
          acknowledgement = stored;
        } catch (error) {
          if (error instanceof RuntimeConflictError) {
            throw error;
          }
          throw new RuntimePersistenceError(
            'The mutation was not published because persistence failed',
            error,
          );
        }

        try {
          assertCommitAllowed(control);
          await connection.transact((transactionDocument: Document) => {
            assertCommitAllowed(control);
            const actualRevision = revisionFor(transactionDocument, identity, this.#documentCodec);
            if (actualRevision !== beforeRevision) {
              throw new RuntimeConflictError(beforeRevision, actualRevision);
            }
            applyUpdate(transactionDocument, encodeStateAsUpdate(staged));
          });
        } catch (error) {
          // The staged snapshot was never acknowledged to the caller. Restore
          // persistence to the current live state before reporting a conflict.
          try {
            const restored = await this.#persistence.storeIfSequence(
              name,
              acknowledgement.sequence,
              encodeStateAsUpdate(live),
            );
            if (restored === undefined) {
              throw new Error('The staged persistence sequence was superseded', {
                cause: error,
              });
            }
          } catch (restoreError) {
            throw new RuntimePersistenceError(
              'The staged mutation conflicted and persistence recovery failed',
              restoreError,
            );
          }
          throw error;
        }

        return {
          result: mutation.result,
          revision: revisionFor(live, identity, this.#documentCodec),
          acknowledgement,
        };
      } finally {
        await connection.disconnect();
      }
    });
  }

  public async encodeLiveState(identity: RuntimeDocumentIdentity): Promise<Uint8Array | undefined> {
    const name = documentNameFor(identity);
    return this.#mutex.run(name, async () => {
      if ((await this.#persistence.load(name)) === undefined) {
        return undefined;
      }
      const connection = await this.#open(name, {
        kind: 'system',
        actorId: 'runtime',
        traceId: 'snapshot',
      });
      try {
        return encodeStateAsUpdate(await this.#document(connection));
      } finally {
        await connection.disconnect();
      }
    });
  }

  public async unload(identity: RuntimeDocumentIdentity): Promise<void> {
    const name = documentNameFor(identity);
    const document = this.#hocuspocus.documents.get(name);
    if (document !== undefined) {
      await this.#hocuspocus.unloadDocument(document);
    }
  }

  public async replica(identity: RuntimeDocumentIdentity): Promise<Doc | undefined> {
    const update = await this.encodeLiveState(identity);
    if (update === undefined) {
      return undefined;
    }
    const replica = new Doc();
    applyUpdate(replica, update);
    return replica;
  }

  public async connectReplica(
    identity: RuntimeDocumentIdentity,
    context: TransactionContext,
  ): Promise<RuntimeReplica | undefined> {
    const name = documentNameFor(identity);
    if ((await this.#persistence.load(name)) === undefined) {
      return undefined;
    }
    const connection = await this.#open(name, context);
    const live = await this.#document(connection);
    const replica = new Doc();
    const fromLive = Symbol('editor-mcp-live-update');
    const fromReplica = Symbol('editor-mcp-replica-update');
    applyUpdate(replica, encodeStateAsUpdate(live), fromLive);

    let pending: Promise<PersistenceAcknowledgement | undefined> = Promise.resolve(undefined);
    let disconnected = false;
    const liveUpdate = (update: Uint8Array, origin: unknown): void => {
      if (origin !== fromReplica && !disconnected) {
        applyUpdate(replica, update, fromLive);
      }
    };
    const replicaUpdate = (update: Uint8Array, origin: unknown): void => {
      if (origin === fromLive || disconnected) {
        return;
      }
      pending = pending
        .catch(() => undefined)
        .then(() =>
          this.#mutex.run(name, async () => {
            const persistedBefore = await this.#persistence.load(name);
            if (persistedBefore === undefined) {
              throw new RuntimePersistenceError(
                'The replica update targeted an unregistered document',
              );
            }
            const staged = new Doc();
            applyUpdate(staged, encodeStateAsUpdate(live));
            applyUpdate(staged, update, fromReplica);
            let acknowledgement: PersistenceAcknowledgement;
            try {
              const stored = await this.#persistence.storeIfSequence(
                name,
                persistedBefore.sequence,
                encodeStateAsUpdate(staged),
              );
              if (stored === undefined) {
                throw new RuntimeConflictError(
                  revisionFor(live, identity, this.#documentCodec),
                  revisionFor(staged, identity, this.#documentCodec),
                );
              }
              acknowledgement = stored;
            } catch (error) {
              if (error instanceof RuntimeConflictError) {
                throw error;
              }
              throw new RuntimePersistenceError(
                'The replica update was not published because persistence failed',
                error,
              );
            }
            try {
              await connection.transact((transactionDocument) => {
                applyUpdate(transactionDocument, update, fromReplica);
              });
            } catch (error) {
              const restored = await this.#persistence.storeIfSequence(
                name,
                acknowledgement.sequence,
                encodeStateAsUpdate(live),
              );
              if (restored === undefined) {
                throw new RuntimePersistenceError(
                  'The replica update failed and persistence recovery was superseded',
                  error,
                );
              }
              throw error;
            }
            return acknowledgement;
          }),
        );
    };
    live.on('update', liveUpdate);
    replica.on('update', replicaUpdate);

    return {
      document: replica,
      flush: () => pending,
      disconnect: async () => {
        if (disconnected) {
          return;
        }
        let failure: unknown;
        try {
          await pending;
        } catch (error) {
          failure = error;
        } finally {
          disconnected = true;
          live.off('update', liveUpdate);
          replica.off('update', replicaUpdate);
          await connection.disconnect();
          replica.destroy();
        }
        if (failure !== undefined) {
          throw failure instanceof Error
            ? failure
            : new Error('Replica persistence failed', { cause: failure });
        }
      },
    };
  }

  async #open(name: string, context: TransactionContext): Promise<DirectConnection> {
    return this.#hocuspocus.openDirectConnection(name, context);
  }

  async #document(connection: DirectConnection): Promise<Document> {
    let result: Document | undefined;
    await connection.transact((document) => {
      result = document;
    });
    if (result === undefined) {
      throw new Error('Direct connection did not expose a document');
    }
    return result;
  }
}
