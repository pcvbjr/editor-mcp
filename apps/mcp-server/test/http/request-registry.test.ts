import { describe, expect, it, vi } from 'vitest';

import { createActiveRequestRegistry } from '../../src/http/request-registry.js';

describe('active request registry', () => {
  it('tracks removals and settles every close operation', async () => {
    const registry = createActiveRequestRegistry();
    const close = vi.fn(() => Promise.resolve());
    const rejectClose = vi.fn(() => Promise.reject(new Error('closed elsewhere')));
    const remove = registry.add({ close });
    registry.add({ close: rejectClose });

    expect(registry.size).toBe(2);
    remove();
    expect(registry.size).toBe(1);

    await expect(registry.closeAll()).resolves.toBeUndefined();
    expect(close).not.toHaveBeenCalled();
    expect(rejectClose).toHaveBeenCalledOnce();
  });

  it('settles emptiness only after tracked execution bookkeeping is removed', async () => {
    const registry = createActiveRequestRegistry();
    const remove = registry.add({ close: () => Promise.resolve() });
    let empty = false;
    const settled = registry.whenEmpty().then(() => {
      empty = true;
    });

    await Promise.resolve();
    expect(empty).toBe(false);
    remove();
    await settled;
    expect(empty).toBe(true);
    await expect(registry.whenEmpty()).resolves.toBeUndefined();
  });
});
