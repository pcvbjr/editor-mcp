import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';

import { reportInternalError, type InternalErrorReporter } from './diagnostics.js';

export type CapabilityRegistrar = (server: McpServer) => void;

export interface CreateMcpServerOptions {
  readonly name: string;
  readonly version: string;
  readonly register?: CapabilityRegistrar;
  readonly reportError?: InternalErrorReporter;
}

type UncheckedToolCallback = (...parameters: unknown[]) => unknown;
type UncheckedRegisterTool = (
  name: string,
  config: unknown,
  callback: UncheckedToolCallback,
) => RegisteredTool;

function installSafeToolBoundary(
  server: McpServer,
  reportError: InternalErrorReporter | undefined,
): void {
  // The SDK method is generic and overloaded. Erase it only at this adapter boundary, then restore
  // the published type after wrapping every registered callback.
  const registerTool = server.registerTool.bind(server) as UncheckedRegisterTool;
  const safeRegisterTool: UncheckedRegisterTool = (name, config, callback) =>
    registerTool(name, config, async (...parameters) => {
      try {
        return await callback(...parameters);
      } catch (error: unknown) {
        reportInternalError(reportError, { phase: 'tool', operation: name, error });
        throw new Error('Tool execution failed', { cause: error });
      }
    });

  Object.defineProperty(server, 'registerTool', {
    configurable: false,
    value: safeRegisterTool,
    writable: false,
  });
}

export function createMcpServer(options: CreateMcpServerOptions): McpServer {
  const server = new McpServer({ name: options.name, version: options.version });
  installSafeToolBoundary(server, options.reportError);

  options.register?.(server);

  return server;
}
