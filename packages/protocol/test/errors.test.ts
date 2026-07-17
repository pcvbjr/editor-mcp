import { describe, expect, it } from 'vitest';

import { editorErrorCodeSchema, editorErrorEnvelopeSchema } from '../src/index.js';

const stableEditorErrorCodes = [
  'INVALID_REQUEST',
  'UNAUTHENTICATED',
  'PERMISSION_DENIED',
  'DOCUMENT_NOT_FOUND',
  'DOCUMENT_INCARNATION_MISMATCH',
  'SCHEMA_VERSION_MISMATCH',
  'TARGET_NOT_FOUND',
  'TARGET_AMBIGUOUS',
  'TARGET_CHANGED',
  'INVALID_CONTENT',
  'UNSUPPORTED_CONTENT',
  'PATCH_TOO_LARGE',
  'IDEMPOTENCY_MISMATCH',
  'DOCUMENT_UNAVAILABLE',
  'DEADLINE_EXCEEDED',
  'INTERNAL',
] as const;

describe('editor error code contract', () => {
  it('publishes the accepted stable taxonomy', () => {
    expect(editorErrorCodeSchema.options).toEqual(stableEditorErrorCodes);
  });

  it('rejects codes outside the public taxonomy', () => {
    expect(editorErrorCodeSchema.safeParse('BLOCK_NOT_FOUND').success).toBe(false);
  });
});

describe('editor error envelope contract', () => {
  it('accepts a safe, versioned error envelope', () => {
    expect(
      editorErrorEnvelopeSchema.parse({
        errorVersion: 1,
        code: 'TARGET_CHANGED',
        message: ' The target changed; read the block and retry. ',
        retryable: true,
        correlationId: 'request-01J0EXAMPLE',
      }),
    ).toEqual({
      errorVersion: 1,
      code: 'TARGET_CHANGED',
      message: 'The target changed; read the block and retry.',
      retryable: true,
      correlationId: 'request-01J0EXAMPLE',
    });
  });

  it.each([
    ['an unsupported envelope version', { errorVersion: 2 }],
    ['an empty message', { message: '   ' }],
    ['an oversized message', { message: 'x'.repeat(1_001) }],
    ['an empty correlation ID', { correlationId: '   ' }],
    ['an oversized correlation ID', { correlationId: 'x'.repeat(257) }],
    ['untyped details', { details: { document: '<p>sensitive</p>' } }],
  ])('rejects %s', (_description, override) => {
    expect(
      editorErrorEnvelopeSchema.safeParse({
        errorVersion: 1,
        code: 'INVALID_REQUEST',
        message: 'The request is invalid.',
        retryable: false,
        ...override,
      }).success,
    ).toBe(false);
  });
});
