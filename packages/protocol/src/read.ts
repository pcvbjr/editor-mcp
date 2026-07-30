import { z } from 'zod';

import {
  MVP_NODE_TYPES,
  blockIdSchema,
  digestSchema,
  documentIdSchema,
  documentIncarnationSchema,
  MVP_OPERATION_KINDS,
  MVP_REVIEW_MODES,
  protocolVersionSchema,
  revisionSchema,
  schemaIdSchema,
  schemaVersionSchema,
} from './base.js';
import { documentIdentitySchema } from './identity.js';

export const mvpSchemaCapabilitySchema = z
  .object({
    schemaId: schemaIdSchema,
    schemaVersion: schemaVersionSchema,
    nodes: z.array(z.string().min(1)).readonly(),
    marks: z.array(z.string().min(1)).readonly(),
  })
  .strict();

export const mvpCapabilityManifestSchema = z
  .object({
    schemaId: schemaIdSchema,
    schemaVersion: schemaVersionSchema,
    nodes: z.tuple([
      z.literal('doc'),
      z.literal('text'),
      z.literal('paragraph'),
      z.literal('heading'),
      z.literal('blockquote'),
      z.literal('bulletList'),
      z.literal('orderedList'),
      z.literal('listItem'),
      z.literal('codeBlock'),
      z.literal('horizontalRule'),
      z.literal('hardBreak'),
      z.literal('table'),
      z.literal('tableRow'),
      z.literal('tableHeader'),
      z.literal('tableCell'),
    ]),
    marks: z.tuple([
      z.literal('bold'),
      z.literal('italic'),
      z.literal('strike'),
      z.literal('code'),
      z.literal('link'),
      z.literal('diffChange'),
    ]),
  })
  .strict();

export const documentCapabilitiesSchema = z
  .object({
    reviewModes: z.array(z.enum(MVP_REVIEW_MODES)).min(1).readonly(),
    operations: z.array(z.enum(MVP_OPERATION_KINDS)).min(1).readonly(),
    representationProfiles: z
      .array(z.enum(['agent-html/v1', 'prosemirror-json/v1', 'plain-text/v1', 'outline/v1']))
      .min(1)
      .readonly(),
  })
  .strict()
  .superRefine((capabilities, context) => {
    const fields = [
      ['reviewModes', capabilities.reviewModes],
      ['operations', capabilities.operations],
      ['representationProfiles', capabilities.representationProfiles],
    ] as const;

    for (const [field, values] of fields) {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: 'custom',
          message: `${field} entries must be unique`,
          path: [field],
        });
      }
    }
  });

export const blockSummarySchema = z
  .object({
    id: blockIdSchema,
    nodeType: z.enum(
      MVP_NODE_TYPES.filter((nodeType) => nodeType !== 'doc' && nodeType !== 'text'),
    ),
    contentDigest: digestSchema,
  })
  .strict();

export const outlineEntrySchema = z
  .object({
    id: blockIdSchema,
    nodeType: z.string().min(1).max(128),
    level: z.number().int().min(1).max(64).optional(),
    text: z.string().max(10_000).optional(),
  })
  .strict();

export const documentRepresentationSchema = z.discriminatedUnion('profile', [
  z
    .object({
      profile: z.literal('agent-html/v1'),
      html: z.string().max(1_000_000),
    })
    .strict(),
  z
    .object({
      profile: z.literal('prosemirror-json/v1'),
      json: z.json(),
    })
    .strict(),
  z
    .object({
      profile: z.literal('plain-text/v1'),
      text: z.string().max(1_000_000),
    })
    .strict(),
  z
    .object({
      profile: z.literal('outline/v1'),
      entries: z.array(outlineEntrySchema).max(10_000).readonly(),
    })
    .strict(),
]);

export const documentReadSelectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('document') }).strict(),
  z
    .object({
      kind: z.literal('blocks'),
      blockIds: z.array(blockIdSchema).min(1).max(100).readonly(),
    })
    .strict()
    .refine(({ blockIds }) => new Set(blockIds).size === blockIds.length, {
      message: 'Selected block IDs must be unique',
      path: ['blockIds'],
    }),
]);

export const documentReadRequestSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    ...documentIdentitySchema.shape,
    selection: documentReadSelectionSchema,
    representationProfile: z.enum([
      'agent-html/v1',
      'prosemirror-json/v1',
      'plain-text/v1',
      'outline/v1',
    ]),
    ifRevision: revisionSchema.optional(),
    maxBytes: z.number().int().positive().max(1_000_000).optional(),
  })
  .strict();

/**
 * The original un-enveloped read contract remains public for existing package
 * consumers. New transports should use {@link documentReadResultV1Schema}.
 */
export const documentReadResultSchema = z
  .object({
    documentId: documentIdSchema,
    documentIncarnation: documentIncarnationSchema,
    revision: revisionSchema,
    schemaId: schemaIdSchema,
    schemaVersion: schemaVersionSchema,
    html: z.string(),
    blocks: z.array(blockSummarySchema),
  })
  .strict();

export const documentReadResultV1Schema = z
  .object({
    protocolVersion: protocolVersionSchema,
    ...documentIdentitySchema.shape,
    revision: revisionSchema,
    capabilities: documentCapabilitiesSchema,
    representation: documentRepresentationSchema,
    blocks: z.array(blockSummarySchema).max(10_000).readonly(),
    truncated: z.boolean(),
  })
  .strict();

export type MvpSchemaCapability = z.infer<typeof mvpSchemaCapabilitySchema>;
export type MvpCapabilityManifest = z.infer<typeof mvpCapabilityManifestSchema>;
export type DocumentCapabilities = z.infer<typeof documentCapabilitiesSchema>;
export type BlockSummary = z.infer<typeof blockSummarySchema>;
export type OutlineEntry = z.infer<typeof outlineEntrySchema>;
export type DocumentRepresentation = z.infer<typeof documentRepresentationSchema>;
export type DocumentReadSelection = z.infer<typeof documentReadSelectionSchema>;
export type DocumentReadRequest = z.infer<typeof documentReadRequestSchema>;
export type DocumentReadResult = z.infer<typeof documentReadResultSchema>;
export type DocumentReadResultV1 = z.infer<typeof documentReadResultV1Schema>;
