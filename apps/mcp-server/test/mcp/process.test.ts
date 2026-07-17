import type { ProcessControl } from '../../src/process.js';
import { describe, expect, it, vi } from 'vitest';

import { runMcpServerProcess } from '../../src/process.js';

function createProcessControl() {
  const signalListeners = new Map<string, () => void>();
  const stdinListeners = new Set<() => void>();
  const timeoutListeners = new Map<number, () => void>();
  let nextTimeoutId = 0;
  const control: ProcessControl = {
    onSignal(signal, listener) {
      signalListeners.set(signal, listener);
      return () => signalListeners.delete(signal);
    },
    onStdinEnd(listener) {
      stdinListeners.add(listener);
      return () => stdinListeners.delete(listener);
    },
    scheduleTimeout(listener) {
      const id = nextTimeoutId++;
      timeoutListeners.set(id, listener);
      return () => timeoutListeners.delete(id);
    },
    writeStderr: vi.fn(),
    setExitCode: vi.fn(),
    forceExit: vi.fn(),
  };

  return {
    control,
    emitSignal: (signal: 'SIGINT' | 'SIGTERM') => {
      signalListeners.get(signal)?.();
    },
    emitStdinEnd: () => {
      [...stdinListeners].forEach((listener) => {
        listener();
      });
    },
    fireTimeout: () => {
      [...timeoutListeners.values()].forEach((listener) => {
        listener();
      });
    },
  };
}

describe('MCP process lifecycle', () => {
  it('routes stdin end through the same idempotent shutdown path', async () => {
    const start = vi.fn(() => Promise.resolve());
    const close = vi.fn(() => Promise.resolve());
    const processControl = createProcessControl();

    await runMcpServerProcess({
      lifecycle: { start, close },
      processControl: processControl.control,
    });
    processControl.emitStdinEnd();
    processControl.emitStdinEnd();

    await vi.waitFor(() => {
      expect(close).toHaveBeenCalledOnce();
    });
    expect(processControl.control.forceExit).not.toHaveBeenCalled();
  });

  it('forces a second signal with the conventional signal exit code', async () => {
    const start = vi.fn(() => Promise.resolve());
    const close = vi.fn(() => new Promise<void>(() => undefined));
    const processControl = createProcessControl();

    await runMcpServerProcess({
      lifecycle: { start, close },
      processControl: processControl.control,
    });
    processControl.emitSignal('SIGINT');
    processControl.emitSignal('SIGINT');

    expect(processControl.control.forceExit).toHaveBeenCalledWith(130);
  });

  it('reports startup failure and still attempts cleanup', async () => {
    const start = vi.fn(() => Promise.reject(new Error('startup failed')));
    const close = vi.fn(() => Promise.resolve());
    const processControl = createProcessControl();

    await runMcpServerProcess({
      lifecycle: { start, close },
      processControl: processControl.control,
    });

    expect(processControl.control.writeStderr).toHaveBeenCalledWith(
      'MCP server failed to start: startup failed\n',
    );
    expect(processControl.control.setExitCode).toHaveBeenCalledWith(1);
    expect(close).toHaveBeenCalledOnce();
  });

  it('forces exit when graceful shutdown exceeds its deadline', async () => {
    const start = vi.fn(() => Promise.resolve());
    const close = vi.fn(() => new Promise<void>(() => undefined));
    const processControl = createProcessControl();

    await runMcpServerProcess({
      lifecycle: { start, close },
      processControl: processControl.control,
      shutdownGraceMs: 10,
    });
    processControl.emitSignal('SIGTERM');
    processControl.fireTimeout();

    expect(processControl.control.writeStderr).toHaveBeenCalledWith(
      'MCP server failed to timeout\n',
    );
    expect(processControl.control.forceExit).toHaveBeenCalledWith(1);
  });
});
