import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export type CapabilityRegistrar = (server: McpServer) => void;

export interface CreateMcpServerOptions {
  readonly name: string;
  readonly version: string;
  readonly register?: CapabilityRegistrar;
}

export function createMcpServer(options: CreateMcpServerOptions): McpServer {
  const server = new McpServer({
    name: options.name,
    version: options.version,
  });

  options.register?.(server);

  return server;
}
