import { z } from 'zod';

import {
  blockIdSchema,
  changeIdSchema,
  documentIdSchema,
  operationIdSchema,
  opaqueIdSchema,
  schemaIdSchema,
  schemaVersionSchema,
  timestampSchema,
} from './base.js';
import { applyEditsRequestSchema } from './apply.js';
import { domainErrorCodeSchema } from './errors.js';

export const FIXTURE_FORMAT = 'editor-mcp/fixture' as const;
export const FIXTURE_FORMAT_VERSION = 1 as const;

export const fixtureSeedSchema = z.number().int().nonnegative().max(4_294_967_295);

export const fixtureInvariantKindSchema = z.enum([
  'accepted-rejected-are-siblings',
  'clean-resolutions-have-no-diff-artifacts',
  'direct-resolution-is-noop',
  'generated-block-ids-are-server-owned',
  'no-orphaned-change-metadata',
  'rejected-equals-before',
  'replacement-block-id-is-new',
  'schema-valid',
  'stable-block-ids-are-unique',
  'unrelated-blocks-are-unchanged',
]);

export const fixtureInvariantSchema = z
  .object({
    id: fixtureInvariantKindSchema,
    description: z.string().trim().min(1).max(2_048),
  })
  .strict();

export const canonicalDocumentJsonSchema = z
  .json()
  .refine(
    (value) =>
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      value['type'] === 'doc' &&
      Array.isArray(value['content']),
    'Canonical document JSON must be a ProseMirror doc node with content',
  );

export const fixtureChangeMetadataSchema = z
  .object({
    id: changeIdSchema,
    groupId: opaqueIdSchema.optional(),
    status: z.enum(['pending', 'accepted', 'rejected']),
    operation: z.enum(['insert', 'delete', 'replace', 'format', 'structure']),
    authorId: opaqueIdSchema,
    authorType: z.enum(['agent', 'human']),
    createdAt: timestampSchema,
    resolvedAt: timestampSchema.optional(),
    resolvedBy: opaqueIdSchema.optional(),
    summary: z.string().trim().min(1).max(2_048).optional(),
    baseBlockId: blockIdSchema.optional(),
  })
  .strict()
  .superRefine((change, context) => {
    if (
      change.status === 'pending' &&
      (change.resolvedAt !== undefined || change.resolvedBy !== undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Pending fixture changes cannot have resolution metadata',
        path: ['resolvedAt'],
      });
    }

    if (
      change.status !== 'pending' &&
      (change.resolvedAt === undefined || change.resolvedBy === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Resolved fixture changes require resolution metadata',
        path: ['resolvedAt'],
      });
    }
  });

export const fixtureDocumentStateSchema = z
  .object({
    document: canonicalDocumentJsonSchema,
    diffChanges: z.array(fixtureChangeMetadataSchema).readonly(),
  })
  .strict()
  .refine(
    ({ diffChanges }) => new Set(diffChanges.map(({ id }) => id)).size === diffChanges.length,
    {
      message: 'Fixture change IDs must be unique',
      path: ['diffChanges'],
    },
  );

export const fixtureSchemaReferenceSchema = z
  .object({
    id: schemaIdSchema,
    version: schemaVersionSchema,
  })
  .strict();

export const fixtureTrackingStrategySchema = z.enum(['none', 'inline', 'block', 'table']);

export const fixtureSubjectSchema = z
  .object({
    nodeType: z.string().trim().min(1).max(128),
    tracking: fixtureTrackingStrategySchema,
  })
  .strict();

export const fixtureResolutionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('not_applicable') }).strict(),
  z
    .object({
      kind: z.literal('accept_reject'),
      changeIds: z.array(changeIdSchema).min(1).readonly(),
    })
    .strict()
    .refine(({ changeIds }) => new Set(changeIds).size === changeIds.length, {
      message: 'Fixture resolution change IDs must be unique',
      path: ['changeIds'],
    }),
]);

export const fixtureConflictExpectationSchema = z
  .object({
    code: domainErrorCodeSchema,
    operationId: operationIdSchema.optional(),
    detail: z.string().trim().min(1).max(1_024).optional(),
  })
  .strict();

export const fixtureExpectedStatesSchema = z
  .object({
    before: fixtureDocumentStateSchema,
    proposed: fixtureDocumentStateSchema,
    accepted: fixtureDocumentStateSchema,
    rejected: fixtureDocumentStateSchema,
  })
  .strict();

export const fixtureExpectedSchema = z
  .object({
    states: fixtureExpectedStatesSchema,
    conflicts: z.array(fixtureConflictExpectationSchema).max(100).readonly(),
    generatedBlockIds: z.array(blockIdSchema).readonly(),
  })
  .strict()
  .refine(({ generatedBlockIds }) => new Set(generatedBlockIds).size === generatedBlockIds.length, {
    message: 'Expected generated block IDs must be unique',
    path: ['generatedBlockIds'],
  });

export const editorFixtureSchema = z
  .object({
    format: z.literal(FIXTURE_FORMAT),
    formatVersion: z.literal(FIXTURE_FORMAT_VERSION),
    id: documentIdSchema,
    title: z.string().trim().min(1).max(256),
    description: z.string().trim().min(1).max(2_048),
    seed: fixtureSeedSchema,
    schema: fixtureSchemaReferenceSchema,
    tags: z.array(z.string().trim().min(1).max(64)).max(32).readonly(),
    subject: fixtureSubjectSchema,
    request: applyEditsRequestSchema,
    resolution: fixtureResolutionSchema,
    expected: fixtureExpectedSchema,
    invariants: z.array(fixtureInvariantSchema).min(1).readonly(),
  })
  .strict()
  .superRefine((fixture, context) => {
    if (new Set(fixture.tags).size !== fixture.tags.length) {
      context.addIssue({
        code: 'custom',
        message: 'Fixture tags must be unique',
        path: ['tags'],
      });
    }

    const invariantIds = fixture.invariants.map(({ id }) => id);
    if (new Set(invariantIds).size !== invariantIds.length) {
      context.addIssue({
        code: 'custom',
        message: 'Fixture invariant IDs must be unique',
        path: ['invariants'],
      });
    }
  });

export const executableFixtureSchema = editorFixtureSchema;

export type FixtureSeed = z.infer<typeof fixtureSeedSchema>;
export type FixtureInvariantKind = z.infer<typeof fixtureInvariantKindSchema>;
export type FixtureInvariant = z.infer<typeof fixtureInvariantSchema>;
export type CanonicalDocumentJson = z.infer<typeof canonicalDocumentJsonSchema>;
export type FixtureChangeMetadata = z.infer<typeof fixtureChangeMetadataSchema>;
export type FixtureDocumentState = z.infer<typeof fixtureDocumentStateSchema>;
export type FixtureSchemaReference = z.infer<typeof fixtureSchemaReferenceSchema>;
export type FixtureTrackingStrategy = z.infer<typeof fixtureTrackingStrategySchema>;
export type FixtureSubject = z.infer<typeof fixtureSubjectSchema>;
export type FixtureResolution = z.infer<typeof fixtureResolutionSchema>;
export type FixtureConflictExpectation = z.infer<typeof fixtureConflictExpectationSchema>;
export type FixtureExpectedStates = z.infer<typeof fixtureExpectedStatesSchema>;
export type FixtureExpected = z.infer<typeof fixtureExpectedSchema>;
export type EditorFixture = z.infer<typeof editorFixtureSchema>;
export type ExecutableFixture = EditorFixture;
