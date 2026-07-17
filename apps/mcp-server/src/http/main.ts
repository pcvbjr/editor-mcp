import { createHttpApp } from './app.js';
import { parseHttpServerConfig, type HttpServerConfig } from './config.js';
import { runHttpServerProcess } from './process.js';
import { createHttpServerRuntime, type ServeFunction } from './runtime.js';
import { createNodeProcessControl, type ProcessControl } from '../process.js';
import type { CapabilityRegistrar } from '../server.js';

export interface HttpMainOptions {
  readonly config?: HttpServerConfig;
  readonly processControl?: ProcessControl;
  readonly serveFunction?: ServeFunction;
  readonly register?: CapabilityRegistrar;
}

export async function main({
  config = parseHttpServerConfig(),
  processControl = createNodeProcessControl(),
  serveFunction,
  register,
}: HttpMainOptions = {}): Promise<void> {
  const app = register ? createHttpApp({ config, register }) : createHttpApp({ config });
  const runtime = createHttpServerRuntime(app, config, serveFunction);

  await runHttpServerProcess({ runtime, processControl });
}
