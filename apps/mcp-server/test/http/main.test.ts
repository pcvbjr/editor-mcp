import { expect, it, vi } from 'vitest';

import { createHttpServerConfig } from '../../src/http/config.js';
import { main } from '../../src/http/main.js';
import type { ProcessControl, SupportedTerminationSignal } from '../../src/process.js';
import { testOAuthMetadata, testTokenVerifier } from '../support/http-test-harness.js';

it('composes an importable authenticated HTTP app and closes through the process boundary', async () => {
  const signals = new Map<SupportedTerminationSignal, () => void>();
  const processControl: ProcessControl = {
    onSignal(signal, listener) {
      signals.set(signal, listener);
      return () => {
        signals.delete(signal);
      };
    },
    onStdinEnd: () => () => undefined,
    scheduleTimeout: () => () => undefined,
    writeStderr: vi.fn(),
    setExitCode: vi.fn(),
    forceExit: vi.fn(),
  };

  await main({
    config: createHttpServerConfig({ port: 0 }),
    processControl,
    oauthMetadata: testOAuthMetadata,
    tokenVerifier: testTokenVerifier,
  });
  expect(processControl.writeStderr).toHaveBeenCalledWith(
    expect.stringMatching(/^MCP HTTP server listening at http:\/\/127\.0\.0\.1:\d+\/mcp\n$/u),
  );

  signals.get('SIGTERM')?.();
  await vi.waitFor(() => {
    expect(signals.size).toBe(0);
  });
  expect(processControl.setExitCode).not.toHaveBeenCalled();
});
