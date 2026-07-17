import type { AddressInfo } from 'node:net';

import { describe, expect, it, vi } from 'vitest';

import { runHttpServerProcess } from '../../src/http/process.js';
import type { ProcessControl, SupportedTerminationSignal } from '../../src/process.js';

const address: AddressInfo = { address: '::1', family: 'IPv6', port: 30_000 };

function createProcessControl() {
  const signalListeners = new Map<SupportedTerminationSignal, () => void>();
  const removals: ReturnType<typeof vi.fn>[] = [];
  const control: ProcessControl = {
    onSignal(signal, listener) {
      signalListeners.set(signal, listener);
      const remove = vi.fn(() => {
        signalListeners.delete(signal);
      });
      removals.push(remove);
      return remove;
    },
    onStdinEnd: () => () => undefined,
    scheduleTimeout: () => () => undefined,
    writeStdout: vi.fn(),
    writeStderr: vi.fn(),
    setExitCode: vi.fn(),
    forceExit: vi.fn(),
  };
  return {
    control,
    removals,
    emit(signal: SupportedTerminationSignal) {
      signalListeners.get(signal)?.();
    },
  };
}

describe('HTTP process orchestration', () => {
  it('reports readiness and removes signal listeners after graceful shutdown', async () => {
    const close = vi.fn(() => Promise.resolve());
    const processControl = createProcessControl();

    await runHttpServerProcess({
      runtime: { start: () => Promise.resolve(address), close },
      processControl: processControl.control,
    });
    expect(processControl.control.writeStdout).toHaveBeenCalledWith(
      'MCP HTTP server listening at http://[::1]:30000/mcp\n',
    );

    processControl.emit('SIGTERM');
    await vi.waitFor(() => {
      expect(close).toHaveBeenCalledOnce();
      expect(processControl.removals.every((remove) => remove.mock.calls.length === 1)).toBe(true);
    });
    expect(processControl.control.setExitCode).not.toHaveBeenCalled();
  });

  it('reports startup failures, closes, and sets a failing exit code', async () => {
    const close = vi.fn(() => Promise.resolve());
    const processControl = createProcessControl();

    await runHttpServerProcess({
      runtime: { start: () => Promise.reject(new Error('secret\nstartup')), close },
      processControl: processControl.control,
    });

    expect(processControl.control.writeStderr).toHaveBeenCalledWith(
      'MCP HTTP server failed to start: secret startup\n',
    );
    expect(processControl.control.setExitCode).toHaveBeenCalledWith(1);
    expect(close).toHaveBeenCalledOnce();
  });

  it('reports close failures and sets a failing exit code', async () => {
    const processControl = createProcessControl();
    await runHttpServerProcess({
      runtime: {
        start: () => Promise.resolve(address),
        close: () => Promise.reject(new Error('close failed')),
      },
      processControl: processControl.control,
    });

    processControl.emit('SIGINT');
    await vi.waitFor(() => {
      expect(processControl.control.writeStderr).toHaveBeenCalledWith(
        'MCP HTTP server failed to stop: close failed\n',
      );
    });
    expect(processControl.control.setExitCode).toHaveBeenCalledWith(1);
    expect(processControl.control.forceExit).toHaveBeenCalledWith(1);
  });

  it('forces the conventional exit code on a second termination signal', async () => {
    let finishClose: (() => void) | undefined;
    const processControl = createProcessControl();
    await runHttpServerProcess({
      runtime: {
        start: () => Promise.resolve(address),
        close: () =>
          new Promise<void>((resolve) => {
            finishClose = resolve;
          }),
      },
      processControl: processControl.control,
    });

    processControl.emit('SIGINT');
    processControl.emit('SIGTERM');
    expect(processControl.control.forceExit).toHaveBeenCalledWith(143);
    finishClose?.();
  });

  it('does not announce readiness when shutdown starts before listening', async () => {
    let finishStart: ((address: AddressInfo) => void) | undefined;
    const close = vi.fn(() => Promise.resolve());
    const processControl = createProcessControl();
    const run = runHttpServerProcess({
      runtime: {
        start: () =>
          new Promise<AddressInfo>((resolve) => {
            finishStart = resolve;
          }),
        close,
      },
      processControl: processControl.control,
    });

    processControl.emit('SIGTERM');
    finishStart?.(address);
    await run;
    await vi.waitFor(() => {
      expect(close).toHaveBeenCalledOnce();
    });

    expect(processControl.control.writeStderr).not.toHaveBeenCalledWith(
      expect.stringContaining('listening'),
    );
  });
});
