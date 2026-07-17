import type { AddressInfo } from 'node:net';

import { serve, type ServerType } from '@hono/node-server';
import type { Hono } from 'hono';

import type { HttpServerConfig } from './config.js';

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
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export function createHttpServerRuntime(
  app: Hono,
  config: HttpServerConfig,
  serveFunction: ServeFunction = serve,
): HttpServerRuntime {
  let state: HttpRuntimeState = 'idle';
  let server: ServerType | undefined;
  let address: AddressInfo | undefined;
  let startPromise: Promise<AddressInfo> | undefined;
  let closePromise: Promise<void> | undefined;

  const closeListeningServer = async (): Promise<void> => {
    if (server === undefined) {
      state = 'closed';
      return;
    }

    const closeOperation = closeServer(server);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      closeOperation,
      new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
          if (server !== undefined && 'closeAllConnections' in server) {
            server.closeAllConnections();
          }
          resolve();
        }, config.shutdownGraceMs);
      }),
    ]);
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    state = 'closed';
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
        if (settled) return;
        settled = true;
        state = 'closed';
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      try {
        server = serveFunction(
          { fetch: app.fetch, hostname: config.host, port: config.port },
          (listeningAddress) => {
            if (settled) return;
            settled = true;
            address = listeningAddress;
            if (state === 'closing') {
              void closeListeningServer().catch(reject);
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
    if (state === 'closed') return closePromise ?? Promise.resolve();
    if (closePromise !== undefined) return closePromise;

    state = 'closing';
    closePromise = (startPromise?.catch(() => undefined) ?? Promise.resolve())
      .then(() => closeListeningServer())
      .finally(() => {
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
