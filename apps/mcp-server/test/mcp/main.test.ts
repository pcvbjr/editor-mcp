import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { describe, expect, it, vi } from 'vitest';

import { main } from '../../src/main.js';
import type { ProcessControl } from '../../src/process.js';

function createProcessControl() {
  let stdinEndListener: (() => void) | undefined;
  const control: ProcessControl = {
    onSignal: () => () => undefined,
    onStdinEnd(listener) {
      stdinEndListener = listener;
      return () => {
        stdinEndListener = undefined;
      };
    },
    scheduleTimeout: () => () => undefined,
    writeStdout: vi.fn(),
    writeStderr: vi.fn(),
    setExitCode: vi.fn(),
    forceExit: vi.fn(),
  };

  return {
    control,
    emitStdinEnd: () => {
      stdinEndListener?.();
    },
  };
}

describe('MCP main composition', () => {
  it('is importable without starting a process and closes on stdin end', async () => {
    const start = vi.fn(() => Promise.resolve());
    const close = vi.fn(() => Promise.resolve());
    const transport: Transport = {
      start,
      send: vi.fn(() => Promise.resolve()),
      close,
    };
    const processControl = createProcessControl();
    const register = vi.fn();

    await main({ transport, processControl: processControl.control, register });
    processControl.emitStdinEnd();

    await vi.waitFor(() => {
      expect(close).toHaveBeenCalledOnce();
    });
    expect(start).toHaveBeenCalledOnce();
    expect(register).toHaveBeenCalledOnce();
    expect(processControl.control.writeStderr).not.toHaveBeenCalled();
  });
});
