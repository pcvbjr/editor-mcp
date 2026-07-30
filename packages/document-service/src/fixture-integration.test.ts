import { describe, expect, it } from 'vitest';

import {
  canonicalizeDocument,
  mvpSchema,
  type ProseMirrorNodeJson,
} from '@editor-mcp/adapter-tiptap-hocuspocus';
import type {
  ApplyContext,
  AuthorizationContext,
  DocumentIdentity,
  MutationOutcome,
} from '@editor-mcp/core';
import {
  createDeterministicFixtureFactories,
  fixtureCatalog,
  runFixture,
  type FixtureChangeMetadata,
  type FixtureDefinition,
  type FixtureDocument,
  type FixtureExecutor,
  type FixtureState,
} from '@editor-mcp/fixtures';
import { applyEditsRequestSchema } from '@editor-mcp/protocol';
import {
  HocuspocusRuntime,
  MemoryYjsPersistence,
  ProseMirrorYjsDocumentCodec,
} from '@editor-mcp/runtime-hocuspocus';

import { TiptapDocumentService } from './index.js';

const APPLIED_AT = '2026-01-15T12:00:00.000Z';
const RESOLVED_AT = '2026-01-15T12:05:00.000Z';

const authorization: AuthorizationContext = {
  tenantId: 'tenant-fixtures',
  principalId: 'agent-fixture',
  principalType: 'agent',
  permissions: new Set(['documents:read', 'documents:suggest', 'documents:write']),
  agentRunId: 'fixture-run',
  traceId: 'fixture-trace',
};

const applyContext: ApplyContext = { authorization };
const resolutionContext: ApplyContext = {
  authorization: {
    tenantId: authorization.tenantId,
    principalId: 'reviewer-fixture',
    principalType: 'human',
    permissions: authorization.permissions,
    traceId: authorization.traceId,
  },
};

function identityFor(fixture: FixtureDefinition): DocumentIdentity {
  return {
    tenantId: authorization.tenantId,
    documentId: fixture.request.documentId,
    documentIncarnation: fixture.request.documentIncarnation,
    collaborationField: 'default',
    schemaId: fixture.schema.id,
    schemaVersion: fixture.schema.version,
  };
}

function createDocuments(
  persistence: MemoryYjsPersistence,
  fixture: FixtureDefinition,
  timestamp: string,
): { readonly documents: TiptapDocumentService; readonly runtime: HocuspocusRuntime } {
  const factories = createDeterministicFixtureFactories(fixture.seed);
  const runtime = new HocuspocusRuntime({
    persistence,
    documentCodec: new ProseMirrorYjsDocumentCodec(mvpSchema),
  });
  return {
    runtime,
    documents: new TiptapDocumentService({
      runtime,
      blockIdFactory: factories.blockId,
      changeIdFactory: factories.changeId,
      changeSetIdFactory: factories.changeSetId,
      now: () => new Date(timestamp),
    }),
  };
}

async function seedState(
  documents: TiptapDocumentService,
  identity: DocumentIdentity,
  state: FixtureState,
): Promise<void> {
  await documents.seed({
    identity,
    document: state.document,
    changes: state.diffChanges,
  });
}

async function persistedState(
  persistence: MemoryYjsPersistence,
  fixture: FixtureDefinition,
): Promise<FixtureState> {
  const { runtime } = createDocuments(persistence, fixture, RESOLVED_AT);
  const identity = identityFor(fixture);
  const state = await runtime.read(identity);
  if (state === undefined) {
    throw new Error(`Fixture ${fixture.id} did not persist a document`);
  }
  const document = canonicalizeDocument(
    state.document as unknown as ProseMirrorNodeJson,
  ).toJSON() as FixtureDocument;
  const diffChanges = Object.values(state.changes)
    .map((record) => structuredClone(record) as unknown as FixtureChangeMetadata)
    .toSorted((left, right) => left.id.localeCompare(right.id));
  await runtime.unload(identity);
  return { document, diffChanges };
}

function productionExecutor(appliedOutcomes: Map<string, MutationOutcome>): FixtureExecutor {
  return {
    async apply(state, request, context) {
      const fixture = fixtureCatalog.find(({ id }) => id === context.fixtureId);
      if (fixture === undefined) {
        throw new Error(`Unknown fixture ${context.fixtureId}`);
      }
      const persistence = new MemoryYjsPersistence();
      const { documents, runtime } = createDocuments(persistence, fixture, APPLIED_AT);
      const identity = identityFor(fixture);
      await seedState(documents, identity, state);
      let outcome: MutationOutcome;
      try {
        outcome = await documents.applyAtomic(identity, request, applyContext);
      } catch (error) {
        const expectedConflict = fixture.expected.conflicts[0];
        if (expectedConflict === undefined) {
          throw error;
        }
        expect(error).toMatchObject({ code: expectedConflict.code });
        await runtime.unload(identity);
        return persistedState(persistence, fixture);
      }
      appliedOutcomes.set(fixture.id, outcome);
      await runtime.unload(identity);
      return persistedState(persistence, fixture);
    },
    async resolve(state, command, context) {
      const fixture = fixtureCatalog.find(({ id }) => id === context.fixtureId);
      if (fixture === undefined) {
        throw new Error(`Unknown fixture ${context.fixtureId}`);
      }
      const persistence = new MemoryYjsPersistence();
      const { documents, runtime } = createDocuments(persistence, fixture, RESOLVED_AT);
      const identity = identityFor(fixture);
      await seedState(documents, identity, state);
      const request = applyEditsRequestSchema.parse({
        documentId: identity.documentId,
        documentIncarnation: identity.documentIncarnation,
        collaborationField: identity.collaborationField,
        schemaId: identity.schemaId,
        schemaVersion: identity.schemaVersion,
        idempotencyKey: `resolve-${command.decision}-${fixture.id}`,
        changeMode: 'suggest',
        operations: command.changeIds.map((changeId, index) => ({
          operationId: `resolve-${command.decision}-${String(index)}`,
          kind: command.decision === 'accept' ? 'accept_change' : 'reject_change',
          changeId,
        })),
      });
      const outcome = await documents.applyAtomic(identity, request, resolutionContext);
      expect(outcome.status).toBe('applied');
      await runtime.unload(identity);
      return persistedState(persistence, fixture);
    },
  };
}

describe('production-backed executable fixture catalog', () => {
  it('materializes every state through the certified adapter and durable Yjs runtime', async () => {
    const outcomes = new Map<string, MutationOutcome>();
    const executor = productionExecutor(outcomes);

    for (const fixture of fixtureCatalog) {
      const result = await runFixture(fixture, executor);
      expect({ fixtureId: fixture.id, state: result.states.proposed }).toEqual({
        fixtureId: fixture.id,
        state: fixture.expected.states.proposed,
      });
      expect({ fixtureId: fixture.id, state: result.states.accepted }).toEqual({
        fixtureId: fixture.id,
        state: fixture.expected.states.accepted,
      });
      expect({ fixtureId: fixture.id, state: result.states.rejected }).toEqual({
        fixtureId: fixture.id,
        state: fixture.expected.states.rejected,
      });
      expect({ fixtureId: fixture.id, ...result.matchesExpected }).toEqual({
        fixtureId: fixture.id,
        before: true,
        proposed: true,
        accepted: true,
        rejected: true,
      });
      expect(result.passed).toBe(true);

      const outcome = outcomes.get(fixture.id);
      const hasConflict = fixture.expected.conflicts.length > 0;
      expect(outcome?.status).toBe(hasConflict ? undefined : 'applied');
      expect(outcome?.createdBlockIds).toEqual(
        hasConflict ? undefined : fixture.expected.generatedBlockIds,
      );
      expect(outcome?.acknowledgement?.level).toBe(hasConflict ? undefined : 'snapshot');
    }
  });
});
