import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

export type McpServerLifecycleState = 'idle' | 'starting' | 'running' | 'closing' | 'closed';

type ServerConnection = Pick<McpServer, 'connect' | 'close'>;

export interface McpServerLifecycle {
  readonly state: McpServerLifecycleState;
  readonly start: () => Promise<void>;
  readonly close: () => Promise<void>;
}

export function createMcpServerLifecycle(
  server: ServerConnection,
  transport: Transport,
): McpServerLifecycle {
  let state: McpServerLifecycleState = 'idle';
  let connectPromise: Promise<void> | undefined;
  let startPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;

  const ensureClose = (): Promise<void> => {
    closePromise ??= (connectPromise?.catch(() => undefined) ?? Promise.resolve())
      .then(() => server.close())
      .finally(() => {
        state = 'closed';
      });
    return closePromise;
  };

  const start = (): Promise<void> => {
    if (state === 'closed' || state === 'closing') {
      return Promise.reject(new Error(`Cannot start an MCP server in the ${state} state`));
    }
    if (state === 'running') {
      return Promise.resolve();
    }
    if (state === 'starting') {
      return startPromise ?? Promise.reject(new Error('MCP server start is unavailable'));
    }

    state = 'starting';
    connectPromise = Promise.resolve().then(() => server.connect(transport));
    startPromise = connectPromise.then(
      () => {
        if (state === 'starting') {
          state = 'running';
          return;
        }
        return ensureClose();
      },
      (error: unknown) => {
        state = 'closing';
        throw error;
      },
    );
    return startPromise;
  };

  const close = (): Promise<void> => {
    if (state === 'closed') {
      return closePromise ?? Promise.resolve();
    }
    state = 'closing';
    return ensureClose();
  };

  return {
    get state() {
      return state;
    },
    start,
    close,
  };
}
