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

  const start = (): Promise<AddressInfo> => {
    if (state === 'closed' || state === 'closing') {
      return Promise.reject(new Error(`Cannot start HTTP server in the ${state} state`));
    }
    if (state === 'running' && address !== undefined) return Promise.resolve(address);
    if (state === 'starting' && startPromise !== undefined) return startPromise;

    state = 'starting';
    startPromise = new Promise<AddressInfo>((resolve, reject) => {
      let settled = false;
      const handleError = (error: Error): void => {
        if (!settled) {
          settled = true;
          state = 'closed';
          reject(error);
          return;
        }
        reportInternalError(reportError, { phase: 'listener', error });
      };

      try {
        server = serveFunction(app);
        server.headersTimeout = 10_000;
        server.requestTimeout = 30_000;
        server.keepAliveTimeout = 5_000;
        server.once('error', handleError);
        server.listen(config.port, config.host, () => {
          if (settled || server === undefined) return;
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
    if (state === 'closed') return closePromise ?? Promise.resolve();
    if (closePromise !== undefined) return closePromise;

    state = 'closing';
    readiness.markNotReady();
    closePromise = (startPromise?.catch(() => undefined) ?? Promise.resolve())
      .then(async () => {
        if (server === undefined) return;
        const totalDeadline = Date.now() + config.shutdownGraceMs;
        const forcedReserveMs = Math.min(
          5_000,
          Math.max(1, Math.floor(config.shutdownGraceMs / 6)),
        );
        const gracefulBudgetMs = Math.max(1, config.shutdownGraceMs - forcedReserveMs);
        const closeOperation = closeServer(server);
        const gracefulOperation = Promise.all([closeOperation, activeRequests.whenEmpty()]);
        server.closeIdleConnections();
        const gracefulDeadline = createDeadline(gracefulBudgetMs);
        const result = await Promise.race([
          gracefulOperation.then(() => 'closed' as const),
          gracefulDeadline.promise.then(() => 'expired' as const),
        ]);
        gracefulDeadline.cancel();
        if (result === 'closed') return;

        await activeRequests.closeAll();
        server.closeAllConnections();
        const forcedDeadline = createDeadline(Math.max(1, totalDeadline - Date.now()));
        const forced = await Promise.race([
          gracefulOperation.then(() => 'closed' as const),
          forcedDeadline.promise.then(() => 'expired' as const),
        ]);
        forcedDeadline.cancel();
        if (forced === 'expired') {
          throw new Error('HTTP server did not close after forced connection termination');
        }
      })
      .finally(() => {
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
