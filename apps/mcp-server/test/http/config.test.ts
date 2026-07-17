import { describe, expect, it } from 'vitest';

import { createHttpServerConfig, parseHttpServerConfig } from '../../src/http/config.js';

describe('HTTP configuration', () => {
  it('applies safe local defaults', () => {
    expect(parseHttpServerConfig({})).toEqual({
      host: '127.0.0.1',
      port: 3000,
      allowedHosts: ['127.0.0.1', 'localhost', '[::1]'],
      allowedOrigins: [],
      shutdownGraceMs: 5_000,
    });
  });

  it('normalizes explicit lists and numeric values', () => {
    expect(
      parseHttpServerConfig({
        EDITOR_MCP_HTTP_HOST: ' 127.0.0.1 ',
        EDITOR_MCP_HTTP_PORT: '0',
        EDITOR_MCP_HTTP_ALLOWED_HOSTS: 'localhost, 127.0.0.1,localhost',
        EDITOR_MCP_HTTP_ALLOWED_ORIGINS: 'https://agent.example, http://localhost:5173',
        EDITOR_MCP_HTTP_SHUTDOWN_GRACE_MS: '250',
      }),
    ).toEqual({
      host: '127.0.0.1',
      port: 0,
      allowedHosts: ['localhost', '127.0.0.1', 'localhost'],
      allowedOrigins: ['https://agent.example', 'http://localhost:5173'],
      shutdownGraceMs: 250,
    });
  });

  it.each([
    ['EDITOR_MCP_HTTP_PORT', '65536'],
    ['EDITOR_MCP_HTTP_PORT', '-1'],
    ['EDITOR_MCP_HTTP_ALLOWED_ORIGINS', '*'],
    ['EDITOR_MCP_HTTP_ALLOWED_ORIGINS', 'not a URL'],
    ['EDITOR_MCP_HTTP_ALLOWED_ORIGINS', 'https://agent.example,,https://other.example'],
    ['EDITOR_MCP_HTTP_ALLOWED_HOSTS', '127.0.0.1,,localhost'],
    ['EDITOR_MCP_HTTP_HOST', '0.0.0.0'],
    ['EDITOR_MCP_HTTP_SHUTDOWN_GRACE_MS', '0'],
  ] as const)('rejects invalid %s', (key, value) => {
    expect(() => parseHttpServerConfig({ [key]: value })).toThrow();
  });

  it('creates a validated test configuration without reading process.env', () => {
    expect(createHttpServerConfig({ port: 0 }).port).toBe(0);
  });
});
