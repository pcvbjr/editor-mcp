export interface ExecutionTracker {
  readonly active: number;
  readonly run: <Result>(operation: () => Result | Promise<Result>) => Promise<Result>;
  readonly whenIdle: () => Promise<void>;
}

export function createExecutionTracker(): ExecutionTracker {
  let active = 0;
  const idleWaiters = new Set<() => void>();

  const finish = (): void => {
    active -= 1;
    if (active !== 0) return;
    idleWaiters.forEach((resolve) => {
      resolve();
    });
    idleWaiters.clear();
  };

  return {
    get active() {
      return active;
    },
    async run<Result>(operation: () => Result | Promise<Result>): Promise<Result> {
      active += 1;
      try {
        return await operation();
      } finally {
        finish();
      }
    },
    whenIdle() {
      if (active === 0) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.add(resolve));
    },
  };
}
