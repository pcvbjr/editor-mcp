import { expect, it, vi } from 'vitest';

import { createHttpServerConfig } from '../../src/http/config.js';
import { main } from '../../src/http/main.js';
import type { ServeFunction } from '../../src/http/runtime.js';
import type { ProcessControl, SupportedTerminationSignal } from '../../src/process.js';

it('composes an importable HTTP app and closes it through the process boundary', async () => {
  const signals = new Map<SupportedTerminationSignal, () => void>();
  const close = vi.fn((callback: (error?: Error) => void) => {
    callback();
  });
  const serveFunction: ServeFunction = (_options, listening) => {
    listening?.({ address: '127.0.0.1', family: 'IPv4', port: 31_000 });
    return { close, closeAllConnections: vi.fn(), once: vi.fn() } as never;
  };
  const processControl: ProcessControl = {
    onSignal(signal, listener) {
      signals.set(signal, listener);
      return () => {
        signals.delete(signal);
      };
    },
    onStdinEnd: () => () => undefined,
    scheduleTimeout: () => () => undefined,
    writeStderr: vi.fn(),
    setExitCode: vi.fn(),
    forceExit: vi.fn(),
  };

  await main({
    config: createHttpServerConfig({ port: 0 }),
    processControl,
    serveFunction,
  });
  signals.get('SIGTERM')?.();

  await vi.waitFor(() => {
    expect(close).toHaveBeenCalledOnce();
  });
  expect(processControl.writeStderr).toHaveBeenCalledWith(
    'MCP HTTP server listening at http://127.0.0.1:31000/mcp\n',
  );
});
