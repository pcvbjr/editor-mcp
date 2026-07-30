import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import { reportInternalError, type InternalErrorReporter } from './diagnostics.js';
import type { ExecutionTracker } from './execution-tracker.js';

export interface CapabilityRegistry {
  readonly registerTool: McpServer['registerTool'];
  readonly registerResource: McpServer['registerResource'];
}

export type CapabilityRegistrar = (registry: CapabilityRegistry) => void;

export interface CreateMcpServerOptions {
  readonly name: string;
  readonly version: string;
  readonly register?: CapabilityRegistrar;
  readonly reportError?: InternalErrorReporter;
  readonly executionTracker?: ExecutionTracker;
}

type UncheckedToolCallback = (...parameters: unknown[]) => unknown;
type UncheckedRegisterTool = (
  name: string,
  config: unknown,
  callback: UncheckedToolCallback,
) => RegisteredTool;

const urlElicitationRequiredCode: number = ErrorCode.UrlElicitationRequired;

function safeToolCallback(
  name: string,
  callback: UncheckedToolCallback,
  reportError: InternalErrorReporter | undefined,
  executionTracker: ExecutionTracker | undefined,
): UncheckedToolCallback {
  return async (...parameters) => {
    const operation = async (): Promise<unknown> => {
      try {
        return await callback(...parameters);
      } catch (error: unknown) {
        if (error instanceof McpError && error.code === urlElicitationRequiredCode) {
          throw error;
        }
        reportInternalError(reportError, { phase: 'tool', operation: name, error });
        throw new Error('Tool execution failed', { cause: error });
      }
    };
    return executionTracker === undefined ? operation() : executionTracker.run(operation);
  };
}

function createCapabilityRegistry(
  server: McpServer,
  reportError: InternalErrorReporter | undefined,
  executionTracker: ExecutionTracker | undefined,
): CapabilityRegistry {
  // The SDK method is generic and overloaded. Erase it only at this adapter boundary, then restore
  // the public method type after wrapping the callback.
  const registerTool = server.registerTool.bind(server) as UncheckedRegisterTool;
  const safeRegisterTool: UncheckedRegisterTool = (name, config, callback) =>
    registerTool(name, config, safeToolCallback(name, callback, reportError, executionTracker));

  return {
    registerTool: safeRegisterTool as McpServer['registerTool'],
    registerResource: server.registerResource.bind(server),
  };
}

export function createMcpServer(options: CreateMcpServerOptions): McpServer {
  const server = new McpServer({ name: options.name, version: options.version });
  options.register?.(
    createCapabilityRegistry(server, options.reportError, options.executionTracker),
  );

  return server;
}
