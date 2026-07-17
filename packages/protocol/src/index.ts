import { z } from 'zod';

export {
  editorErrorCodeSchema,
  editorErrorEnvelopeSchema,
  type EditorErrorCode,
  type EditorErrorEnvelope,
} from './errors.js';

const opaqueIdSchema = z.string().min(1).max(256);
const blockIdSchema = z.uuid();
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const schemaIdSchema = z.literal('editor-mcp/mvp');
const schemaVersionSchema = z.literal(1);
const operationIdSchema = z.string().min(1).max(128);
const htmlWithoutInternalIdsSchema = z
  .string()
  .min(1)
  .max(100_000)
  .refine(
    (html) => !/\bdata-block-id\s*=/iu.test(html),
    'Inserted HTML must not contain block IDs',
  );

export const mvpSchemaCapabilitySchema = z
  .object({
    schemaId: schemaIdSchema,
    schemaVersion: schemaVersionSchema,
    nodes: z.array(z.string().min(1)).readonly(),
    marks: z.array(z.string().min(1)).readonly(),
  })
  .strict();

const blockSummarySchema = z
  .object({
    id: blockIdSchema,
    nodeType: z.string().min(1),
    contentDigest: digestSchema,
  })
  .strict();

export const documentReadResultSchema = z
  .object({
    documentId: opaqueIdSchema,
    documentIncarnation: opaqueIdSchema,
    revision: opaqueIdSchema,
    schemaId: schemaIdSchema,
    schemaVersion: schemaVersionSchema,
    html: z.string(),
    blocks: z.array(blockSummarySchema),
  })
  .strict();

const insertOperationSchema = z
  .object({
    operationId: operationIdSchema,
    kind: z.enum(['insert_before', 'insert_after']),
    anchorBlockId: blockIdSchema,
    expectedAnchorDigest: digestSchema.optional(),
    html: htmlWithoutInternalIdsSchema,
  })
  .strict();

const replaceBlockOperationSchema = z
  .object({
    operationId: operationIdSchema,
    kind: z.literal('replace_block'),
    blockId: blockIdSchema,
    expectedBlockDigest: digestSchema,
    html: htmlWithoutInternalIdsSchema,
  })
  .strict();

const deleteBlockOperationSchema = z
  .object({
    operationId: operationIdSchema,
    kind: z.literal('delete_block'),
    blockId: blockIdSchema,
    expectedBlockDigest: digestSchema,
  })
  .strict();

const tableRowOperationSchema = z
  .object({
    operationId: operationIdSchema,
    kind: z.enum(['insert_table_row', 'delete_table_row']),
    tableId: blockIdSchema,
    rowIndex: z.number().int().nonnegative(),
    expectedTableDigest: digestSchema,
    position: z.enum(['before', 'after']).optional(),
  })
  .strict();

const tableColumnOperationSchema = z
  .object({
    operationId: operationIdSchema,
    kind: z.enum(['insert_table_column', 'delete_table_column']),
    tableId: blockIdSchema,
    columnIndex: z.number().int().nonnegative(),
    expectedTableDigest: digestSchema,
    position: z.enum(['before', 'after']).optional(),
  })
  .strict();

export const editOperationSchema = z.discriminatedUnion('kind', [
  insertOperationSchema,
  replaceBlockOperationSchema,
  deleteBlockOperationSchema,
  tableRowOperationSchema,
  tableColumnOperationSchema,
]);

export const applyEditsRequestSchema = z
  .object({
    documentId: opaqueIdSchema,
    documentIncarnation: opaqueIdSchema,
    schemaId: schemaIdSchema,
    schemaVersion: schemaVersionSchema,
    idempotencyKey: z.string().min(8).max(256),
    changeMode: z.enum(['direct', 'suggest']).default('suggest'),
    operations: z.array(editOperationSchema).min(1).max(100),
  })
  .strict()
  .superRefine((request, context) => {
    const operationIds = new Set<string>();
    for (const [index, operation] of request.operations.entries()) {
      if (operationIds.has(operation.operationId)) {
        context.addIssue({
          code: 'custom',
          message: 'Operation IDs must be unique within a batch',
          path: ['operations', index, 'operationId'],
        });
      }
      operationIds.add(operation.operationId);
    }
  });

export type ApplyEditsRequest = z.infer<typeof applyEditsRequestSchema>;
export type DocumentReadResult = z.infer<typeof documentReadResultSchema>;
export type EditOperation = z.infer<typeof editOperationSchema>;
