import type {
  FixtureDefinition,
  FixtureExecutionContext,
  FixtureExecutor,
  FixtureNode,
  FixtureRunResult,
  FixtureSelection,
  FixtureState,
  FixtureStateMatches,
  JsonValue,
  MaterializedFixtureStates,
} from './types.js';

const isJsonArray = (value: JsonValue): value is readonly JsonValue[] => Array.isArray(value);

const cloneJsonValue = (value: JsonValue): JsonValue => {
  if (isJsonArray(value)) {
    return value.map((item) => cloneJsonValue(item));
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneJsonValue(item)]),
    );
  }

  return value;
};

const cloneNode = (node: FixtureNode): FixtureNode => ({
  type: node.type,
  ...(node.attrs === undefined
    ? {}
    : {
        attrs: Object.fromEntries(
          Object.entries(node.attrs).map(([key, value]) => [key, cloneJsonValue(value)]),
        ),
      }),
  ...(node.content === undefined ? {} : { content: node.content.map((child) => cloneNode(child)) }),
  ...(node.marks === undefined
    ? {}
    : {
        marks: node.marks.map((mark) => ({
          type: mark.type,
          ...(mark.attrs === undefined
            ? {}
            : {
                attrs: Object.fromEntries(
                  Object.entries(mark.attrs).map(([key, value]) => [key, cloneJsonValue(value)]),
                ),
              }),
        })),
      }),
  ...(node.text === undefined ? {} : { text: node.text }),
});

export const cloneFixtureState = (state: FixtureState): FixtureState => ({
  document: cloneNode(state.document) as FixtureState['document'],
  diffChanges: state.diffChanges.map((change) => ({ ...change })),
});

const stableSerialize = (value: unknown): string => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Fixture values must contain only finite numbers');
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(',')}]`;
  }

  if (typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>;
    const properties = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`);
    return `{${properties.join(',')}}`;
  }

  throw new TypeError(`Unsupported fixture value type: ${typeof value}`);
};

export const fixtureStatesEqual = (left: FixtureState, right: FixtureState): boolean =>
  stableSerialize(left) === stableSerialize(right);

const executionContext = (fixture: FixtureDefinition): FixtureExecutionContext => ({
  fixtureId: fixture.id,
  seed: fixture.seed,
  schema: fixture.schema,
});

export const materializeFixtureStates = async (
  fixture: FixtureDefinition,
  executor: FixtureExecutor,
): Promise<MaterializedFixtureStates> => {
  const context = executionContext(fixture);
  const before = cloneFixtureState(fixture.expected.states.before);
  const proposed = await executor.apply(cloneFixtureState(before), fixture.request, context);

  const acceptedInput = cloneFixtureState(proposed);
  const rejectedInput = cloneFixtureState(proposed);

  if (fixture.resolution.kind === 'not_applicable') {
    return {
      before,
      proposed,
      accepted: acceptedInput,
      rejected: rejectedInput,
    };
  }

  const accepted = await executor.resolve(
    acceptedInput,
    {
      decision: 'accept',
      changeIds: fixture.resolution.changeIds,
    },
    context,
  );
  const rejected = await executor.resolve(
    rejectedInput,
    {
      decision: 'reject',
      changeIds: fixture.resolution.changeIds,
    },
    context,
  );

  return { before, proposed, accepted, rejected };
};

export const runFixture = async (
  fixture: FixtureDefinition,
  executor: FixtureExecutor,
): Promise<FixtureRunResult> => {
  const states = await materializeFixtureStates(fixture, executor);
  const matchesExpected: FixtureStateMatches = {
    before: fixtureStatesEqual(states.before, fixture.expected.states.before),
    proposed: fixtureStatesEqual(states.proposed, fixture.expected.states.proposed),
    accepted: fixtureStatesEqual(states.accepted, fixture.expected.states.accepted),
    rejected: fixtureStatesEqual(states.rejected, fixture.expected.states.rejected),
  };

  return {
    fixture,
    states,
    matchesExpected,
    passed: Object.values(matchesExpected).every(Boolean),
  };
};

const hasIntersection = <T>(selection: readonly T[] | undefined, values: readonly T[]): boolean =>
  selection === undefined || selection.some((selected) => values.includes(selected));

const hasAllTags = (
  selectedTags: readonly string[] | undefined,
  fixtureTags: readonly string[],
): boolean => selectedTags === undefined || selectedTags.every((tag) => fixtureTags.includes(tag));

export const selectFixtures = (
  catalog: readonly FixtureDefinition[],
  selection: FixtureSelection = {},
): readonly FixtureDefinition[] =>
  catalog
    .filter(
      (fixture) =>
        hasIntersection(selection.ids, [fixture.id]) &&
        hasIntersection(
          selection.operationKinds,
          fixture.request.operations.map((operation) => operation.kind),
        ) &&
        hasIntersection(selection.changeModes, [fixture.request.changeMode]) &&
        hasIntersection(selection.nodeTypes, [fixture.subject.nodeType]) &&
        hasIntersection(selection.schemaVersions, [fixture.schema.version]) &&
        hasAllTags(selection.tags, fixture.tags),
    )
    .toSorted((left, right) => left.id.localeCompare(right.id));

const normalizeBasePath = (basePath: string): string => {
  const withoutTrailingSlashes = basePath.replace(/\/+$/u, '');
  return withoutTrailingSlashes.length === 0 ? '' : withoutTrailingSlashes;
};

export const fixtureUrl = (
  fixture: Pick<FixtureDefinition, 'id' | 'seed'>,
  basePath = '/fixtures',
): string =>
  `${normalizeBasePath(basePath)}/${encodeURIComponent(fixture.id)}?seed=${String(fixture.seed)}`;

export const findFixture = (
  catalog: readonly FixtureDefinition[],
  id: string,
): FixtureDefinition | undefined => catalog.find((fixture) => fixture.id === id);

export const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    const record = value as Readonly<Record<PropertyKey, unknown>>;
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze(record[key]);
    }
    Object.freeze(value);
  }
  return value;
};
