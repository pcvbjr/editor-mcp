import type { Node as ProseMirrorNode, Schema } from '@tiptap/pm/model';

export const MVP_SCHEMA_ID = 'editor-mcp/mvp' as const;
export const MVP_SCHEMA_VERSION = 1 as const;

export type MvpSchemaId = typeof MVP_SCHEMA_ID;
export type MvpSchemaVersion = typeof MVP_SCHEMA_VERSION;

export type BlockDiffKind = 'delete' | 'insert' | 'modify';
export type InlineDiffKind = 'delete' | 'format' | 'insert';
export type ChangeStatus = 'accepted' | 'pending' | 'rejected';
export type ChangeDecision = 'accept' | 'reject';
export type ProjectionMode = 'clean' | 'final' | 'original' | 'review';
export type MetadataOperation = 'delete' | 'format' | 'insert' | 'replace' | 'structure';
export type AuthorType = 'agent' | 'human';

export interface ProseMirrorMarkJson {
  readonly type: string;
  readonly attrs?: Readonly<Record<string, unknown>>;
}

export interface ProseMirrorNodeJson {
  readonly type: string;
  readonly attrs?: Readonly<Record<string, unknown>>;
  readonly content?: readonly ProseMirrorNodeJson[];
  readonly marks?: readonly ProseMirrorMarkJson[];
  readonly text?: string;
}

export interface MvpSchemaCapability {
  readonly schemaId: MvpSchemaId;
  readonly schemaVersion: MvpSchemaVersion;
  readonly nodes: readonly string[];
  readonly marks: readonly string[];
  readonly addressableNodes: readonly string[];
  readonly projections: readonly ProjectionMode[];
}

export interface ResourceLimits {
  readonly maxBlocks: number;
  readonly maxDepth: number;
  readonly maxHtmlBytes: number;
  readonly maxNodes: number;
  readonly maxTableColumns: number;
  readonly maxTableRows: number;
  readonly maxTextBytes: number;
}

export interface HtmlParseOptions {
  readonly idFactory?: BlockIdFactory;
  readonly limits?: Partial<ResourceLimits>;
}

export interface HtmlSerializeOptions {
  readonly includeBlockIds?: boolean;
  readonly metadata?: DiffChangesMetadataReader;
  readonly mode?: ProjectionMode;
  readonly unresolvedCleanPolicy?: ChangeDecision;
}

export type BlockIdFactory = () => string;

export interface BlockLookup {
  readonly id: string;
  readonly node: ProseMirrorNode;
  /**
   * ProseMirror position before the node. The first top-level block is at position 0.
   */
  readonly position: number;
  /**
   * Child indexes from the doc root to the block.
   */
  readonly path: readonly number[];
}

export interface BlockSummary {
  readonly id: string;
  readonly nodeType: string;
  readonly contentDigest: `sha256:${string}`;
}

export interface BlockSplitIdentity {
  readonly retainedBlockId: string;
  readonly newBlockId: string;
}

export interface BlockJoinIdentity {
  readonly retainedBlockId: string;
  readonly retiredBlockIds: readonly string[];
}

export interface FormattingSnapshot {
  readonly marks: readonly ProseMirrorMarkJson[];
}

export interface ChangeMetadata {
  readonly id: string;
  readonly groupId?: string;
  readonly status: ChangeStatus;
  readonly operation: MetadataOperation;
  readonly authorId: string;
  readonly authorType: AuthorType;
  readonly createdAt: string;
  readonly resolvedAt?: string;
  readonly resolvedBy?: string;
  readonly summary?: string;
  readonly baseBlockId?: string;
  /**
   * Required to reject a whole-block `modify` representation.
   */
  readonly previousNode?: ProseMirrorNodeJson;
  /**
   * Required to reject a formatting-only change.
   */
  readonly previousFormatting?: FormattingSnapshot;
}

export interface DiffChangesMetadataReader {
  get(changeId: string): ChangeMetadata | undefined;
  list(): readonly ChangeMetadata[];
}

/**
 * A synchronous port because Y.Map mutations are synchronous. A production Yjs
 * implementation should bind `transact` to the same Y.Doc transaction that
 * commits the ProseMirror change.
 */
export interface DiffChangesMetadataPort extends DiffChangesMetadataReader {
  set(record: ChangeMetadata): void;
  transact<T>(origin: string, callback: () => T): T;
}

export interface ChangeResolutionContext {
  readonly resolvedAt: string;
  readonly resolvedBy: string;
}

export interface ChangeResolutionPlan {
  readonly decision: ChangeDecision;
  readonly document: ProseMirrorNode;
  readonly groupId?: string;
  readonly resolvedChangeIds: readonly string[];
  readonly metadataUpdates: readonly ChangeMetadata[];
}

export interface ProposedBlockReplacement {
  readonly document: ProseMirrorNode;
  readonly metadata: ChangeMetadata;
}

export interface MvpAdapter {
  readonly schema: Schema;
  readonly capability: MvpSchemaCapability;
}
