export interface ActiveMcpRequest {
  readonly close: () => Promise<void>;
}

export interface ActiveRequestRegistry {
  readonly size: number;
  readonly add: (request: ActiveMcpRequest) => () => void;
  readonly whenEmpty: () => Promise<void>;
  readonly closeAll: () => Promise<void>;
}

export function createActiveRequestRegistry(): ActiveRequestRegistry {
  const active = new Set<ActiveMcpRequest>();
  const emptyWaiters = new Set<() => void>();
  const resolveEmptyWaiters = (): void => {
    if (active.size !== 0) return;
    emptyWaiters.forEach((resolve) => {
      resolve();
    });
    emptyWaiters.clear();
  };
  return {
    get size() {
      return active.size;
    },
    add(request) {
      active.add(request);
      return () => {
        active.delete(request);
        resolveEmptyWaiters();
      };
    },
    whenEmpty() {
      if (active.size === 0) return Promise.resolve();
      return new Promise((resolve) => emptyWaiters.add(resolve));
    },
    async closeAll() {
      await Promise.allSettled([...active].map((request) => request.close()));
    },
  };
}
