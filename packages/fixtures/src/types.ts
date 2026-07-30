import type { ApplyEditsRequest } from '@editor-mcp/protocol';

export const FIXTURE_FORMAT = 'editor-mcp/fixture' as const;
export const FIXTURE_FORMAT_VERSION = 1 as const;

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface FixtureMark {
  readonly type: string;
  readonly attrs?: Readonly<Record<string, JsonValue>>;
}

export interface FixtureNode {
  readonly type: string;
  readonly attrs?: Readonly<Record<string, JsonValue>>;
  readonly content?: readonly FixtureNode[];
  readonly marks?: readonly FixtureMark[];
  readonly text?: string;
}

export interface FixtureDocument extends FixtureNode {
  readonly type: 'doc';
  readonly content: readonly FixtureNode[];
}

export type FixtureChangeStatus = 'accepted' | 'pending' | 'rejected';
export type FixtureChangeOperation = 'delete' | 'format' | 'insert' | 'replace' | 'structure';

export interface FixtureChangeMetadata {
  readonly id: string;
  readonly groupId?: string;
  readonly status: FixtureChangeStatus;
  readonly operation: FixtureChangeOperation;
  readonly authorId: string;
  readonly authorType: 'agent' | 'human';
  readonly createdAt: string;
  readonly resolvedAt?: string;
  readonly resolvedBy?: string;
  readonly summary?: string;
  readonly baseBlockId?: string;
}

export interface FixtureState {
  readonly document: FixtureDocument;
  readonly diffChanges: readonly FixtureChangeMetadata[];
}

export interface FixtureSchemaReference {
  readonly id: 'editor-mcp/mvp';
  readonly version: 1;
}

export type FixtureTrackingStrategy = 'block' | 'inline' | 'none' | 'table';

export interface FixtureSubject {
  readonly nodeType: string;
  readonly tracking: FixtureTrackingStrategy;
}

/**
 * Catalog-level resolution fans out grouped changes from one proposed state.
 * Executors map this directive to the protocol's accept/reject operations.
 */
export type FixtureResolution =
  | {
      readonly kind: 'not_applicable';
    }
  | {
      readonly kind: 'accept_reject';
      readonly changeIds: readonly string[];
    };

export interface FixtureConflictExpectation {
  readonly code: string;
  readonly operationId?: string;
  readonly detail?: string;
}

export interface FixtureInvariant {
  readonly id:
    | 'accepted-rejected-are-siblings'
    | 'clean-resolutions-have-no-diff-artifacts'
    | 'direct-resolution-is-noop'
    | 'generated-block-ids-are-server-owned'
    | 'no-orphaned-change-metadata'
    | 'rejected-equals-before'
    | 'replacement-block-id-is-new'
    | 'schema-valid'
    | 'stable-block-ids-are-unique'
    | 'unrelated-blocks-are-unchanged';
  readonly description: string;
}

export interface FixtureExpectedStates {
  readonly before: FixtureState;
  readonly proposed: FixtureState;
  readonly accepted: FixtureState;
  readonly rejected: FixtureState;
}

export interface FixtureExpected {
  readonly states: FixtureExpectedStates;
  readonly conflicts: readonly FixtureConflictExpectation[];
  readonly generatedBlockIds: readonly string[];
}

export interface FixtureDefinitionV1 {
  readonly format: typeof FIXTURE_FORMAT;
  readonly formatVersion: typeof FIXTURE_FORMAT_VERSION;
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly seed: number;
  readonly schema: FixtureSchemaReference;
  readonly tags: readonly string[];
  readonly subject: FixtureSubject;
  readonly request: ApplyEditsRequest;
  readonly resolution: FixtureResolution;
  readonly expected: FixtureExpected;
  readonly invariants: readonly FixtureInvariant[];
}

export type FixtureDefinition = FixtureDefinitionV1;

export interface FixtureExecutionContext {
  readonly fixtureId: string;
  readonly seed: number;
  readonly schema: FixtureSchemaReference;
}

export interface FixtureResolutionCommand {
  readonly decision: 'accept' | 'reject';
  readonly changeIds: readonly string[];
}

export type MaybePromise<T> = PromiseLike<T> | T;

export interface FixtureExecutor {
  apply(
    state: FixtureState,
    request: ApplyEditsRequest,
    context: FixtureExecutionContext,
  ): MaybePromise<FixtureState>;
  resolve(
    state: FixtureState,
    command: FixtureResolutionCommand,
    context: FixtureExecutionContext,
  ): MaybePromise<FixtureState>;
}

export interface MaterializedFixtureStates {
  readonly before: FixtureState;
  readonly proposed: FixtureState;
  readonly accepted: FixtureState;
  readonly rejected: FixtureState;
}

export interface FixtureStateMatches {
  readonly before: boolean;
  readonly proposed: boolean;
  readonly accepted: boolean;
  readonly rejected: boolean;
}

export interface FixtureRunResult {
  readonly fixture: FixtureDefinition;
  readonly states: MaterializedFixtureStates;
  readonly matchesExpected: FixtureStateMatches;
  readonly passed: boolean;
}

export interface FixtureSelection {
  readonly ids?: readonly string[];
  readonly operationKinds?: readonly ApplyEditsRequest['operations'][number]['kind'][];
  readonly changeModes?: readonly ApplyEditsRequest['changeMode'][];
  readonly nodeTypes?: readonly string[];
  readonly tags?: readonly string[];
  readonly schemaVersions?: readonly number[];
}
