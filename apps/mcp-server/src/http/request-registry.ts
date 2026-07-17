export interface ActiveMcpRequest {
  readonly close: () => Promise<void>;
}

export interface ActiveRequestRegistry {
  readonly size: number;
  readonly add: (request: ActiveMcpRequest) => () => void;
  readonly closeAll: () => Promise<void>;
}

export function createActiveRequestRegistry(): ActiveRequestRegistry {
  const active = new Set<ActiveMcpRequest>();
  return {
    get size() {
      return active.size;
    },
    add(request) {
      active.add(request);
      return () => active.delete(request);
    },
    async closeAll() {
      await Promise.allSettled([...active].map((request) => request.close()));
    },
  };
}
