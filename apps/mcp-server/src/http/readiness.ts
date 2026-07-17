export interface ReadinessController {
  readonly isReady: boolean;
  readonly markReady: () => void;
  readonly markNotReady: () => void;
}

export function createReadinessController(): ReadinessController {
  let ready = false;
  return {
    get isReady() {
      return ready;
    },
    markReady() {
      ready = true;
    },
    markNotReady() {
      ready = false;
    },
  };
}
