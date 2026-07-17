export type AdapterErrorCode =
  | 'ALREADY_RESOLVED'
  | 'BLOCK_NOT_FOUND'
  | 'CHANGE_NOT_FOUND'
  | 'DUPLICATE_BLOCK_ID'
  | 'INCOMPLETE_CHANGE_GROUP'
  | 'INVALID_BLOCK_ID'
  | 'INVALID_DOCUMENT'
  | 'INVALID_HTML'
  | 'INVALID_NESTING'
  | 'INVALID_TRACKING'
  | 'METADATA_CONFLICT'
  | 'MISSING_BLOCK_ID'
  | 'MODEL_SUPPLIED_ID'
  | 'RESOLUTION_METADATA_REQUIRED'
  | 'RESOURCE_LIMIT'
  | 'UNSAFE_LINK'
  | 'UNSUPPORTED_ATTRIBUTE'
  | 'UNSUPPORTED_ELEMENT';

export class AdapterValidationError extends Error {
  readonly code: AdapterErrorCode;
  readonly details: Readonly<Record<string, string | number | boolean>>;

  constructor(
    code: AdapterErrorCode,
    message: string,
    details: Readonly<Record<string, string | number | boolean>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'AdapterValidationError';
    this.code = code;
    this.details = details;
  }
}

export function isAdapterValidationError(error: unknown): error is AdapterValidationError {
  return error instanceof AdapterValidationError;
}
