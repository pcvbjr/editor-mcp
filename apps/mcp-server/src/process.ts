import process from 'node:process';

import type { McpServerLifecycle } from './lifecycle.js';

export type SupportedTerminationSignal = 'SIGINT' | 'SIGTERM';

export interface ProcessControl {
  readonly onSignal: (signal: SupportedTerminationSignal, listener: () => void) => () => void;
  readonly onStdinEnd: (listener: () => void) => () => void;
  readonly scheduleTimeout: (listener: () => void, milliseconds: number) => () => void;
  readonly writeStderr: (message: string) => void;
  readonly setExitCode: (code: number) => void;
  readonly forceExit: (code: number) => void;
}

export interface RunMcpServerProcessOptions {
  readonly lifecycle: Pick<McpServerLifecycle, 'start' | 'close'>;
  readonly processControl?: ProcessControl;
  readonly shutdownGraceMs?: number | undefined;
}

/* v8 ignore start -- this adapter runs in the compiled child-process integration test. */
export function createNodeProcessControl(): ProcessControl {
  return {
    onSignal(signal, listener) {
      process.on(signal, listener);
      return () => process.off(signal, listener);
    },
    onStdinEnd(listener) {
      process.stdin.on('end', listener);
      process.stdin.on('close', listener);
      return () => {
        process.stdin.off('end', listener);
        process.stdin.off('close', listener);
      };
    },
    scheduleTimeout(listener, milliseconds) {
      const timer = setTimeout(listener, milliseconds);
      timer.unref();
      return () => {
        clearTimeout(timer);
      };
    },
    writeStderr(message) {
      process.stderr.write(message);
    },
    setExitCode(code) {
      process.exitCode = code;
    },
    forceExit(code) {
      process.exit(code);
    },
  };
}
/* v8 ignore stop */

function describeError(error: unknown): string {
  if (!(error instanceof Error) || error.message.length === 0) {
    return 'unknown error';
  }
  return error.message.replace(/[\r\n]+/gu, ' ');
}

export async function runMcpServerProcess({
  lifecycle,
  processControl = createNodeProcessControl(),
  shutdownGraceMs = 5_000,
}: RunMcpServerProcessOptions): Promise<void> {
  let shutdownPromise: Promise<void> | undefined;
  let shutdownStarted = false;
  let cancelShutdownDeadline: (() => void) | undefined;

  const reportFailure = (phase: 'start' | 'stop' | 'timeout', error?: unknown): void => {
    const detail = error === undefined ? '' : `: ${describeError(error)}`;
    processControl.writeStderr(`MCP server failed to ${phase}${detail}\n`);
    processControl.setExitCode(1);
  };

  const shutdown = (): Promise<void> => {
    if (shutdownPromise !== undefined) {
      return shutdownPromise;
    }
    shutdownStarted = true;
    cancelShutdownDeadline = processControl.scheduleTimeout(() => {
      reportFailure('timeout');
      processControl.forceExit(1);
    }, shutdownGraceMs);
    shutdownPromise = lifecycle
      .close()
      .catch((error: unknown) => {
        reportFailure('stop', error);
        processControl.forceExit(1);
      })
      .finally(() => {
        cancelShutdownDeadline?.();
        removeSignalHandlers();
        removeStdinHandler();
      });
    return shutdownPromise;
  };

  const handleSignal = (signal: SupportedTerminationSignal): void => {
    if (shutdownStarted) {
      processControl.forceExit(signal === 'SIGINT' ? 130 : 143);
      return;
    }
    void shutdown();
  };

  const removeSignalHandlers = [
    processControl.onSignal('SIGINT', () => {
      handleSignal('SIGINT');
    }),
    processControl.onSignal('SIGTERM', () => {
      handleSignal('SIGTERM');
    }),
  ].reduce((removeAll, remove) => () => {
    removeAll();
    remove();
  });
  const removeStdinHandler = processControl.onStdinEnd(() => {
    void shutdown();
  });

  try {
    await lifecycle.start();
  } catch (error: unknown) {
    reportFailure('start', error);
    await shutdown();
  }
}
