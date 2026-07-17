import type { AddressInfo } from 'node:net';

import { describe, expect, it, vi } from 'vitest';

import { createHttpServerConfig } from '../../src/http/config.js';
import { createHttpServerRuntime, type ServeFunction } from '../../src/http/runtime.js';

function createFakeServer() {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  return {
    once(event: string, listener: (...args: unknown[]) => void) {
      listeners.set(event, listener);
      return this;
    },
    close(callback: (error?: Error) => void) {
      callback();
    },
    closeAllConnections: vi.fn(),
    emitError(error: Error) {
      listeners.get('error')?.(error);
    },
  } as never;
}

describe('HTTP server lifecycle', () => {
  it('starts once, returns the bound address, and closes idempotently', async () => {
    const server = createFakeServer();
    const address: AddressInfo = { address: '127.0.0.1', family: 'IPv4', port: 43210 };
    const serveFunction: ServeFunction = (_options, callback) => {
      callback?.(address);
      return server;
    };
    const runtime = createHttpServerRuntime(
      { fetch: vi.fn() } as never,
      createHttpServerConfig(),
      serveFunction,
    );

    await expect(runtime.start()).resolves.toEqual(address);
    await expect(runtime.start()).resolves.toEqual(address);
    expect(runtime.state).toBe('running');
    await expect(runtime.close()).resolves.toBeUndefined();
    await expect(runtime.close()).resolves.toBeUndefined();
    expect(runtime.state).toBe('closed');
  });

  it('rejects a start after close without opening a listener', async () => {
    const serveFunction = vi.fn<ServeFunction>();
    const runtime = createHttpServerRuntime(
      { fetch: vi.fn() } as never,
      createHttpServerConfig(),
      serveFunction,
    );

    await runtime.close();

    await expect(runtime.start()).rejects.toThrow('closed state');
    expect(serveFunction).not.toHaveBeenCalled();
  });
});
