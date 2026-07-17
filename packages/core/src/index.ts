import { createHash, randomUUID } from 'node:crypto';

import {
  MVP_OPERATION_KINDS,
  MVP_REVIEW_MODES,
  MVP_SCHEMA_ID,
  MVP_SCHEMA_VERSION,
  applyEditsRequestSchema,
  documentReadRequestSchema,
  type ApplyEditsRequest,
  type ApplyEditsResult as ProtocolApplyEditsResult,
  type AuditEvent as ProtocolAuditEvent,
  type AuditTargetPrecondition,
  type DocumentReadRequest,
  type DocumentReadResult,
  type DocumentReadResultV1,
  type EditConflict,
  type EditOperation,
  type OperationResult,
  type PersistenceAcknowledgement,
} from '@editor-mcp/protocol';
import { z } from 'zod';

export type {
  ApplyEditsRequest,
  DocumentReadRequest,
  DocumentReadResult,
  DocumentReadResultV1,
  EditOperation,
} from '@editor-mcp/protocol';

export type ApplyEditsResult = ProtocolApplyEditsResult;

export const domainErrorCodes = [
  'INVALID_REQUEST',
  'UNAUTHENTICATED',
  'PERMISSION_DENIED',
  'DOCUMENT_NOT_FOUND',
  'DOCUMENT_INCARNATION_MISMATCH',
  'SCHEMA_VERSION_MISMATCH',
  'TARGET_NOT_FOUND',
  'TARGET_AMBIGUOUS',
  'TARGET_CHANGED',
  'INVALID_CONTENT',
  'UNSUPPORTED_CONTENT',
  'PATCH_TOO_LARGE',
  'IDEMPOTENCY_MISMATCH',
  'DOCUMENT_UNAVAILABLE',
  'DEADLINE_EXCEEDED',
  'INTERNAL',
] as const;

export type DomainErrorCode = (typeof domainErrorCodes)[number];

export type SafeErrorDetails = Readonly<Record<string, boolean | number | string | undefined>>;

export class DomainError extends Error {
  public constructor(
    public readonly code: DomainErrorCode,
    message: string,
    public readonly retryable: boolean,
    public readonly details?: SafeErrorDetails,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'DomainError';
  }
}

export interface ErrorEnvelope {
  readonly version: 1;
  readonly error: {
    readonly code: DomainErrorCode;
    readonly message: string;
    readonly retryable: boolean;
    readonly details?: SafeErrorDetails;
  };
}

export function toErrorEnvelope(error: unknown): ErrorEnvelope {
  const domainError =
    error instanceof DomainError
      ? error
      : new DomainError(
          'INTERNAL',
          'The document operation could not be completed',
          false,
          undefined,
          { cause: error },
        );
  return {
    version: 1,
    error: {
      code: domainError.code,
      message: domainError.message,
      retryable: domainError.retryable,
      ...(domainError.details === undefined ? {} : { details: domainError.details }),
    },
  };
}

export interface DocumentIdentity {
  readonly tenantId: string;
  readonly documentId: string;
  readonly documentIncarnation: string;
  readonly collaborationField: string;
  readonly schemaId: typeof MVP_SCHEMA_ID;
  readonly schemaVersion: typeof MVP_SCHEMA_VERSION;
}

export const permissions = [
  'documents:read',
  'documents:suggest',
  'documents:write',
  'suggestions:review',
  'comments:read',
  'comments:write',
] as const;

export type Permission = (typeof permissions)[number];

export interface AuthorizationContext {
  readonly tenantId: string;
  readonly principalId: string;
  readonly principalType: 'agent' | 'human' | 'service';
  readonly permissions: ReadonlySet<Permission>;
  readonly agentRunId?: string;
  readonly traceId: string;
}

/**
 * Agent principals may only submit reviewable suggestions. Direct mutations
 * are reserved for human and service principals; this guard is intentionally
 * independent of the configured permission policy so a permissive custom
 * policy cannot grant agents an unsafe mode.
 */
export function assertChangeModeAllowed(
  changeMode: ApplyEditsRequest['changeMode'],
  authorization: Pick<AuthorizationContext, 'principalType'>,
): void {
  if (changeMode === 'direct' && authorization.principalType === 'agent') {
    throw new DomainError(
      'PERMISSION_DENIED',
      'Agent principals may only submit suggested edits',
      false,
    );
  }
}

export interface RequestControl {
  readonly signal?: AbortSignal | undefined;
  readonly deadline?: Date | undefined;
}

export interface ReadDocumentQuery {
  readonly documentId: string;
  readonly documentIncarnation: string;
  readonly collaborationField?: string | undefined;
  readonly schemaId: typeof MVP_SCHEMA_ID;
  readonly schemaVersion: typeof MVP_SCHEMA_VERSION;
  readonly blockIds?: readonly string[] | undefined;
  readonly maxBlocks?: number | undefined;
}

export interface ReadContext extends RequestControl {
  readonly authorization: AuthorizationContext;
}

export interface ApplyContext extends RequestControl {
  readonly authorization: AuthorizationContext;
}

export interface AuthorizationInput {
  readonly action: 'document.read' | 'document.suggest' | 'document.write' | 'suggestion.review';
  readonly identity: DocumentIdentity;
  readonly authorization: AuthorizationContext;
}

export interface AuthorizationDecision {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly policyVersion: string;
}

export interface AuthorizationPolicy {
  authorize(input: AuthorizationInput): Promise<AuthorizationDecision>;
}

export interface OperationPolicyInput {
  readonly identity: DocumentIdentity;
  readonly request: ApplyEditsRequest;
  readonly operation: EditOperation;
  readonly authorization: AuthorizationContext;
}

export interface OperationPolicy {
  authorizeOperation(input: OperationPolicyInput): Promise<AuthorizationDecision>;
}

export interface DocumentReadPort {
  readDocument(
    identity: DocumentIdentity,
    query: ReadDocumentQuery,
    context: ReadContext,
  ): Promise<DocumentReadResult | undefined>;
  readDocumentV1?(
    identity: DocumentIdentity,
    request: DocumentReadRequest,
    context: ReadContext,
  ): Promise<DocumentReadResultV1 | undefined>;
}

export interface ConflictRecovery {
  readonly code:
    | 'DOCUMENT_INCARNATION_MISMATCH'
    | 'SCHEMA_VERSION_MISMATCH'
    | 'TARGET_AMBIGUOUS'
    | 'TARGET_CHANGED'
    | 'TARGET_NOT_FOUND';
  readonly operationId?: string;
  readonly targetId?: string;
  readonly currentDigest?: string;
  readonly currentRevision?: string;
  readonly retryHint: 'do_not_retry' | 'reread_document' | 'reread_target';
}

export interface PersistenceAck {
  readonly level: 'journal' | 'snapshot' | 'replicated';
  readonly sequence?: number;
  readonly storedAt: string;
}

export interface MutationOutcome {
  readonly status: 'applied' | 'conflict';
  /**
   * Set when the document's atomic mutation receipt proves this request
   * already committed even though the outer idempotency receipt was missing.
   */
  readonly idempotentReplay?: boolean;
  readonly beforeRevision: string;
  readonly revision: string;
  readonly changeSetId?: string;
  readonly createdBlockIds: readonly string[];
  readonly affectedBlockIds: readonly string[];
  readonly changeIds: readonly string[];
  readonly conflicts: readonly ConflictRecovery[];
  readonly acknowledgement?: PersistenceAck;
}

export interface DocumentMutationPort {
  applyAtomic(
    identity: DocumentIdentity,
    request: ApplyEditsRequest,
    context: ApplyContext,
  ): Promise<MutationOutcome>;
}

export interface IdempotencyScope {
  readonly tenantId: string;
  readonly principalId: string;
  readonly documentId: string;
  readonly documentIncarnation: string;
  readonly collaborationField: string;
  readonly schemaId: string;
  readonly schemaVersion: number;
  readonly key: string;
}

export interface IdempotencyReceipt {
  readonly requestHash: string;
  readonly beforeRevision?: string;
  readonly afterRevision: string;
  readonly changeSetId?: string;
  readonly result: ProtocolApplyEditsResult;
  readonly completedAt: string;
  /**
   * Durable outbox copy. A production ledger persists this with the receipt,
   * so a transient audit-sink failure cannot make an acknowledged document
   * mutation unsafe to replay.
   */
  readonly queuedAudit?: AuditEnvelope;
}

export type IdempotencyClaim =
  | {
      readonly kind: 'claimed';
      readonly leaseId: string;
    }
  | {
      readonly kind: 'replay';
      readonly receipt: IdempotencyReceipt;
    }
  | {
      readonly kind: 'wait';
      readonly receipt: Promise<IdempotencyReceipt>;
    }
  | {
      readonly kind: 'mismatch';
    };

export interface IdempotencyLedger {
  claim(scope: IdempotencyScope, requestHash: string): Promise<IdempotencyClaim>;
  complete(scope: IdempotencyScope, leaseId: string, receipt: IdempotencyReceipt): Promise<void>;
  abort(scope: IdempotencyScope, leaseId: string, error: unknown): Promise<void>;
}

export type AuditEnvelope = ProtocolAuditEvent;

export interface AuditSink {
  append(event: AuditEnvelope): Promise<void>;
}

interface PendingEntry {
  readonly state: 'pending';
  readonly requestHash: string;
  readonly leaseId: string;
  readonly promise: Promise<IdempotencyReceipt>;
  readonly resolve: (receipt: IdempotencyReceipt) => void;
  readonly reject: (error: unknown) => void;
}

interface CompleteEntry {
  readonly state: 'complete';
  readonly requestHash: string;
  readonly receipt: IdempotencyReceipt;
}

type LedgerEntry = CompleteEntry | PendingEntry;

function scopeKey(scope: IdempotencyScope): string {
  return [
    scope.tenantId,
    scope.principalId,
    scope.documentId,
    scope.documentIncarnation,
    scope.collaborationField,
    scope.schemaId,
    String(scope.schemaVersion),
    scope.key,
  ]
    .map((part) => `${String(part.length)}:${part}`)
    .join('|');
}

export class MemoryIdempotencyLedger implements IdempotencyLedger {
  readonly #entries = new Map<string, LedgerEntry>();

  public claim(scope: IdempotencyScope, requestHash: string): Promise<IdempotencyClaim> {
    return Promise.resolve().then(() => {
      const key = scopeKey(scope);
      const entry = this.#entries.get(key);
      if (entry !== undefined) {
        if (entry.requestHash !== requestHash) {
          return { kind: 'mismatch' };
        }
        return entry.state === 'complete'
          ? { kind: 'replay', receipt: structuredClone(entry.receipt) }
          : { kind: 'wait', receipt: entry.promise };
      }

      let resolve: ((receipt: IdempotencyReceipt) => void) | undefined;
      let reject: ((error: unknown) => void) | undefined;
      const promise = new Promise<IdempotencyReceipt>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      // A claim may have no concurrent waiter. Attach a handler now so aborting
      // it cannot create an unhandled rejection.
      void promise.catch(() => undefined);
      const leaseId = randomUUID();
      this.#entries.set(key, {
        state: 'pending',
        requestHash,
        leaseId,
        promise,
        resolve: resolve as (receipt: IdempotencyReceipt) => void,
        reject: reject as (error: unknown) => void,
      });
      return { kind: 'claimed', leaseId };
    });
  }

  public complete(
    scope: IdempotencyScope,
    leaseId: string,
    receipt: IdempotencyReceipt,
  ): Promise<void> {
    return Promise.resolve().then(() => {
      const key = scopeKey(scope);
      const entry = this.#entries.get(key);
      if (entry?.state !== 'pending' || entry.leaseId !== leaseId) {
        throw new Error('Idempotency lease is no longer active');
      }
      const copiedReceipt = structuredClone(receipt);
      this.#entries.set(key, {
        state: 'complete',
        requestHash: entry.requestHash,
        receipt: copiedReceipt,
      });
      entry.resolve(structuredClone(copiedReceipt));
    });
  }

  public abort(scope: IdempotencyScope, leaseId: string, error: unknown): Promise<void> {
    return Promise.resolve().then(() => {
      const key = scopeKey(scope);
      const entry = this.#entries.get(key);
      if (entry?.state === 'pending' && entry.leaseId === leaseId) {
        this.#entries.delete(key);
        entry.reject(error);
      }
    });
  }
}

export class MemoryAuditSink implements AuditSink {
  readonly #events = new Map<string, AuditEnvelope>();

  public append(event: AuditEnvelope): Promise<void> {
    return Promise.resolve().then(() => {
      const existing = this.#events.get(event.auditEventId);
      if (existing !== undefined) {
        if (canonicalJson(existing) !== canonicalJson(event)) {
          throw new Error('Audit event ID was reused with different content');
        }
        return;
      }
      this.#events.set(event.auditEventId, structuredClone(event));
    });
  }

  public events(): readonly AuditEnvelope[] {
    return structuredClone([...this.#events.values()]);
  }
}

export class PermissionAuthorizationPolicy implements AuthorizationPolicy {
  public authorize(input: AuthorizationInput): Promise<AuthorizationDecision> {
    const required: Permission =
      input.action === 'document.read'
        ? 'documents:read'
        : input.action === 'document.suggest'
          ? 'documents:suggest'
          : input.action === 'document.write'
            ? 'documents:write'
            : 'suggestions:review';
    return Promise.resolve({
      allowed:
        input.authorization.tenantId === input.identity.tenantId &&
        input.authorization.permissions.has(required),
      policyVersion: 'permissions/v1',
      reason: `requires ${required}`,
    });
  }
}

export class AllowAllOperationPolicy implements OperationPolicy {
  public authorizeOperation(): Promise<AuthorizationDecision> {
    return Promise.resolve({ allowed: true, policyVersion: 'allow-all/v1' });
  }
}

export interface EditorServiceOptions {
  readonly documents: DocumentReadPort & DocumentMutationPort;
  readonly authorization: AuthorizationPolicy;
  readonly operationPolicy?: OperationPolicy;
  readonly idempotency: IdempotencyLedger;
  readonly audit: AuditSink;
  readonly now?: () => Date;
}

function checkControl(control: RequestControl): void {
  if (control.signal?.aborted === true) {
    throw new DomainError('DEADLINE_EXCEEDED', 'The operation was cancelled before commit', true);
  }
  if (control.deadline !== undefined && control.deadline.getTime() <= Date.now()) {
    throw new DomainError(
      'DEADLINE_EXCEEDED',
      'The operation deadline elapsed before commit',
      true,
    );
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  const visit = (current: unknown): string => {
    if (current === null) {
      return 'null';
    }
    if (typeof current === 'string' || typeof current === 'boolean') {
      return JSON.stringify(current);
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) {
        throw new TypeError('Canonical JSON does not support non-finite numbers');
      }
      return JSON.stringify(current);
    }
    if (Array.isArray(current)) {
      if (seen.has(current)) {
        throw new TypeError('Canonical JSON does not support cycles');
      }
      seen.add(current);
      const result = `[${current.map(visit).join(',')}]`;
      seen.delete(current);
      return result;
    }
    if (isJsonObject(current)) {
      if (seen.has(current)) {
        throw new TypeError('Canonical JSON does not support cycles');
      }
      seen.add(current);
      const entries = Object.entries(current)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => `${JSON.stringify(key)}:${visit(entryValue)}`);
      seen.delete(current);
      return `{${entries.join(',')}}`;
    }
    throw new TypeError(`Canonical JSON does not support values of type ${typeof current}`);
  };
  return visit(value);
}

export function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function identityFor(
  request: Pick<
    ApplyEditsRequest,
    | 'collaborationField'
    | 'documentId'
    | 'documentIncarnation'
    | 'schemaId'
    | 'schemaVersion'
    | 'tenantId'
  >,
  authorization: AuthorizationContext,
): DocumentIdentity {
  return {
    tenantId: request.tenantId ?? authorization.tenantId,
    documentId: request.documentId,
    documentIncarnation: request.documentIncarnation,
    collaborationField: request.collaborationField ?? 'default',
    schemaId: request.schemaId,
    schemaVersion: request.schemaVersion,
  };
}

function actionsFor(request: ApplyEditsRequest): readonly AuthorizationInput['action'][] {
  const actions = new Set<AuthorizationInput['action']>();
  for (const operation of request.operations) {
    if (operation.kind === 'accept_change' || operation.kind === 'reject_change') {
      actions.add('suggestion.review');
    } else {
      actions.add(request.changeMode === 'direct' ? 'document.write' : 'document.suggest');
    }
  }
  return [...actions];
}

function auditTargetFor(operation: EditOperation): AuditTargetPrecondition {
  const base = {
    operationId: operation.operationId,
    operationKind: operation.kind,
  } as const;
  switch (operation.kind) {
    case 'insert_before':
    case 'insert_after':
      return {
        ...base,
        targetType: 'block',
        targetReference: operation.anchorBlockId,
        ...(operation.expectedAnchorDigest === undefined
          ? {}
          : { expectedDigest: operation.expectedAnchorDigest }),
      };
    case 'replace_block':
    case 'delete_block':
    case 'insert_text':
    case 'delete_text':
    case 'replace_text':
    case 'format_text':
      return {
        ...base,
        targetType: 'block',
        targetReference: operation.blockId,
        expectedDigest: operation.expectedBlockDigest,
      };
    case 'insert_table_row':
    case 'delete_table_row':
    case 'insert_table_column':
    case 'delete_table_column':
      return {
        ...base,
        targetType: 'table',
        targetReference: operation.tableId,
        expectedDigest: operation.expectedTableDigest,
      };
    case 'accept_change':
    case 'reject_change':
      return {
        ...base,
        targetType: 'change',
        targetReference: operation.changeId,
        ...(operation.expectedChangeRevision === undefined
          ? {}
          : { expectedDigest: operation.expectedChangeRevision }),
      };
  }
}

function replayResult(receipt: IdempotencyReceipt): ProtocolApplyEditsResult {
  const stored = structuredClone(receipt.result);
  if (stored.status !== 'applied' && stored.status !== 'duplicate') {
    return {
      ...stored,
      idempotentReplay: true,
    };
  }
  return {
    ...stored,
    status: 'duplicate',
    idempotentReplay: true,
    operationResults: stored.operationResults.map((result) => ({
      operationId: result.operationId,
      status: 'replayed',
      affectedBlockIds: result.affectedBlockIds,
      createdBlockIds: result.createdBlockIds,
      generatedChangeIds: result.generatedChangeIds,
    })),
  };
}

function protocolConflict(conflict: ConflictRecovery, fallbackRevision: string): EditConflict {
  const targetType =
    conflict.code === 'SCHEMA_VERSION_MISMATCH' || conflict.code === 'DOCUMENT_INCARNATION_MISMATCH'
      ? 'document'
      : 'block';
  return {
    protocolVersion: 1,
    code: conflict.code,
    ...(conflict.operationId === undefined ? {} : { operationId: conflict.operationId }),
    ...(conflict.targetId === undefined
      ? {}
      : {
          target: {
            targetType,
            targetId: conflict.targetId,
            ...(conflict.currentDigest === undefined
              ? {}
              : { currentDigest: conflict.currentDigest }),
          },
        }),
    message:
      conflict.code === 'TARGET_CHANGED'
        ? 'The semantic target changed after it was read'
        : 'The semantic target could not be resolved',
    recovery: {
      action: conflict.retryHint,
      currentRevision: conflict.currentRevision ?? fallbackRevision,
    },
  };
}

function acknowledgement(
  status: MutationOutcome['status'],
  outcome: MutationOutcome,
  acknowledgedAt: string,
): PersistenceAcknowledgement {
  if (status === 'conflict') {
    return {
      protocolVersion: 1,
      level: 'none',
      idempotencyReceiptDurable: false,
      documentStateDurable: false,
      auditDurableOrQueued: false,
      acknowledgedAt,
    };
  }
  return {
    protocolVersion: 1,
    level: 'document_and_audit',
    idempotencyReceiptDurable: true,
    documentStateDurable: true,
    auditDurableOrQueued: true,
    acknowledgedAt,
    persistenceRevision: outcome.revision,
  };
}

function operationResults(
  request: ApplyEditsRequest,
  outcome: MutationOutcome,
  conflicts: readonly EditConflict[],
): readonly OperationResult[] {
  return request.operations.map((operation) => {
    if (outcome.status === 'applied') {
      return {
        operationId: operation.operationId,
        status: outcome.idempotentReplay === true ? 'replayed' : 'applied',
        affectedBlockIds: [...outcome.affectedBlockIds],
        createdBlockIds: [...outcome.createdBlockIds],
        generatedChangeIds: [...outcome.changeIds],
      };
    }
    const matching =
      conflicts.find((conflict) => conflict.operationId === operation.operationId) ?? conflicts[0];
    if (matching === undefined) {
      throw new DomainError('INTERNAL', 'A conflict result is missing conflict metadata', false);
    }
    return {
      operationId: operation.operationId,
      status: 'conflict',
      affectedBlockIds: [],
      createdBlockIds: [],
      generatedChangeIds: [],
      conflict: {
        ...matching,
        operationId: operation.operationId,
      },
    };
  });
}

export class EditorService {
  readonly #documents: DocumentReadPort & DocumentMutationPort;
  readonly #authorization: AuthorizationPolicy;
  readonly #operationPolicy: OperationPolicy;
  readonly #idempotency: IdempotencyLedger;
  readonly #audit: AuditSink;
  readonly #now: () => Date;

  public constructor(options: EditorServiceOptions) {
    this.#documents = options.documents;
    this.#authorization = options.authorization;
    this.#operationPolicy = options.operationPolicy ?? new AllowAllOperationPolicy();
    this.#idempotency = options.idempotency;
    this.#audit = options.audit;
    this.#now = options.now ?? (() => new Date());
  }

  public async readDocument(
    query: ReadDocumentQuery,
    context: ReadContext,
  ): Promise<DocumentReadResult> {
    checkControl(context);
    const identity: DocumentIdentity = {
      tenantId: context.authorization.tenantId,
      documentId: query.documentId,
      documentIncarnation: query.documentIncarnation,
      collaborationField: query.collaborationField ?? 'default',
      schemaId: query.schemaId,
      schemaVersion: query.schemaVersion,
    };
    await this.#requireAuthorization('document.read', identity, context.authorization);
    checkControl(context);
    const result = await this.#documents.readDocument(identity, query, context);
    if (result === undefined) {
      throw new DomainError('DOCUMENT_NOT_FOUND', 'The requested document was not found', false);
    }
    return result;
  }

  public async readDocumentV1(input: unknown, context: ReadContext): Promise<DocumentReadResultV1> {
    checkControl(context);
    const parsed = documentReadRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new DomainError(
        'INVALID_REQUEST',
        'The versioned document read request is invalid',
        false,
        { issueCount: parsed.error.issues.length },
        { cause: parsed.error },
      );
    }
    const request = parsed.data;
    const identity: DocumentIdentity = {
      tenantId: request.tenantId,
      documentId: request.documentId,
      documentIncarnation: request.documentIncarnation,
      collaborationField: request.collaborationField,
      schemaId: request.schemaId,
      schemaVersion: request.schemaVersion,
    };
    await this.#requireAuthorization('document.read', identity, context.authorization);
    checkControl(context);

    if (this.#documents.readDocumentV1 !== undefined) {
      const result = await this.#documents.readDocumentV1(identity, request, context);
      if (result === undefined) {
        throw new DomainError('DOCUMENT_NOT_FOUND', 'The requested document was not found', false);
      }
      return result;
    }

    if (request.representationProfile !== 'agent-html/v1') {
      throw new DomainError(
        'UNSUPPORTED_CONTENT',
        'This document adapter only supports the agent HTML read projection',
        false,
      );
    }
    const legacy = await this.#documents.readDocument(
      identity,
      {
        documentId: identity.documentId,
        documentIncarnation: identity.documentIncarnation,
        collaborationField: identity.collaborationField,
        schemaId: identity.schemaId,
        schemaVersion: identity.schemaVersion,
        ...(request.selection.kind === 'blocks' ? { blockIds: request.selection.blockIds } : {}),
      },
      context,
    );
    if (legacy === undefined) {
      throw new DomainError('DOCUMENT_NOT_FOUND', 'The requested document was not found', false);
    }
    const result: DocumentReadResultV1 = {
      protocolVersion: 1,
      ...identity,
      revision: legacy.revision,
      capabilities: {
        reviewModes: [...MVP_REVIEW_MODES],
        operations: [...MVP_OPERATION_KINDS],
        representationProfiles: ['agent-html/v1'],
      },
      representation: {
        profile: 'agent-html/v1',
        html: legacy.html,
      },
      blocks: legacy.blocks,
      truncated: false,
    };
    if (
      request.maxBytes !== undefined &&
      Buffer.byteLength(JSON.stringify(result), 'utf8') > request.maxBytes
    ) {
      throw new DomainError(
        'PATCH_TOO_LARGE',
        'The requested read projection exceeds maxBytes',
        false,
        { maxBytes: request.maxBytes },
      );
    }
    return result;
  }

  public async applyEdits(input: unknown, context: ApplyContext): Promise<ApplyEditsResult> {
    checkControl(context);
    const parsed = applyEditsRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new DomainError(
        'INVALID_REQUEST',
        'The edit request is invalid',
        false,
        { issueCount: parsed.error.issues.length },
        { cause: parsed.error },
      );
    }
    const request = parsed.data;
    assertChangeModeAllowed(request.changeMode, context.authorization);
    const identity = identityFor(request, context.authorization);
    const authorizationDecisions: AuthorizationDecision[] = [];
    for (const action of actionsFor(request)) {
      authorizationDecisions.push(
        await this.#requireAuthorization(action, identity, context.authorization),
      );
    }
    for (const operation of request.operations) {
      const decision = await this.#operationPolicy.authorizeOperation({
        identity,
        request,
        operation,
        authorization: context.authorization,
      });
      if (!decision.allowed) {
        throw new DomainError(
          'PERMISSION_DENIED',
          'An operation is not allowed by document policy',
          false,
          { operationId: operation.operationId },
        );
      }
    }
    const authorizationDecision = authorizationDecisions[0];
    if (authorizationDecision === undefined) {
      throw new DomainError('INTERNAL', 'The authorization decision was not recorded', false);
    }
    checkControl(context);

    const requestHash = sha256(canonicalJson(request));
    const scope: IdempotencyScope = {
      tenantId: identity.tenantId,
      principalId: context.authorization.principalId,
      documentId: identity.documentId,
      documentIncarnation: identity.documentIncarnation,
      collaborationField: identity.collaborationField,
      schemaId: identity.schemaId,
      schemaVersion: identity.schemaVersion,
      key: request.idempotencyKey,
    };
    const claim = await this.#idempotency.claim(scope, requestHash);
    if (claim.kind === 'mismatch') {
      throw new DomainError(
        'IDEMPOTENCY_MISMATCH',
        'The idempotency key was already used for a different request',
        false,
      );
    }
    if (claim.kind === 'replay') {
      await this.#deliverQueuedAudit(claim.receipt);
      return replayResult(claim.receipt);
    }
    if (claim.kind === 'wait') {
      const receipt = await claim.receipt;
      await this.#deliverQueuedAudit(receipt);
      return replayResult(receipt);
    }

    let semanticCommitDurable = false;
    try {
      checkControl(context);
      const outcome = await this.#documents.applyAtomic(identity, request, context);
      semanticCommitDurable = outcome.status === 'applied';
      if (outcome.status === 'applied' && outcome.acknowledgement === undefined) {
        throw new DomainError(
          'DOCUMENT_UNAVAILABLE',
          'The mutation did not reach a durable persistence boundary',
          true,
        );
      }
      const completedAt = this.#now().toISOString();
      const conflicts = outcome.conflicts.map((conflict) =>
        protocolConflict(conflict, outcome.beforeRevision),
      );
      const idempotentReplay = outcome.idempotentReplay === true;
      const result: ProtocolApplyEditsResult = {
        protocolVersion: 1,
        tenantId: identity.tenantId,
        documentId: identity.documentId,
        documentIncarnation: identity.documentIncarnation,
        collaborationField: identity.collaborationField,
        schemaId: identity.schemaId,
        schemaVersion: identity.schemaVersion,
        status: idempotentReplay ? 'duplicate' : outcome.status,
        beforeRevision: outcome.beforeRevision,
        ...(outcome.status === 'applied' ? { committedRevision: outcome.revision } : {}),
        ...(outcome.status !== 'applied' || outcome.changeSetId === undefined
          ? {}
          : { changeSetId: outcome.changeSetId }),
        idempotentReplay,
        createdBlockIds: [...outcome.createdBlockIds],
        affectedBlockIds: [...outcome.affectedBlockIds],
        generatedChangeIds: [...outcome.changeIds],
        operationResults: operationResults(request, outcome, conflicts),
        conflicts,
        acknowledgement: acknowledgement(outcome.status, outcome, completedAt),
      };
      const authorizationReason = authorizationDecision.reason?.trim();
      const auditEvent: AuditEnvelope = {
        protocolVersion: 1,
        auditEventId: randomUUID(),
        eventType: 'document.edit',
        document: identity,
        actor: {
          principalId: context.authorization.principalId,
          principalType: context.authorization.principalType,
          ...(context.authorization.principalType === 'agent'
            ? {
                agentRunId: context.authorization.agentRunId ?? context.authorization.traceId,
              }
            : context.authorization.agentRunId === undefined
              ? {}
              : { agentRunId: context.authorization.agentRunId }),
        },
        operationIds: request.operations.map((operation) => operation.operationId),
        ...(result.changeSetId === undefined ? {} : { changeSetId: result.changeSetId }),
        traceId: context.authorization.traceId,
        requestHash,
        idempotencyKeyHash: sha256(request.idempotencyKey),
        adapterVersion: 'adapter-tiptap-hocuspocus/v1',
        targetPreconditions: request.operations.map(auditTargetFor),
        beforeRevision: result.beforeRevision,
        ...(result.committedRevision === undefined
          ? {}
          : { afterRevision: result.committedRevision }),
        beforeHash: sha256(result.beforeRevision),
        ...(result.committedRevision === undefined
          ? {}
          : { afterHash: sha256(result.committedRevision) }),
        generatedBlockIds: [...result.createdBlockIds],
        generatedChangeIds: [...result.generatedChangeIds],
        authorizationDecision: {
          decisionId: randomUUID(),
          policyVersion: authorizationDecision.policyVersion,
          effect: 'allow',
          reasonCode:
            authorizationReason === undefined || authorizationReason.length === 0
              ? 'allowed'
              : authorizationReason,
        },
        outcome: { status: result.status },
        acknowledgement: result.acknowledgement,
        serverTimestamp: completedAt,
      };
      const receipt: IdempotencyReceipt = {
        requestHash,
        afterRevision: result.committedRevision ?? result.beforeRevision,
        ...(result.changeSetId === undefined ? {} : { changeSetId: result.changeSetId }),
        result,
        completedAt,
        queuedAudit: auditEvent,
      };
      await this.#idempotency.complete(scope, claim.leaseId, receipt);
      try {
        await this.#audit.append(auditEvent);
      } catch {
        // The audit event is durably queued in the idempotency receipt. A
        // delivery failure must not invite a second semantic mutation.
      }
      return result;
    } catch (error) {
      if (!semanticCommitDurable) {
        await this.#idempotency.abort(scope, claim.leaseId, error);
      }
      throw error;
    }
  }

  async #deliverQueuedAudit(receipt: IdempotencyReceipt): Promise<void> {
    if (receipt.queuedAudit === undefined) {
      return;
    }
    try {
      await this.#audit.append(receipt.queuedAudit);
    } catch {
      // The immutable receipt remains the durable outbox. Future duplicate
      // requests retry the same event ID, so sinks must append idempotently.
    }
  }

  async #requireAuthorization(
    action: AuthorizationInput['action'],
    identity: DocumentIdentity,
    authorization: AuthorizationContext,
  ): Promise<AuthorizationDecision> {
    const decision = await this.#authorization.authorize({
      action,
      identity,
      authorization,
    });
    if (!decision.allowed) {
      throw new DomainError(
        'PERMISSION_DENIED',
        'The principal is not authorized for this document operation',
        false,
      );
    }
    return decision;
  }
}

export const readDocumentQuerySchema = z
  .object({
    documentId: z.string().min(1).max(256),
    documentIncarnation: z.string().min(1).max(256),
    collaborationField: z.string().min(1).max(128).optional(),
    schemaId: z.literal('editor-mcp/mvp'),
    schemaVersion: z.literal(1),
    blockIds: z.array(z.uuid()).max(100).optional(),
    maxBlocks: z.number().int().positive().max(1_000).optional(),
  })
  .strict();
