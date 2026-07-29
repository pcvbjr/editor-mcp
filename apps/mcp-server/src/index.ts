import type { Readable, Writable } from 'node:stream';

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import {
  DomainError,
  assertChangeModeAllowed,
  toErrorEnvelope,
  type ApplyContext,
  type ApplyEditsResult,
  type AuthorizationContext,
  type DocumentReadResultV1,
  type ReadContext,
} from '@editor-mcp/core';
import {
  applyEditsRequestV1Schema,
  applyEditsResultSchema,
  documentReadRequestSchema,
  documentReadResultV1Schema,
} from '@editor-mcp/protocol';

import { createMcpServer, type CapabilityRegistrar, type CapabilityRegistry } from './server.js';

export const READ_TOOL_NAME = 'editor.document.read.v1';
export const APPLY_TOOL_NAME = 'editor.document.apply_edits.v1';

export interface McpEditorService {
  readDocumentV1(input: unknown, context: ReadContext): Promise<DocumentReadResultV1>;
  applyEdits(input: unknown, context: ApplyContext): Promise<ApplyEditsResult>;
}

export interface EditorMcpServerOptions {
  readonly service: McpEditorService;
  readonly authorization: (
    signal?: AbortSignal,
    authInfo?: AuthInfo,
  ) => Promise<AuthorizationContext>;
  readonly name?: string;
  readonly version?: string;
}

function jsonContent(value: unknown): {
  content: [{ type: 'text'; text: string }];
  structuredContent: Record<string, unknown>;
} {
  const structuredContent =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? { ...(value as Record<string, unknown>) }
      : { value };
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent,
  };
}

function mcpError(error: unknown): {
  isError: true;
  content: [{ type: 'text'; text: string }];
  structuredContent: Record<string, unknown>;
} {
  const envelope = toErrorEnvelope(error);
  return {
    isError: true,
    ...jsonContent(envelope),
  };
}

function controlledError(error: unknown, signal: AbortSignal): unknown {
  return signal.aborted
    ? new DomainError('DEADLINE_EXCEEDED', 'The MCP request was cancelled', true)
    : error;
}

function variable(variables: Record<string, string | string[]>, name: string): string {
  const value = variables[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new DomainError('INVALID_REQUEST', `Resource variable ${name} is required`, false);
  }
  return value;
}

function registerEditorCapabilities(
  registry: CapabilityRegistry,
  options: EditorMcpServerOptions,
): void {
  registry.registerTool(
    READ_TOOL_NAME,
    {
      title: 'Read editor document',
      description: 'Read a bounded semantic HTML projection and stable block digests.',
      inputSchema: documentReadRequestSchema,
      outputSchema: documentReadResultV1Schema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input, extra) => {
      try {
        const authorization = await options.authorization(extra.signal, extra.authInfo);
        const result = documentReadResultV1Schema.parse(
          await options.service.readDocumentV1(input, {
            authorization,
            signal: extra.signal,
          }),
        );
        return jsonContent(result);
      } catch (error) {
        return mcpError(controlledError(error, extra.signal));
      }
    },
  );

  registry.registerTool(
    APPLY_TOOL_NAME,
    {
      title: 'Apply semantic editor edits',
      description:
        'Apply one atomic, idempotent batch using stable block targets and target digests.',
      inputSchema: applyEditsRequestV1Schema,
      outputSchema: applyEditsResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input, extra) => {
      try {
        const authorization = await options.authorization(extra.signal, extra.authInfo);
        const parsedInput = applyEditsRequestV1Schema.parse(input);
        assertChangeModeAllowed(parsedInput.changeMode, authorization);
        const result = applyEditsResultSchema.parse(
          await options.service.applyEdits(input, {
            authorization,
            signal: extra.signal,
          }),
        );
        return jsonContent(result);
      } catch (error) {
        return mcpError(controlledError(error, extra.signal));
      }
    },
  );

  registry.registerResource(
    'editor-outline',
    new ResourceTemplate(
      'editor://tenants/{tenantId}/documents/{documentId}/incarnations/{documentIncarnation}/outline',
      { list: undefined },
    ),
    {
      title: 'Editor outline',
      description: 'Bounded semantic outline of an authorized document.',
      mimeType: 'application/json',
    },
    async (uri, variables, extra) => {
      try {
        const authorization = await options.authorization(extra.signal, extra.authInfo);
        const tenantId = variable(variables, 'tenantId');
        if (tenantId !== authorization.tenantId) {
          throw new DomainError(
            'PERMISSION_DENIED',
            'The resource tenant is not authorized',
            false,
          );
        }
        const result = documentReadResultV1Schema.parse(
          await options.service.readDocumentV1(
            {
              protocolVersion: 1,
              tenantId,
              documentId: variable(variables, 'documentId'),
              documentIncarnation: variable(variables, 'documentIncarnation'),
              collaborationField: 'default',
              schemaId: 'editor-mcp/mvp',
              schemaVersion: 1,
              selection: { kind: 'document' },
              representationProfile: 'outline/v1',
              maxBytes: 128_000,
            },
            { authorization, signal: extra.signal },
          ),
        );
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify(result),
            },
          ],
        };
      } catch (error) {
        const envelope = toErrorEnvelope(controlledError(error, extra.signal));
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify(envelope),
              _meta: { isError: true },
            },
          ],
        };
      }
    },
  );

  registry.registerResource(
    'editor-block',
    new ResourceTemplate(
      'editor://tenants/{tenantId}/documents/{documentId}/incarnations/{documentIncarnation}/blocks/{blockId}',
      { list: undefined },
    ),
    {
      title: 'Editor block',
      description: 'One bounded block projection with its current digest.',
      mimeType: 'application/json',
    },
    async (uri, variables, extra) => {
      try {
        const authorization = await options.authorization(extra.signal, extra.authInfo);
        const tenantId = variable(variables, 'tenantId');
        if (tenantId !== authorization.tenantId) {
          throw new DomainError(
            'PERMISSION_DENIED',
            'The resource tenant is not authorized',
            false,
          );
        }
        const result = documentReadResultV1Schema.parse(
          await options.service.readDocumentV1(
            {
              protocolVersion: 1,
              tenantId,
              documentId: variable(variables, 'documentId'),
              documentIncarnation: variable(variables, 'documentIncarnation'),
              collaborationField: 'default',
              schemaId: 'editor-mcp/mvp',
              schemaVersion: 1,
              selection: {
                kind: 'blocks',
                blockIds: [variable(variables, 'blockId')],
              },
              representationProfile: 'agent-html/v1',
              maxBytes: 128_000,
            },
            { authorization, signal: extra.signal },
          ),
        );
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify(result),
            },
          ],
        };
      } catch (error) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify(toErrorEnvelope(controlledError(error, extra.signal))),
              _meta: { isError: true },
            },
          ],
        };
      }
    },
  );
}

export function createEditorCapabilityRegistrar(
  options: EditorMcpServerOptions,
): CapabilityRegistrar {
  return (registry) => {
    registerEditorCapabilities(registry, options);
  };
}

export function createEditorMcpServer(options: EditorMcpServerOptions): McpServer {
  return createMcpServer({
    name: options.name ?? 'editor-mcp',
    version: options.version ?? '0.0.0',
    register: createEditorCapabilityRegistrar(options),
  });
}

export async function runStdioServer(
  server: McpServer,
  streams: {
    readonly input?: Readable;
    readonly output?: Writable;
  } = {},
): Promise<StdioServerTransport> {
  const transport = new StdioServerTransport(streams.input, streams.output);
  await server.connect(transport);
  return transport;
}
