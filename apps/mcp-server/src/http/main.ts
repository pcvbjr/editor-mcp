import { createHttpApp } from './app.js';
import { parseHttpServerConfig, type HttpServerConfig } from './config.js';
import { runHttpServerProcess } from './process.js';
import { createHttpServerRuntime, type ServeFunction } from './runtime.js';
import { createNodeProcessControl, type ProcessControl } from '../process.js';
import type { CapabilityRegistrar } from '../server.js';
import { createStderrErrorReporter, type InternalErrorReporter } from '../diagnostics.js';

export interface HttpMainOptions {
  readonly config?: HttpServerConfig;
  readonly processControl?: ProcessControl;
  readonly serveFunction?: ServeFunction;
  readonly register?: CapabilityRegistrar;
  readonly reportError?: InternalErrorReporter;
}

export async function main({
  config = parseHttpServerConfig(),
  processControl = createNodeProcessControl(),
  serveFunction,
  register,
  reportError = createStderrErrorReporter(processControl.writeStderr),
}: HttpMainOptions = {}): Promise<void> {
  const app = register
    ? createHttpApp({ config, register, reportError })
    : createHttpApp({ config, reportError });
  const runtime = createHttpServerRuntime(app, config, serveFunction, reportError);

  await runHttpServerProcess({ runtime, processControl });
}
