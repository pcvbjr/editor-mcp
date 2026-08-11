export interface CollaborationProviderLifecycle {
  destroyTimer: ReturnType<typeof setTimeout> | undefined;
}

interface CollaborationProvider {
  connect(): Promise<unknown>;
  destroy(): void;
  disconnect(): void;
}

export function connectCollaborationProvider(
  provider: CollaborationProvider,
  lifecycle: CollaborationProviderLifecycle,
): void {
  if (lifecycle.destroyTimer !== undefined) {
    clearTimeout(lifecycle.destroyTimer);
    lifecycle.destroyTimer = undefined;
  }
  void provider.connect();
}

export function deferCollaborationProviderDestroy(
  provider: CollaborationProvider,
  lifecycle: CollaborationProviderLifecycle,
): void {
  provider.disconnect();
  lifecycle.destroyTimer = setTimeout(() => {
    provider.destroy();
    lifecycle.destroyTimer = undefined;
  }, 0);
}
