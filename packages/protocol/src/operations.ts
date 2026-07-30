import { z } from 'zod';

import {
  blockIdSchema,
  changeIdSchema,
  digestSchema,
  htmlWithoutInternalIdsSchema,
  operationIdSchema,
  operationKindSchema,
  safeLinkHrefSchema,
} from './base.js';

const nonEmptyTextSchema = z.string().min(1).max(100_000);
const textOffsetSchema = z.number().int().nonnegative();

export const textRangeSchema = z
  .object({
    from: textOffsetSchema,
    to: textOffsetSchema,
  })
  .strict()
  .refine(({ from, to }) => to > from, {
    message: 'Text range end must be greater than its start',
    path: ['to'],
  });

export const formatMarkSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('bold') }).strict(),
  z.object({ type: z.literal('italic') }).strict(),
  z.object({ type: z.literal('strike') }).strict(),
  z.object({ type: z.literal('code') }).strict(),
  z
    .object({
      type: z.literal('link'),
      href: safeLinkHrefSchema,
      title: z.string().max(1_024).optional(),
    })
    .strict(),
]);

const operationBaseShape = {
  operationId: operationIdSchema,
};

export const insertBeforeOperationSchema = z
  .object({
    ...operationBaseShape,
    kind: z.literal('insert_before'),
    anchorBlockId: blockIdSchema,
    expectedAnchorDigest: digestSchema.optional(),
    html: htmlWithoutInternalIdsSchema,
  })
  .strict();

export const insertAfterOperationSchema = z
  .object({
    ...operationBaseShape,
    kind: z.literal('insert_after'),
    anchorBlockId: blockIdSchema,
    expectedAnchorDigest: digestSchema.optional(),
    html: htmlWithoutInternalIdsSchema,
  })
  .strict();

export const replaceBlockOperationSchema = z
  .object({
    ...operationBaseShape,
    kind: z.literal('replace_block'),
    blockId: blockIdSchema,
    expectedBlockDigest: digestSchema,
    html: htmlWithoutInternalIdsSchema,
  })
  .strict();

export const deleteBlockOperationSchema = z
  .object({
    ...operationBaseShape,
    kind: z.literal('delete_block'),
    blockId: blockIdSchema,
    expectedBlockDigest: digestSchema,
  })
  .strict();

export const insertTextOperationSchema = z
  .object({
    ...operationBaseShape,
    kind: z.literal('insert_text'),
    blockId: blockIdSchema,
    expectedBlockDigest: digestSchema,
    offset: textOffsetSchema,
    text: nonEmptyTextSchema,
  })
  .strict();

export const deleteTextOperationSchema = z
  .object({
    ...operationBaseShape,
    kind: z.literal('delete_text'),
    blockId: blockIdSchema,
    expectedBlockDigest: digestSchema,
    range: textRangeSchema,
  })
  .strict();

export const replaceTextOperationSchema = z
  .object({
    ...operationBaseShape,
    kind: z.literal('replace_text'),
    blockId: blockIdSchema,
    expectedBlockDigest: digestSchema,
    range: textRangeSchema,
    text: nonEmptyTextSchema,
  })
  .strict();

export const formatTextOperationSchema = z
  .object({
    ...operationBaseShape,
    kind: z.literal('format_text'),
    blockId: blockIdSchema,
    expectedBlockDigest: digestSchema,
    range: textRangeSchema,
    action: z.enum(['add', 'remove']),
    mark: formatMarkSchema,
  })
  .strict();

export const insertTableRowOperationSchema = z
  .object({
    ...operationBaseShape,
    kind: z.literal('insert_table_row'),
    tableId: blockIdSchema,
    rowIndex: z.number().int().nonnegative(),
    expectedTableDigest: digestSchema,
    position: z.enum(['before', 'after']).optional(),
  })
  .strict();

export const deleteTableRowOperationSchema = z
  .object({
    ...operationBaseShape,
    kind: z.literal('delete_table_row'),
    tableId: blockIdSchema,
    rowIndex: z.number().int().nonnegative(),
    expectedTableDigest: digestSchema,
  })
  .strict();

export const insertTableColumnOperationSchema = z
  .object({
    ...operationBaseShape,
    kind: z.literal('insert_table_column'),
    tableId: blockIdSchema,
    columnIndex: z.number().int().nonnegative(),
    expectedTableDigest: digestSchema,
    position: z.enum(['before', 'after']).optional(),
  })
  .strict();

export const deleteTableColumnOperationSchema = z
  .object({
    ...operationBaseShape,
    kind: z.literal('delete_table_column'),
    tableId: blockIdSchema,
    columnIndex: z.number().int().nonnegative(),
    expectedTableDigest: digestSchema,
  })
  .strict();

export const acceptChangeOperationSchema = z
  .object({
    ...operationBaseShape,
    kind: z.literal('accept_change'),
    changeId: changeIdSchema,
    expectedChangeRevision: digestSchema.optional(),
  })
  .strict();

export const rejectChangeOperationSchema = z
  .object({
    ...operationBaseShape,
    kind: z.literal('reject_change'),
    changeId: changeIdSchema,
    expectedChangeRevision: digestSchema.optional(),
  })
  .strict();

export const editOperationSchema = z.discriminatedUnion('kind', [
  insertBeforeOperationSchema,
  insertAfterOperationSchema,
  replaceBlockOperationSchema,
  deleteBlockOperationSchema,
  insertTextOperationSchema,
  deleteTextOperationSchema,
  replaceTextOperationSchema,
  formatTextOperationSchema,
  insertTableRowOperationSchema,
  deleteTableRowOperationSchema,
  insertTableColumnOperationSchema,
  deleteTableColumnOperationSchema,
  acceptChangeOperationSchema,
  rejectChangeOperationSchema,
]);

export const operationKindContractSchema = operationKindSchema;

export type TextRange = z.infer<typeof textRangeSchema>;
export type FormatMark = z.infer<typeof formatMarkSchema>;
export type InsertBeforeOperation = z.infer<typeof insertBeforeOperationSchema>;
export type InsertAfterOperation = z.infer<typeof insertAfterOperationSchema>;
export type ReplaceBlockOperation = z.infer<typeof replaceBlockOperationSchema>;
export type DeleteBlockOperation = z.infer<typeof deleteBlockOperationSchema>;
export type InsertTextOperation = z.infer<typeof insertTextOperationSchema>;
export type DeleteTextOperation = z.infer<typeof deleteTextOperationSchema>;
export type ReplaceTextOperation = z.infer<typeof replaceTextOperationSchema>;
export type FormatTextOperation = z.infer<typeof formatTextOperationSchema>;
export type InsertTableRowOperation = z.infer<typeof insertTableRowOperationSchema>;
export type DeleteTableRowOperation = z.infer<typeof deleteTableRowOperationSchema>;
export type InsertTableColumnOperation = z.infer<typeof insertTableColumnOperationSchema>;
export type DeleteTableColumnOperation = z.infer<typeof deleteTableColumnOperationSchema>;
export type AcceptChangeOperation = z.infer<typeof acceptChangeOperationSchema>;
export type RejectChangeOperation = z.infer<typeof rejectChangeOperationSchema>;
export type EditOperation = z.infer<typeof editOperationSchema>;
