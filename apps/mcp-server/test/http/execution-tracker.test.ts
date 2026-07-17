import { describe, expect, it } from 'vitest';

import { createExecutionTracker } from '../../src/execution-tracker.js';

describe('execution tracker', () => {
  it('does not report idle until a rejected operation has actually settled', async () => {
    const tracker = createExecutionTracker();
    let rejectOperation: ((error: Error) => void) | undefined;
    const operation = tracker.run(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectOperation = reject;
        }),
    );
    let idle = false;
    const idlePromise = tracker.whenIdle().then(() => {
      idle = true;
    });

    await Promise.resolve();
    expect(tracker.active).toBe(1);
    expect(idle).toBe(false);
    rejectOperation?.(new Error('expected'));
    await expect(operation).rejects.toThrow('expected');
    await idlePromise;
    expect(tracker.active).toBe(0);
    expect(idle).toBe(true);
  });
});
