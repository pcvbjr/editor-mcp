import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { HttpServerConfig } from './config.js';
import type { ReadinessController } from './readiness.js';
import type { ActiveRequestRegistry } from './request-registry.js';
import { reportInternalError, type InternalErrorReporter } from '../diagnostics.js';

export type HttpRuntimeState = 'idle' | 'starting' | 'running' | 'closing' | 'closed';

export interface HttpServerRuntime {
  readonly state: HttpRuntimeState;
  readonly start: () => Promise<AddressInfo>;
  readonly close: () => Promise<void>;
}

export type ServeFunction = (listener: RequestListener) => Server;

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error?: Error) => {
      if (error && (!('code' in error) || error.code !== 'ERR_SERVER_NOT_RUNNING')) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function createDeadline(milliseconds: number): {
  readonly promise: Promise<void>;
  readonly cancel: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    promise: new Promise((resolve) => {
      timer = setTimeout(resolve, milliseconds);
    }),
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

async function settleBeforeDeadline(
  operation: Promise<unknown>,
  milliseconds: number,
): Promise<'settled' | 'expired'> {
  const deadline = createDeadline(milliseconds);
  try {
    return await Promise.race([
      operation.then(() => 'settled' as const),
      deadline.promise.then(() => 'expired' as const),
    ]);
  } finally {
    deadline.cancel();
  }
}

export function createHttpServerRuntime(
  app: RequestListener,
  config: HttpServerConfig,
  readiness: ReadinessController,
  activeRequests: ActiveRequestRegistry,
  serveFunction: ServeFunction = createServer,
  reportError?: InternalErrorReporter,
): HttpServerRuntime {
  let state: HttpRuntimeState = 'idle';
  let server: Server | undefined;
  let address: AddressInfo | undefined;
  let startPromise: Promise<AddressInfo> | undefined;
  let closePromise: Promise<void> | undefined;
  let listenerClosePromise: Promise<void> | undefined;
  let cancelStart: ((error: Error) => void) | undefined;

  const closeListeningServer = async (): Promise<void> => {
    if (server === undefined) return;

    const totalDeadline = Date.now() + config.shutdownGraceMs;
    const forcedReserveMs = Math.min(5_000, Math.max(1, Math.floor(config.shutdownGraceMs / 6)));
    const gracefulBudgetMs = Math.max(1, config.shutdownGraceMs - forcedReserveMs);
    const closeOperation = closeServer(server);
    const gracefulOperation = Promise.all([closeOperation, activeRequests.whenEmpty()]);
    server.closeIdleConnections();

    const gracefulResult = await settleBeforeDeadline(gracefulOperation, gracefulBudgetMs);
    if (gracefulResult === 'settled') return;

    await activeRequests.closeAll();
    server.closeAllConnections();
    const forcedResult = await settleBeforeDeadline(
      gracefulOperation,
      Math.max(1, totalDeadline - Date.now()),
    );
    if (forcedResult === 'expired') {
      throw new Error('HTTP server did not close after forced connection termination');
    }
  };

  const ensureListenerClosed = (): Promise<void> => {
    listenerClosePromise ??= closeListeningServer();
    return listenerClosePromise;
  };

  const start = (): Promise<AddressInfo> => {
    if (state === 'closed' || state === 'closing') {
      return Promise.reject(new Error(`Cannot start HTTP server in the ${state} state`));
    }
    if (state === 'running' && address !== undefined) return Promise.resolve(address);
    if (state === 'starting' && startPromise !== undefined) return startPromise;

    state = 'starting';
    startPromise = new Promise<AddressInfo>((resolve, reject) => {
      let settled = false;
      const handleError = (error: unknown): void => {
        if (!settled) {
          settled = true;
          state = 'closed';
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        reportInternalError(reportError, { phase: 'listener', error });
      };
      cancelStart = handleError;

      try {
        server = serveFunction(app);
        server.headersTimeout = 10_000;
        server.requestTimeout = 30_000;
        server.keepAliveTimeout = 5_000;
        server.once('error', handleError);
        server.listen(config.port, config.host, () => {
          if (settled) {
            if ((state === 'closing' || state === 'closed') && server !== undefined) {
              const lateServer = server;
              void (listenerClosePromise?.catch(() => undefined) ?? Promise.resolve())
                .then(async () => {
                  if (!('listening' in lateServer) || lateServer.listening) {
                    await closeServer(lateServer);
                  }
                })
                .catch((error: unknown) => {
                  reportInternalError(reportError, { phase: 'listener', error });
                });
            }
            return;
          }
          if (server === undefined) return;
          const boundAddress = server.address();
          if (boundAddress === null || typeof boundAddress === 'string') {
            handleError(new Error('HTTP server did not bind to an IP address'));
            return;
          }
          settled = true;
          address = boundAddress;
          if (state !== 'closing') {
            state = 'running';
            readiness.markReady();
          }
          resolve(boundAddress);
        });
      } catch (error: unknown) {
        handleError(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return startPromise;
  };

  const close = (): Promise<void> => {
    if (state === 'closed' && server === undefined) return closePromise ?? Promise.resolve();
    if (closePromise !== undefined) return closePromise;

    const wasStarting = state === 'starting';
    state = 'closing';
    readiness.markNotReady();
    closePromise = (async () => {
      let startupDeadlineError: Error | undefined;
      if (wasStarting && startPromise !== undefined) {
        const startupResult = await settleBeforeDeadline(
          startPromise.then(
            () => undefined,
            () => undefined,
          ),
          config.shutdownGraceMs,
        );
        if (startupResult === 'expired') {
          startupDeadlineError = new Error(
            'HTTP server startup did not settle before the shutdown deadline',
          );
          cancelStart?.(startupDeadlineError);
        }
      }

      await ensureListenerClosed();
      if (startupDeadlineError !== undefined) throw startupDeadlineError;
    })().finally(() => {
      readiness.markNotReady();
      state = 'closed';
    });
    return closePromise;
  };

  return {
    get state() {
      return state;
    },
    start,
    close,
  };
}
