import { applyEditsRequestSchema } from '@editor-mcp/protocol';
import {
  canonicalJsonString,
  canonicalizeDocument,
  digestBlock,
  findBlockById,
} from '@editor-mcp/adapter-tiptap-hocuspocus';
import { describe, expect, it } from 'vitest';

import {
  FIXTURE_FORMAT,
  FIXTURE_FORMAT_VERSION,
  cloneExpectedStates,
  cloneFixtureState,
  findFixture,
  fixtureCatalog,
  fixtureCatalogById,
  fixtureStatesEqual,
  fixtureUrl,
  materializeFixtureStates,
  runFixture,
  selectFixtures,
  type FixtureDefinition,
  type FixtureExecutionContext,
  type FixtureExecutor,
  type FixtureNode,
  type FixtureResolutionCommand,
  type FixtureState,
} from './index.js';

const blockIds = (node: FixtureNode): readonly string[] => {
  const ownId = node.attrs?.['blockId'];
  return [
    ...(typeof ownId === 'string' ? [ownId] : []),
    ...(node.content?.flatMap((child) => blockIds(child)) ?? []),
  ];
};

const changeReferences = (node: FixtureNode): readonly string[] => {
  const blockReference = node.attrs?.['diffChangeId'];
  const markReferences =
    node.marks
      ?.map((mark) => mark.attrs?.['changeId'])
      .filter((value): value is string => typeof value === 'string') ?? [];

  return [
    ...(typeof blockReference === 'string' ? [blockReference] : []),
    ...markReferences,
    ...(node.content?.flatMap((child) => changeReferences(child)) ?? []),
  ];
};

const requiredState = (state: FixtureState | undefined, label: string): FixtureState => {
  if (state === undefined) {
    throw new Error(`Missing materialized state: ${label}`);
  }
  return state;
};

const canonicalDocumentJson = (document: FixtureState['document']): string =>
  canonicalJsonString(canonicalizeDocument(document).toJSON());

const fixtureDocumentJson = (document: FixtureState['document']): string =>
  canonicalJsonString(document);

const commonBlockIds = (left: FixtureNode, right: FixtureNode): readonly string[] => {
  const leftIds = new Set(blockIds(left));
  return blockIds(right).filter((id) => leftIds.has(id));
};

const blockJson = (document: FixtureState['document'], blockId: string): string => {
  const node = findBlockById(canonicalizeDocument(document), blockId).node;
  return canonicalJsonString(node.toJSON());
};

const fixtureForContext = (context: FixtureExecutionContext): FixtureDefinition => {
  const fixture = fixtureCatalogById[context.fixtureId];
  if (fixture === undefined) {
    throw new Error(`Unknown fixture: ${context.fixtureId}`);
  }
  return fixture;
};

const expectedExecutor: FixtureExecutor = {
  apply(_state, _request, context) {
    return cloneFixtureState(fixtureForContext(context).expected.states.proposed);
  },
  resolve(_state, command, context) {
    const fixture = fixtureForContext(context);
    return cloneFixtureState(
      command.decision === 'accept'
        ? fixture.expected.states.accepted
        : fixture.expected.states.rejected,
    );
  },
};

describe('versioned fixture catalog', () => {
  it('publishes immutable, uniquely addressable fixtures and seeds', () => {
    const ids = fixtureCatalog.map((fixture) => fixture.id);
    const seeds = fixtureCatalog.map((fixture) => fixture.seed);

    expect(ids).toHaveLength(42);
    expect(ids).toEqual(
      expect.arrayContaining([
        'replace-block-direct-type-change',
        'replace-block-suggest-blocks',
        'delete-block-suggest-blockquote',
        'insert-table-row-suggest',
        'insert-text-direct-emoji-end-boundary',
        'structure-nested-mixed-list-reparent-direct',
        'table-colspan-rowspan-replacement-direct',
      ]),
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(seeds).size).toBe(seeds.length);

    for (const fixture of fixtureCatalog) {
      expect(fixture.format).toBe(FIXTURE_FORMAT);
      expect(fixture.formatVersion).toBe(FIXTURE_FORMAT_VERSION);
      expect(Number.isSafeInteger(fixture.seed)).toBe(true);
      expect(fixture.seed).toBeGreaterThan(0);
      expect(fixture.request.changeMode).toBe('suggest');
      expect(applyEditsRequestSchema.parse(fixture.request)).toEqual(fixture.request);
      expect(fixtureCatalogById[fixture.id]).toBe(fixture);
      expect(Object.isFrozen(fixture)).toBe(true);
      expect(Object.isFrozen(fixture.expected.states.before.document)).toBe(true);
    }
  });

  it('stores every expected document as exact certified canonical JSON', () => {
    for (const fixture of fixtureCatalog) {
      const states = [
        ['before', fixture.expected.states.before],
        ['proposed', fixture.expected.states.proposed],
        ['accepted', fixture.expected.states.accepted],
        ['rejected', fixture.expected.states.rejected],
      ] as const;

      for (const [, state] of states) {
        expect(fixtureDocumentJson(state.document)).toBe(canonicalDocumentJson(state.document));
        expect(state.document.type).toBe('doc');
      }
    }
  });

  it('binds operation preconditions to the exact before JSON and preserves unrelated blocks', () => {
    for (const fixture of fixtureCatalog) {
      const before = fixture.expected.states.before;
      const proposed = fixture.expected.states.proposed;
      const canonicalBefore = canonicalizeDocument(before.document);
      const targetedIds = new Set<string>();
      const digestChecks: [string, string][] = [];

      for (const operation of fixture.request.operations) {
        if ('expectedBlockDigest' in operation) {
          const lookup = findBlockById(canonicalBefore, operation.blockId);
          targetedIds.add(operation.blockId);
          let ancestor = canonicalBefore;
          for (const childIndex of lookup.path) {
            ancestor = ancestor.child(childIndex);
            const ancestorAttrs = ancestor.attrs as Readonly<Record<string, unknown>>;
            const ancestorId = ancestorAttrs['blockId'];
            if (typeof ancestorId === 'string') {
              targetedIds.add(ancestorId);
            }
          }
          digestChecks.push([digestBlock(lookup.node), operation.expectedBlockDigest]);
        } else if ('expectedTableDigest' in operation) {
          const lookup = findBlockById(canonicalBefore, operation.tableId);
          targetedIds.add(operation.tableId);
          lookup.node.descendants((descendant) => {
            const descendantAttrs = descendant.attrs as Readonly<Record<string, unknown>>;
            const descendantId = descendantAttrs['blockId'];
            if (typeof descendantId === 'string') {
              targetedIds.add(descendantId);
            }
          });
          digestChecks.push([digestBlock(lookup.node), operation.expectedTableDigest]);
        }
      }

      for (const [actualDigest, expectedDigest] of digestChecks) {
        expect(actualDigest).toBe(expectedDigest);
      }

      for (const blockId of commonBlockIds(before.document, proposed.document)) {
        if (targetedIds.has(blockId)) {
          continue;
        }
        try {
          expect(blockJson(proposed.document, blockId)).toBe(blockJson(before.document, blockId));
        } catch (error) {
          const details =
            error instanceof Error && 'details' in error ? JSON.stringify(error.details) : '';
          throw new Error(
            `${fixture.id} block ${blockId}: ${error instanceof Error ? error.message : String(error)} ${details}`,
            { cause: error },
          );
        }
      }
    }
  });

  it('keeps stable block IDs and change IDs unique in every state', () => {
    const catalogChangeIds: string[] = [];

    for (const fixture of fixtureCatalog) {
      const states: readonly FixtureState[] = [
        fixture.expected.states.before,
        fixture.expected.states.proposed,
        fixture.expected.states.accepted,
        fixture.expected.states.rejected,
      ];
      for (const state of states) {
        const ids = blockIds(state.document);
        const metadataIds = state.diffChanges.map((change) => change.id);

        expect(new Set(ids).size).toBe(ids.length);
        expect(new Set(metadataIds).size).toBe(metadataIds.length);
      }

      const fixtureChangeIds = fixture.expected.states.proposed.diffChanges.map(
        (change) => change.id,
      );
      catalogChangeIds.push(...fixtureChangeIds);

      expect(new Set(fixture.expected.generatedBlockIds).size).toBe(
        fixture.expected.generatedBlockIds.length,
      );
      const beforeBlockIds = new Set(blockIds(fixture.expected.states.before.document));
      const actualGeneratedIds = blockIds(fixture.expected.states.proposed.document).filter(
        (id) => !beforeBlockIds.has(id),
      );
      expect(actualGeneratedIds).toEqual(fixture.expected.generatedBlockIds);
      for (const generatedId of fixture.expected.generatedBlockIds) {
        expect(blockIds(fixture.expected.states.before.document)).not.toContain(generatedId);
        expect(blockIds(fixture.expected.states.proposed.document)).toContain(generatedId);
        expect(JSON.stringify(fixture.request)).not.toContain(generatedId);
      }
    }

    expect(new Set(catalogChangeIds).size).toBe(catalogChangeIds.length);
  });

  it('publishes a target digest precondition for every catalog operation', () => {
    const digests: string[] = [];

    for (const fixture of fixtureCatalog) {
      for (const operation of fixture.request.operations) {
        if ('expectedBlockDigest' in operation) {
          digests.push(operation.expectedBlockDigest);
        } else if (
          'expectedAnchorDigest' in operation &&
          operation.expectedAnchorDigest !== undefined
        ) {
          digests.push(operation.expectedAnchorDigest);
        } else if ('expectedTableDigest' in operation) {
          digests.push(operation.expectedTableDigest);
        }
      }
    }

    expect(digests).toHaveLength(
      fixtureCatalog.reduce((count, fixture) => count + fixture.request.operations.length, 0),
    );
    expect(digests.every((digest) => /^sha256:[a-f0-9]{64}$/u.test(digest))).toBe(true);
  });

  it('keeps pending metadata and document segments in sync', () => {
    for (const fixture of fixtureCatalog) {
      const proposed = fixture.expected.states.proposed;
      const references = changeReferences(proposed.document);
      const pendingIds = proposed.diffChanges
        .filter((change) => change.status === 'pending')
        .map((change) => change.id);

      expect(new Set(references)).toEqual(new Set(pendingIds));
      expect(changeReferences(fixture.expected.states.accepted.document)).toEqual([]);
      expect(changeReferences(fixture.expected.states.rejected.document)).toEqual([]);
    }
  });

  it('asserts exact canonical resolution outcomes for every fixture', () => {
    for (const fixture of fixtureCatalog) {
      const { before, proposed, accepted, rejected } = fixture.expected.states;
      if (fixture.resolution.kind === 'not_applicable') {
        if (canonicalJsonString(accepted.document) !== canonicalJsonString(proposed.document)) {
          throw new Error(`${fixture.id}: accepted direct state differs from proposed`);
        }
        if (canonicalJsonString(rejected.document) !== canonicalJsonString(proposed.document)) {
          throw new Error(`${fixture.id}: rejected direct state differs from proposed`);
        }
        if (
          canonicalJsonString(accepted.diffChanges) !== canonicalJsonString(proposed.diffChanges)
        ) {
          throw new Error(`${fixture.id}: accepted direct metadata differs from proposed`);
        }
        if (
          canonicalJsonString(rejected.diffChanges) !== canonicalJsonString(proposed.diffChanges)
        ) {
          throw new Error(`${fixture.id}: rejected direct metadata differs from proposed`);
        }
        continue;
      }

      expect(canonicalJsonString(rejected.document)).toBe(canonicalJsonString(before.document));
      expect(rejected.diffChanges).toHaveLength(fixture.resolution.changeIds.length);
      expect(accepted.diffChanges).toHaveLength(fixture.resolution.changeIds.length);
      const sortedChangeIds = fixture.resolution.changeIds.toSorted();
      expect(accepted.diffChanges.map(({ id }) => id)).toEqual(sortedChangeIds);
      expect(rejected.diffChanges.map(({ id }) => id)).toEqual(sortedChangeIds);
      expect(accepted.diffChanges.every(({ status }) => status === 'accepted')).toBe(true);
      expect(rejected.diffChanges.every(({ status }) => status === 'rejected')).toBe(true);
      expect(proposed.diffChanges.map(({ id }) => id)).toEqual(sortedChangeIds);
    }
  });

  it('tracks replaced blocks and publishes fresh server-owned replacement IDs', () => {
    const structural = fixtureCatalogById['structure-paragraph-to-heading-direct'];
    const suggested = fixtureCatalogById['replace-block-direct-type-change'];
    expect(structural).toBeDefined();
    expect(suggested).toBeDefined();
    if (structural === undefined || suggested === undefined) {
      return;
    }

    const structuralTarget = structural.request.operations[0];
    expect(structuralTarget?.kind).toBe('replace_block');
    if (structuralTarget?.kind !== 'replace_block') {
      return;
    }
    const structuralReplacementId = structural.expected.generatedBlockIds[0];
    expect(blockIds(structural.expected.states.before.document)).toContain(
      structuralTarget.blockId,
    );
    expect(blockIds(structural.expected.states.proposed.document)).toContain(
      structuralTarget.blockId,
    );
    expect(blockIds(structural.expected.states.proposed.document)).toContain(
      structuralReplacementId,
    );
    expect(structural.expected.states.proposed.document.content[1]?.attrs?.['diffChangeKind']).toBe(
      'delete',
    );

    const suggestedTarget = suggested.request.operations[0];
    expect(suggestedTarget?.kind).toBe('replace_block');
    if (suggestedTarget?.kind !== 'replace_block') {
      return;
    }
    const suggestedReplacementId = suggested.expected.generatedBlockIds[0];
    expect(blockIds(suggested.expected.states.proposed.document)).toEqual(
      expect.arrayContaining([suggestedTarget.blockId, suggestedReplacementId]),
    );
    expect(blockIds(suggested.expected.states.accepted.document)).not.toContain(
      suggestedTarget.blockId,
    );
    expect(blockIds(suggested.expected.states.accepted.document)).toContain(suggestedReplacementId);
    expect(blockIds(suggested.expected.states.rejected.document)).toContain(
      suggestedTarget.blockId,
    );
    expect(blockIds(suggested.expected.states.rejected.document)).not.toContain(
      suggestedReplacementId,
    );
    const changeId = suggested.expected.states.proposed.diffChanges[0]?.id;
    expect(changeId).toBeDefined();
    expect(changeReferences(suggested.expected.states.proposed.document)).toEqual([
      changeId,
      changeId,
    ]);
  });
});

describe('deterministic discovery', () => {
  it('builds stable, directly addressable URLs', () => {
    const fixture = fixtureCatalog[0];
    expect(fixture).toBeDefined();
    if (fixture === undefined) {
      return;
    }

    expect(fixtureUrl(fixture)).toBe('/fixtures/replace-block-direct-type-change?seed=410001');
    expect(fixtureUrl(fixture, '/review/fixtures///')).toBe(
      '/review/fixtures/replace-block-direct-type-change?seed=410001',
    );
    expect(fixtureUrl({ id: 'spaces & tables', seed: 7 }, '')).toBe(
      '/spaces%20%26%20tables?seed=7',
    );
    expect(fixtureUrl(fixture)).toBe(fixtureUrl(fixture));
    expect(new Set(fixtureCatalog.map((item) => fixtureUrl(item))).size).toBe(
      fixtureCatalog.length,
    );
  });

  it('returns a stable sort for combined catalog filters', () => {
    const sortedIds = fixtureCatalog.map((fixture) => fixture.id).toSorted();
    expect(selectFixtures(fixtureCatalog).map((fixture) => fixture.id)).toEqual(sortedIds);
    expect(selectFixtures(fixtureCatalog.toReversed()).map((fixture) => fixture.id)).toEqual(
      sortedIds,
    );
    expect(
      selectFixtures(fixtureCatalog, {
        tags: ['resolution', 'suggest'],
        changeModes: ['suggest'],
        schemaVersions: [1],
      }).map((fixture) => fixture.id),
    ).toEqual([
      'delete-block-suggest-blockquote',
      'insert-block-after-suggest',
      'insert-block-before-direct',
      'insert-table-row-suggest',
      'replace-block-direct-type-change',
      'replace-block-suggest-blocks',
    ]);
    const paragraphReplacements = selectFixtures(fixtureCatalog, {
      operationKinds: ['replace_block'],
      nodeTypes: ['paragraph'],
    }).map((fixture) => fixture.id);
    expect(paragraphReplacements).toEqual(
      expect.arrayContaining([
        'replace-block-direct-type-change',
        'replace-block-suggest-blocks',
        'structure-paragraph-to-heading-direct',
      ]),
    );
    expect(
      selectFixtures(fixtureCatalog, {
        ids: ['insert-table-row-suggest'],
        tags: ['table'],
      }),
    ).toEqual([fixtureCatalogById['insert-table-row-suggest']]);
    expect(
      selectFixtures(fixtureCatalog, {
        ids: ['missing'],
      }),
    ).toEqual([]);
  });

  it('finds fixtures without imposing transport behavior', () => {
    expect(findFixture(fixtureCatalog, 'replace-block-suggest-blocks')).toBe(
      fixtureCatalogById['replace-block-suggest-blocks'],
    );
    expect(findFixture(fixtureCatalog, 'missing-fixture')).toBeUndefined();
  });
});

describe('sibling state materialization', () => {
  it('resolves accept and reject from distinct copies of the same proposal', async () => {
    const fixture = fixtureCatalogById['replace-block-suggest-blocks'];
    expect(fixture).toBeDefined();
    if (fixture === undefined) {
      return;
    }
    expect(fixture.resolution.kind).toBe('accept_reject');
    if (fixture.resolution.kind !== 'accept_reject') {
      return;
    }
    const resolutionChangeIds = fixture.resolution.changeIds;

    const resolutionInputs = new Map<FixtureResolutionCommand['decision'], FixtureState>();
    const contexts: FixtureExecutionContext[] = [];
    const executor: FixtureExecutor = {
      apply(state, request, context) {
        contexts.push(context);
        expect(state).not.toBe(fixture.expected.states.before);
        expect(request).toBe(fixture.request);
        return cloneFixtureState(fixture.expected.states.proposed);
      },
      resolve(state, command, context) {
        contexts.push(context);
        resolutionInputs.set(command.decision, state);
        expect(command.changeIds).toEqual(resolutionChangeIds);
        return cloneFixtureState(
          command.decision === 'accept'
            ? fixture.expected.states.accepted
            : fixture.expected.states.rejected,
        );
      },
    };

    const states = await materializeFixtureStates(fixture, executor);
    const acceptedInput = resolutionInputs.get('accept');
    const rejectedInput = resolutionInputs.get('reject');
    const acceptedState = requiredState(acceptedInput, 'accepted input');
    const rejectedState = requiredState(rejectedInput, 'rejected input');

    expect(acceptedInput).toBeDefined();
    expect(rejectedInput).toBeDefined();
    expect(acceptedInput).not.toBe(rejectedInput);
    expect(acceptedInput?.document).not.toBe(rejectedInput?.document);
    expect(fixtureStatesEqual(acceptedState, fixture.expected.states.proposed)).toBe(true);
    expect(fixtureStatesEqual(rejectedState, fixture.expected.states.proposed)).toBe(true);
    expect(states.before).not.toBe(fixture.expected.states.before);
    expect(contexts).toHaveLength(3);
    expect(new Set(contexts.map((context) => context.seed))).toEqual(new Set([fixture.seed]));
  });

  it('resolves structural replacements through the same suggest path', async () => {
    const fixture = fixtureCatalogById['structure-paragraph-to-heading-direct'];
    expect(fixture).toBeDefined();
    if (fixture === undefined) {
      return;
    }

    const resolveCalls: FixtureResolutionCommand[] = [];
    const states = await materializeFixtureStates(fixture, {
      apply() {
        return cloneFixtureState(fixture.expected.states.proposed);
      },
      resolve(_state, command) {
        resolveCalls.push(command);
        return cloneFixtureState(
          command.decision === 'accept'
            ? fixture.expected.states.accepted
            : fixture.expected.states.rejected,
        );
      },
    });

    expect(resolveCalls.map(({ decision }) => decision)).toEqual(['accept', 'reject']);
    expect(states.accepted).not.toBe(states.rejected);
    expect(states.accepted.document).not.toBe(states.rejected.document);
    expect(fixtureStatesEqual(states.accepted, fixture.expected.states.accepted)).toBe(true);
    expect(fixtureStatesEqual(states.rejected, fixture.expected.states.rejected)).toBe(true);
  });

  it('runs every catalog fixture and reports per-state comparisons', async () => {
    for (const fixture of fixtureCatalog) {
      const result = await runFixture(fixture, expectedExecutor);
      expect(result.fixture).toBe(fixture);
      expect(result.matchesExpected).toEqual({
        before: true,
        proposed: true,
        accepted: true,
        rejected: true,
      });
      expect(result.passed).toBe(true);
    }

    const fixture = fixtureCatalogById['replace-block-suggest-blocks'];
    expect(fixture).toBeDefined();
    if (fixture === undefined) {
      return;
    }
    const failed = await runFixture(fixture, {
      apply(state) {
        return state;
      },
      resolve(state) {
        return state;
      },
    });
    expect(failed.passed).toBe(false);
    expect(failed.matchesExpected.before).toBe(true);
    expect(failed.matchesExpected.proposed).toBe(false);
  });

  it('returns independent mutable clones without exposing catalog state', () => {
    const fixture = fixtureCatalogById['structure-paragraph-to-heading-direct'];
    expect(fixture).toBeDefined();
    if (fixture === undefined) {
      return;
    }

    const states = cloneExpectedStates(fixture);
    expect(states.before).not.toBe(fixture.expected.states.before);
    expect(states.before.document).not.toBe(fixture.expected.states.before.document);
    expect(fixtureStatesEqual(states.before, fixture.expected.states.before)).toBe(true);

    const different = cloneFixtureState(states.before);
    const firstChange = different.diffChanges[0];
    expect(firstChange).toBeUndefined();
    expect(fixtureStatesEqual(different, fixture.expected.states.proposed)).toBe(false);
  });
});
