import { describe, expect, it, vi } from 'vitest';

import {
  createStderrErrorReporter,
  describeError,
  reportInternalError,
} from '../../src/diagnostics.js';

describe('internal diagnostics', () => {
  it('keeps error and operation diagnostics on one line', () => {
    const writeStderr = vi.fn<(message: string) => void>();
    const reporter = createStderrErrorReporter(writeStderr);

    reporter({
      phase: 'tool',
      operation: 'test\noperation',
      error: new Error('secret\r\ndetail'),
    });

    expect(writeStderr).toHaveBeenCalledWith(
      'MCP server internal tool test operation error: secret detail\n',
    );
  });

  it('describes non-errors safely and swallows reporter failures', () => {
    expect(describeError('not an Error')).toBe('unknown error');
    expect(() => {
      reportInternalError(
        () => {
          throw new Error('reporter failed');
        },
        { phase: 'request', error: new Error('request failed') },
      );
    }).not.toThrow();
  });
});
