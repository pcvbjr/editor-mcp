export interface ConcurrencyLease {
  readonly release: () => void;
}

export interface ConcurrencyGate {
  readonly active: number;
  readonly tryAcquire: () => ConcurrencyLease | undefined;
}

export function createConcurrencyGate(limit: number): ConcurrencyGate {
  let active = 0;

  return {
    get active() {
      return active;
    },
    tryAcquire() {
      if (active >= limit) return undefined;
      active += 1;
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          active -= 1;
        },
      };
    },
  };
}
