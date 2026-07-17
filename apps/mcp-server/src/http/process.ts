import type { AddressInfo } from 'node:net';

import type { HttpServerRuntime } from './runtime.js';
import type { ProcessControl, SupportedTerminationSignal } from '../process.js';

export interface RunHttpServerProcessOptions {
  readonly runtime: Pick<HttpServerRuntime, 'start' | 'close'>;
  readonly processControl: Pick<
    ProcessControl,
    'onSignal' | 'writeStderr' | 'setExitCode' | 'forceExit'
  >;
}

function describeError(error: unknown): string {
  if (!(error instanceof Error) || error.message.length === 0) return 'unknown error';
  return error.message.replace(/[\r\n]+/gu, ' ');
}

function formatAddress(address: AddressInfo): string {
  const host = address.address.includes(':') ? `[${address.address}]` : address.address;
  return `http://${host}:${String(address.port)}`;
}

export async function runHttpServerProcess({
  runtime,
  processControl,
}: RunHttpServerProcessOptions): Promise<void> {
  let shutdownPromise: Promise<void> | undefined;
  let shutdownStarted = false;
  let removeSignalHandlers: (() => void)[] = [];

  const shutdown = (): Promise<void> => {
    shutdownPromise ??= runtime
      .close()
      .catch((error: unknown) => {
        processControl.writeStderr(`MCP HTTP server failed to stop: ${describeError(error)}\n`);
        processControl.setExitCode(1);
      })
      .finally(() => {
        removeSignalHandlers.forEach((remove) => {
          remove();
        });
        removeSignalHandlers = [];
      });
    return shutdownPromise;
  };

  const handleSignal = (signal: SupportedTerminationSignal): void => {
    if (shutdownStarted) {
      processControl.forceExit(signal === 'SIGINT' ? 130 : 143);
      return;
    }
    shutdownStarted = true;
    void shutdown();
  };

  removeSignalHandlers = [
    processControl.onSignal('SIGINT', () => {
      handleSignal('SIGINT');
    }),
    processControl.onSignal('SIGTERM', () => {
      handleSignal('SIGTERM');
    }),
  ];

  try {
    const address = await runtime.start();
    processControl.writeStderr(`MCP HTTP server listening at ${formatAddress(address)}/mcp\n`);
  } catch (error: unknown) {
    processControl.writeStderr(`MCP HTTP server failed to start: ${describeError(error)}\n`);
    processControl.setExitCode(1);
    await shutdown();
  }
}
