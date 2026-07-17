import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHttpServerConfig } from '../../src/http/config.js';
import { createHttpServerRuntime, type ServeFunction } from '../../src/http/runtime.js';
import type { InternalErrorReporter } from '../../src/diagnostics.js';

const address: AddressInfo = { address: '127.0.0.1', family: 'IPv4', port: 43_210 };

interface FakeServerOptions {
  readonly closeError?: Error;
  readonly closeOnForce?: boolean;
  readonly closeImmediately?: boolean;
}

function createFakeServer({
  closeError,
  closeOnForce = false,
  closeImmediately = true,
}: FakeServerOptions = {}) {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  let closeCallback: ((error?: Error) => void) | undefined;
  const server = {
    once(event: string, listener: (...args: unknown[]) => void) {
      listeners.set(event, listener);
      return this;
    },
    close: vi.fn((callback: (error?: Error) => void) => {
      closeCallback = callback;
      if (closeImmediately) callback(closeError);
    }),
    closeAllConnections: vi.fn(() => {
      if (closeOnForce) closeCallback?.();
    }),
    completeClose(error?: Error) {
      closeCallback?.(error);
    },
    emitError(error: Error) {
      listeners.get('error')?.(error);
    },
  };
  return server;
}

function createRuntime(
  serveFunction: ServeFunction,
  shutdownGraceMs = 100,
  reportError?: InternalErrorReporter,
) {
  return createHttpServerRuntime(
    { fetch: vi.fn() } as never,
    createHttpServerConfig({ shutdownGraceMs }),
    serveFunction,
    reportError,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('HTTP server lifecycle', () => {
  it('starts once, returns the bound address, and closes idempotently', async () => {
    const server = createFakeServer();
    const serveFunction: ServeFunction = (_options, callback) => {
      callback?.(address);
      return server as never;
    };
    const runtime = createRuntime(serveFunction);

    await expect(runtime.start()).resolves.toEqual(address);
    await expect(runtime.start()).resolves.toEqual(address);
    expect(runtime.state).toBe('running');
    await expect(runtime.close()).resolves.toBeUndefined();
    await expect(runtime.close()).resolves.toBeUndefined();
    expect(server.close).toHaveBeenCalledOnce();
    expect(runtime.state).toBe('closed');
  });

  it('closes exactly once when shutdown begins during startup', async () => {
    const server = createFakeServer();
    let listening: ((info: AddressInfo) => void) | undefined;
    const runtime = createRuntime((_options, callback) => {
      listening = callback;
      return server as never;
    });

    const start = runtime.start();
    const close = runtime.close();
    listening?.(address);

    await expect(start).resolves.toEqual(address);
    await expect(close).resolves.toBeUndefined();
    expect(server.close).toHaveBeenCalledOnce();
    expect(runtime.state).toBe('closed');
  });

  it('rejects a start after close without opening a listener', async () => {
    const serveFunction = vi.fn<ServeFunction>();
    const runtime = createRuntime(serveFunction);

    await runtime.close();

    await expect(runtime.start()).rejects.toThrow('closed state');
    expect(serveFunction).not.toHaveBeenCalled();
  });

  it('rejects listen failures and reports later listener failures', async () => {
    const server = createFakeServer();
    const reportError = vi.fn<InternalErrorReporter>();
    let listening: ((info: AddressInfo) => void) | undefined;
    const runtime = createRuntime(
      (_options, callback) => {
        listening = callback;
        return server as never;
      },
      100,
      reportError,
    );

    const start = runtime.start();
    server.emitError(new Error('listen failed'));
    await expect(start).rejects.toThrow('listen failed');

    const secondServer = createFakeServer();
    const secondRuntime = createRuntime(
      (_options, callback) => {
        callback?.(address);
        return secondServer as never;
      },
      100,
      reportError,
    );
    await secondRuntime.start();
    secondServer.emitError(new Error('late listener failure'));
    const event = reportError.mock.calls[0]?.[0];
    expect(event?.phase).toBe('listener');
    expect(event?.error).toEqual(new Error('late listener failure'));
    await secondRuntime.close();
    expect(listening).toBeDefined();
  });

  it('propagates listener close failures', async () => {
    const server = createFakeServer({ closeError: new Error('close failed') });
    const runtime = createRuntime((_options, callback) => {
      callback?.(address);
      return server as never;
    });
    await runtime.start();

    await expect(runtime.close()).rejects.toThrow('close failed');
    expect(runtime.state).toBe('closed');
  });

  it('waits for active work before completing graceful shutdown', async () => {
    const server = createFakeServer({ closeImmediately: false });
    const runtime = createRuntime((_options, callback) => {
      callback?.(address);
      return server as never;
    });
    await runtime.start();

    const close = runtime.close();
    let settled = false;
    void close.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.waitFor(() => {
      expect(server.close).toHaveBeenCalledOnce();
    });
    expect(settled).toBe(false);
    server.completeClose();
    await expect(close).resolves.toBeUndefined();
  });

  it('forces connections after the grace period and reports a non-graceful close', async () => {
    vi.useFakeTimers();
    const server = createFakeServer({ closeImmediately: false, closeOnForce: true });
    const runtime = createRuntime((_options, callback) => {
      callback?.(address);
      return server as never;
    }, 10);
    await runtime.start();

    const outcome = runtime.close().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10);

    await expect(outcome).resolves.toEqual(
      new Error('HTTP server required forced connection termination'),
    );
    expect(server.close).toHaveBeenCalledOnce();
    expect(server.closeAllConnections).toHaveBeenCalledOnce();
  });

  it('fails within a second bound when forced connections still do not close', async () => {
    vi.useFakeTimers();
    const server = createFakeServer({ closeImmediately: false });
    const runtime = createRuntime((_options, callback) => {
      callback?.(address);
      return server as never;
    }, 10);
    await runtime.start();

    const outcome = runtime.close().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(10);

    await expect(outcome).resolves.toEqual(
      new Error('HTTP server did not close after forced connection termination'),
    );
    expect(server.closeAllConnections).toHaveBeenCalledOnce();
  });
});
