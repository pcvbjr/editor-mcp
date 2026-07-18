import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import packageManifest from '../package.json' with { type: 'json' };

import { createMcpServerLifecycle } from './lifecycle.js';
import { createMcpServer, type CapabilityRegistrar } from './server.js';
import { createNodeProcessControl, runMcpServerProcess, type ProcessControl } from './process.js';

export interface MainOptions {
  readonly processControl?: ProcessControl;
  readonly transport?: Transport;
  readonly shutdownGraceMs?: number;
  readonly register?: CapabilityRegistrar;
}

export async function main({
  processControl,
  transport = new StdioServerTransport(),
  shutdownGraceMs,
  register,
}: MainOptions = {}): Promise<void> {
  const server = createMcpServer({
    name: packageManifest.name,
    version: packageManifest.version,
    ...(register === undefined ? {} : { register }),
  });
  const lifecycle = createMcpServerLifecycle(server, transport);

  await runMcpServerProcess({
    lifecycle,
    processControl: processControl ?? createNodeProcessControl(),
    shutdownGraceMs,
  });
}
