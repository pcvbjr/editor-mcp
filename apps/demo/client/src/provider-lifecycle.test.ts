import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  connectCollaborationProvider,
  deferCollaborationProviderDestroy,
  type CollaborationProviderLifecycle,
} from './provider-lifecycle';

describe('collaboration provider lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('cancels deferred destruction when React Strict Mode reconnects immediately', async () => {
    vi.useFakeTimers();
    const provider = {
      connect: vi.fn(() => Promise.resolve()),
      disconnect: vi.fn(),
      destroy: vi.fn(),
    };
    const lifecycle: CollaborationProviderLifecycle = { destroyTimer: undefined };

    connectCollaborationProvider(provider, lifecycle);
    deferCollaborationProviderDestroy(provider, lifecycle);
    connectCollaborationProvider(provider, lifecycle);
    await vi.runAllTimersAsync();

    expect(provider.connect).toHaveBeenCalledTimes(2);
    expect(provider.disconnect).toHaveBeenCalledOnce();
    expect(provider.destroy).not.toHaveBeenCalled();

    deferCollaborationProviderDestroy(provider, lifecycle);
    await vi.runAllTimersAsync();

    expect(provider.destroy).toHaveBeenCalledOnce();
  });
});
