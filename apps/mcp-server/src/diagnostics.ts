export type InternalErrorEvent =
  | { readonly phase: 'tool'; readonly operation: string; readonly error: unknown }
  | { readonly phase: 'auth' | 'request' | 'close' | 'listener'; readonly error: unknown };

export type InternalErrorReporter = (event: InternalErrorEvent) => void;

export function describeError(error: unknown): string {
  if (!(error instanceof Error) || error.message.length === 0) return 'unknown error';
  return error.message.replace(/[\r\n]+/gu, ' ');
}

export function reportInternalError(
  reporter: InternalErrorReporter | undefined,
  event: InternalErrorEvent,
): void {
  try {
    reporter?.(event);
  } catch {
    // Diagnostics must never change protocol or shutdown behavior.
  }
}

export function createStderrErrorReporter(
  writeStderr: (message: string) => void,
): InternalErrorReporter {
  return (event) => {
    const operation = event.phase === 'tool' ? ` ${event.operation.replace(/[\r\n]+/gu, ' ')}` : '';
    writeStderr(
      `MCP server internal ${event.phase}${operation} error: ${describeError(event.error)}\n`,
    );
  };
}
