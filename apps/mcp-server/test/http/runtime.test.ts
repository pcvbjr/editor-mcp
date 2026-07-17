import type { RequestListener } from 'node:http';
import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';

import { createHttpServerConfig } from '../../src/http/config.js';
import { createReadinessController } from '../../src/http/readiness.js';
import { createActiveRequestRegistry } from '../../src/http/request-registry.js';
import { createHttpServerRuntime } from '../../src/http/runtime.js';

const immediateResponse: RequestListener = (_request, response) => {
  response.end('ok');
};

describe('HTTP server lifecycle', () => {
  it('starts once, configures readiness, and closes idempotently', async () => {
    const readiness = createReadinessController();
    const active = createActiveRequestRegistry();
    const runtime = createHttpServerRuntime(
      immediateResponse,
      createHttpServerConfig({ port: 0 }),
      readiness,
      active,
    );

    const firstAddress = await runtime.start();
    await expect(runtime.start()).resolves.toEqual(firstAddress);
    expect(runtime.state).toBe('running');
    expect(readiness.isReady).toBe(true);
    await expect(runtime.close()).resolves.toBeUndefined();
    await expect(runtime.close()).resolves.toBeUndefined();
    expect(runtime.state).toBe('closed');
    expect(readiness.isReady).toBe(false);
  });

  it('rejects a start after close without opening a listener', async () => {
    const readiness = createReadinessController();
    const runtime = createHttpServerRuntime(
      immediateResponse,
      createHttpServerConfig({ port: 0 }),
      readiness,
      createActiveRequestRegistry(),
    );

    await runtime.close();
    await expect(runtime.start()).rejects.toThrow('closed state');
    expect(readiness.isReady).toBe(false);
  });

  it('rejects a listener bind failure without reporting ready', async () => {
    const occupied = createServer(immediateResponse);
    await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
    const occupiedAddress = occupied.address();
    if (occupiedAddress === null || typeof occupiedAddress === 'string') {
      throw new Error('occupied listener failed');
    }
    const readiness = createReadinessController();
    const runtime = createHttpServerRuntime(
      immediateResponse,
      createHttpServerConfig({ port: occupiedAddress.port }),
      readiness,
      createActiveRequestRegistry(),
    );

    try {
      await expect(runtime.start()).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(readiness.isReady).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) => {
        occupied.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  });

  it('aborts registered work after the graceful shutdown deadline', async () => {
    const readiness = createReadinessController();
    const active = createActiveRequestRegistry();
    const activeRegistration: { remove?: () => void } = {};
    const closeActive = vi.fn(() => {
      activeRegistration.remove?.();
      return Promise.resolve();
    });
    activeRegistration.remove = active.add({ close: closeActive });
    let markRequestStarted: (() => void) | undefined;
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });
    const runtime = createHttpServerRuntime(
      () => {
        markRequestStarted?.();
      },
      createHttpServerConfig({ port: 0, shutdownGraceMs: 10 }),
      readiness,
      active,
    );
    const address = await runtime.start();
    const pendingRequest = fetch(`http://127.0.0.1:${String(address.port)}/never`).catch(
      () => undefined,
    );
    await requestStarted;

    await expect(runtime.close()).resolves.toBeUndefined();
    expect(closeActive).toHaveBeenCalledOnce();
    expect(readiness.isReady).toBe(false);
    await pendingRequest;
  });
});
