import { z } from 'zod';

export const PROTOCOL_VERSION = 1 as const;
export const MVP_SCHEMA_ID = 'editor-mcp/mvp' as const;
export const MVP_SCHEMA_VERSION = 1 as const;

export const MVP_NODE_TYPES = [
  'doc',
  'text',
  'paragraph',
  'heading',
  'blockquote',
  'bulletList',
  'orderedList',
  'listItem',
  'codeBlock',
  'horizontalRule',
  'hardBreak',
  'table',
  'tableRow',
  'tableHeader',
  'tableCell',
] as const;

export const MVP_MARK_TYPES = ['bold', 'italic', 'strike', 'code', 'link', 'diffChange'] as const;

export const MVP_OPERATION_KINDS = [
  'insert_before',
  'insert_after',
  'replace_block',
  'delete_block',
  'insert_text',
  'delete_text',
  'replace_text',
  'format_text',
  'insert_table_row',
  'delete_table_row',
  'insert_table_column',
  'delete_table_column',
  'accept_change',
  'reject_change',
] as const;

export const MVP_REVIEW_MODES = ['direct', 'suggest'] as const;

export const CONTRACT_COMPATIBILITY_POLICY = Object.freeze({
  currentProtocolVersion: PROTOCOL_VERSION,
  supportedProtocolVersions: [PROTOCOL_VERSION] as const,
  compatibility: 'backward-compatible-within-v1' as const,
  unknownFields: 'reject' as const,
  unknownOperationKinds: 'reject' as const,
  unsupportedVersions: 'reject' as const,
  legacySchemas: [
    'mvpSchemaCapabilitySchema',
    'documentReadResultSchema',
    'applyEditsRequestSchema',
  ] as const,
});

export const IDEMPOTENCY_REPLAY_RULES = Object.freeze({
  scope: [
    'tenantId',
    'principalId',
    'documentId',
    'documentIncarnation',
    'idempotencyKey',
  ] as const,
  sameKeySameRequest: 'return-original-result' as const,
  sameKeyDifferentRequest: 'reject-idempotency-mismatch' as const,
  concurrentSameKey: 'single-writer' as const,
  generatedIdsOnReplay: 'return-original-generated-ids' as const,
});

export const protocolVersionSchema = z.literal(PROTOCOL_VERSION);
export const schemaIdSchema = z.literal(MVP_SCHEMA_ID);
export const schemaVersionSchema = z.literal(MVP_SCHEMA_VERSION);
export const opaqueIdSchema = z.string().trim().min(1).max(256);
export const tenantIdSchema = opaqueIdSchema;
export const documentIdSchema = opaqueIdSchema;
export const documentIncarnationSchema = opaqueIdSchema;
export const collaborationFieldSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
export const principalIdSchema = opaqueIdSchema;
export const operationIdSchema = z.string().trim().min(1).max(128);
export const changeIdSchema = opaqueIdSchema;
export const changeSetIdSchema = opaqueIdSchema;
export const changeGroupIdSchema = opaqueIdSchema;
export const traceIdSchema = opaqueIdSchema;
export const revisionSchema = opaqueIdSchema;
export const adapterVersionSchema = z.string().trim().min(1).max(128);
export const policyVersionSchema = z.string().trim().min(1).max(128);
export const idempotencyKeySchema = z.string().min(8).max(256);
export const blockIdSchema = z.uuid();
export const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
export const timestampSchema = z.iso.datetime({ offset: true });
export const changeModeSchema = z.enum(MVP_REVIEW_MODES);
export const operationKindSchema = z.enum(MVP_OPERATION_KINDS);

export const htmlWithoutInternalIdsSchema = z
  .string()
  .min(1)
  .max(100_000)
  .refine(
    (html) => !/\bdata-block-id\s*=/iu.test(html),
    'Inserted HTML must not contain block IDs',
  );

const hasAllowedLinkScheme = (href: string): boolean => {
  const hasControlCharacter = Array.from(href).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });

  if (hasControlCharacter || href.startsWith('//')) {
    return false;
  }

  const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(href);
  return (
    scheme === null ||
    scheme[1]?.toLowerCase() === 'http' ||
    scheme[1]?.toLowerCase() === 'https' ||
    scheme[1]?.toLowerCase() === 'mailto'
  );
};

export const safeLinkHrefSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .refine(hasAllowedLinkScheme, 'Link scheme is not allowed');

export type ProtocolVersion = z.infer<typeof protocolVersionSchema>;
export type OperationKind = z.infer<typeof operationKindSchema>;
export type ChangeMode = z.infer<typeof changeModeSchema>;
export type BlockId = z.infer<typeof blockIdSchema>;
export type Digest = z.infer<typeof digestSchema>;
