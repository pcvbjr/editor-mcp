import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { describe, expect, it, vi } from 'vitest';

import { createMcpServerLifecycle, type McpServerLifecycleState } from '../../src/lifecycle.js';

const unusedTransport: Transport = {
  start: () => Promise.resolve(),
  send: () => Promise.resolve(),
  close: () => Promise.resolve(),
};

describe('MCP server lifecycle state machine', () => {
  it('closes before start and rejects a later start', async () => {
    const connect = vi.fn(() => Promise.resolve());
    const close = vi.fn(() => Promise.resolve());
    const lifecycle = createMcpServerLifecycle({ connect, close }, unusedTransport);

    await lifecycle.close();

    expect(lifecycle.state).toBe('closed');
    await expect(lifecycle.start()).rejects.toThrow(/closed state/);
    expect(connect).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it('waits for an in-flight start before closing', async () => {
    let resolveConnect: (() => void) | undefined;
    const connectPromise = new Promise<void>((resolve) => {
      resolveConnect = resolve;
    });
    const events: string[] = [];
    const connect = vi.fn(() => {
      events.push('connect');
      return connectPromise;
    });
    const close = vi.fn(() => {
      events.push('close');
      return Promise.resolve();
    });
    const lifecycle = createMcpServerLifecycle({ connect, close }, unusedTransport);

    const startPromise = lifecycle.start();
    const closePromise = lifecycle.close();
    expect(lifecycle.state).toBe('closing');
    resolveConnect?.();

    await expect(Promise.all([startPromise, closePromise])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(events).toEqual(['connect', 'close']);
    expect(lifecycle.state).toBe('closed');
  });

  it('shares the in-flight start promise', async () => {
    let resolveConnect: (() => void) | undefined;
    const connectPromise = new Promise<void>((resolve) => {
      resolveConnect = resolve;
    });
    const connect = vi.fn(() => connectPromise);
    const close = vi.fn(() => Promise.resolve());
    const lifecycle = createMcpServerLifecycle({ connect, close }, unusedTransport);

    const firstStart = lifecycle.start();
    const secondStart = lifecycle.start();
    resolveConnect?.();

    await expect(Promise.all([firstStart, secondStart])).resolves.toEqual([undefined, undefined]);
    expect(connect).toHaveBeenCalledOnce();
  });

  it('transitions through running and closes exactly once', async () => {
    const connect = vi.fn(() => Promise.resolve());
    const close = vi.fn(() => Promise.resolve());
    const lifecycle = createMcpServerLifecycle({ connect, close }, unusedTransport);

    const states: McpServerLifecycleState[] = [lifecycle.state];
    await lifecycle.start();
    states.push(lifecycle.state);
    await lifecycle.start();
    await Promise.all([lifecycle.close(), lifecycle.close()]);
    states.push(lifecycle.state);

    expect(states).toEqual(['idle', 'running', 'closed']);
    expect(connect).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('closes after a failed start and does not reconnect', async () => {
    const connect = vi.fn(() => Promise.reject(new Error('connect failed')));
    const close = vi.fn(() => Promise.resolve());
    const lifecycle = createMcpServerLifecycle({ connect, close }, unusedTransport);

    await expect(lifecycle.start()).rejects.toThrow('connect failed');
    expect(lifecycle.state).toBe('closing');
    await lifecycle.close();
    await lifecycle.close();
    await expect(lifecycle.start()).rejects.toThrow(/closed state/);
    expect(connect).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
});
