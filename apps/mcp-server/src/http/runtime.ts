import type { AddressInfo } from 'node:net';

import { serve, type ServerType } from '@hono/node-server';
import type { Hono } from 'hono';

import type { HttpServerConfig } from './config.js';
import { reportInternalError, type InternalErrorReporter } from '../diagnostics.js';

export type HttpRuntimeState = 'idle' | 'starting' | 'running' | 'closing' | 'closed';

export interface HttpServerRuntime {
  readonly state: HttpRuntimeState;
  readonly start: () => Promise<AddressInfo>;
  readonly close: () => Promise<void>;
}

export interface ServeOptions {
  readonly fetch: (request: Request, env: unknown) => Response | Promise<Response>;
  readonly hostname: string;
  readonly port: number;
}

export type ServeFunction = (
  options: ServeOptions,
  listeningListener?: (info: AddressInfo) => void,
) => ServerType;

function closeServer(server: ServerType): Promise<void> {
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
  app: Hono,
  config: HttpServerConfig,
  serveFunction: ServeFunction = serve,
  reportError?: InternalErrorReporter,
): HttpServerRuntime {
  let state: HttpRuntimeState = 'idle';
  let server: ServerType | undefined;
  let address: AddressInfo | undefined;
  let startPromise: Promise<AddressInfo> | undefined;
  let closePromise: Promise<void> | undefined;
  let listenerClosePromise: Promise<void> | undefined;
  let cancelStart: ((error: Error) => void) | undefined;

  const closeListeningServer = async (): Promise<void> => {
    if (server === undefined) {
      return;
    }

    const closeOperation = closeServer(server);
    const gracefulResult = await settleBeforeDeadline(closeOperation, config.shutdownGraceMs);
    if (gracefulResult === 'settled') return;

    if (!('closeAllConnections' in server)) {
      throw new Error('HTTP server exceeded its graceful shutdown deadline');
    }
    server.closeAllConnections();

    const forcedResult = await settleBeforeDeadline(closeOperation, config.shutdownGraceMs);
    if (forcedResult === 'expired') {
      throw new Error('HTTP server did not close after forced connection termination');
    }
    throw new Error('HTTP server required forced connection termination');
  };

  const ensureListenerClosed = (): Promise<void> => {
    listenerClosePromise ??= closeListeningServer();
    return listenerClosePromise;
  };

  const start = (): Promise<AddressInfo> => {
    if (state === 'closed' || state === 'closing') {
      return Promise.reject(new Error(`Cannot start HTTP server in the ${state} state`));
    }
    if (state === 'running') {
      if (address === undefined) {
        return Promise.reject(new Error('HTTP server is running without a bound address'));
      }
      return Promise.resolve(address);
    }
    if (state === 'starting') {
      if (startPromise === undefined) {
        return Promise.reject(new Error('HTTP server start is unavailable'));
      }
      return startPromise;
    }

    state = 'starting';
    startPromise = new Promise<AddressInfo>((resolve, reject) => {
      let settled = false;
      const settleError = (error: unknown): void => {
        if (settled) {
          reportInternalError(reportError, { phase: 'listener', error });
          return;
        }
        settled = true;
        state = 'closed';
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      cancelStart = settleError;

      try {
        server = serveFunction(
          { fetch: app.fetch, hostname: config.host, port: config.port },
          (listeningAddress) => {
            if (settled) {
              // A pre-listen close may report ERR_SERVER_NOT_RUNNING before Node later binds.
              // Chain a second close only if that late listener is actually active.
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
            settled = true;
            address = listeningAddress;
            if (state === 'closing') {
              resolve(listeningAddress);
              return;
            }
            state = 'running';
            resolve(listeningAddress);
          },
        );
        server.once('error', settleError);
      } catch (error) {
        settleError(error);
      }
    });

    return startPromise;
  };

  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    if (state === 'closed' && server === undefined) return Promise.resolve();

    const wasStarting = state === 'starting';
    state = 'closing';
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
