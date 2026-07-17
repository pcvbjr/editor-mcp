import {
  DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
  ErrorCode,
  JSONRPC_VERSION,
} from '@modelcontextprotocol/sdk/types.js';

interface PreparedMcpPostRequest {
  readonly body: unknown;
  readonly request: Request;
}

const batchingProtocolVersion = '2025-03-26';
// The SDK reserves -32000 as its generic transport-level error code.
const transportNegotiationErrorCode = ErrorCode.ConnectionClosed;

export function createJsonRpcErrorResponse(
  status: number,
  code: ErrorCode,
  message: string,
): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: JSONRPC_VERSION,
      error: { code, message },
      id: null,
    }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

function mediaTypeEssence(value: string): string {
  return (value.split(';', 1)[0] ?? '').trim().toLowerCase();
}

function acceptedMediaTypes(value: string | null): Set<string> {
  if (value === null) return new Set();
  return new Set(
    value
      .split(',')
      .filter((range) => {
        const parameters = range.split(';').slice(1);
        return !parameters.some((parameter) => /^\s*q\s*=\s*0(?:\.0*)?\s*$/iu.test(parameter));
      })
      .map(mediaTypeEssence)
      .filter((mediaType) => mediaType.length > 0),
  );
}

function isInitializeMessage(value: unknown): value is { readonly method: 'initialize' } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'method' in value &&
    value.method === 'initialize'
  );
}

function rejectsBatch(body: unknown, request: Request): boolean {
  if (!Array.isArray(body)) return false;
  if (body.length === 0 || body.some(isInitializeMessage)) return true;

  const protocolVersion =
    request.headers.get('mcp-protocol-version') ?? DEFAULT_NEGOTIATED_PROTOCOL_VERSION;
  return protocolVersion !== batchingProtocolVersion;
}

export async function prepareMcpPostRequest(
  request: Request,
): Promise<PreparedMcpPostRequest | Response> {
  const accepted = acceptedMediaTypes(request.headers.get('accept'));
  if (!accepted.has('application/json') || !accepted.has('text/event-stream')) {
    return createJsonRpcErrorResponse(
      406,
      transportNegotiationErrorCode,
      'Not Acceptable: Client must accept both application/json and text/event-stream',
    );
  }
  if (mediaTypeEssence(request.headers.get('content-type') ?? '') !== 'application/json') {
    return createJsonRpcErrorResponse(
      415,
      transportNegotiationErrorCode,
      'Unsupported Media Type: Content-Type must be application/json',
    );
  }

  const transportHeaders = new Headers(request.headers);
  transportHeaders.set('accept', 'application/json, text/event-stream');
  transportHeaders.set('content-type', 'application/json');
  const transportRequest = new Request(request.url, {
    method: request.method,
    headers: transportHeaders,
    signal: request.signal,
  });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return createJsonRpcErrorResponse(400, ErrorCode.ParseError, 'Parse error: Invalid JSON');
  }
  if (rejectsBatch(body, transportRequest)) {
    return createJsonRpcErrorResponse(
      400,
      ErrorCode.InvalidRequest,
      'Invalid Request: JSON-RPC batching is not supported for this protocol version',
    );
  }

  return { body, request: transportRequest };
}
