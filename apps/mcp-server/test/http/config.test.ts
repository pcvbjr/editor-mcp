import { describe, expect, it } from 'vitest';

import { createHttpServerConfig, parseHttpServerConfig } from '../../src/http/config.js';

const requiredEnvironment = {
  EDITOR_MCP_PUBLIC_URL: 'https://mcp.example.com/mcp',
  EDITOR_MCP_AUTH_ISSUER_URL: 'https://example.authkit.app',
  EDITOR_MCP_WORKOS_CLIENT_ID: 'client_production',
  EDITOR_MCP_WORKOS_CLIENT_SECRET: 'secret_production',
  EDITOR_MCP_HTTP_ALLOWED_HOSTS: 'mcp.example.com',
} as const;

describe('HTTP configuration', () => {
  it('requires the production OAuth contract and applies bounded defaults', () => {
    expect(parseHttpServerConfig(requiredEnvironment)).toEqual({
      host: '127.0.0.1',
      port: 3000,
      publicUrl: new URL('https://mcp.example.com/mcp'),
      issuerUrl: new URL('https://example.authkit.app/'),
      workosClientId: 'client_production',
      workosClientSecret: 'secret_production',
      allowedHosts: ['mcp.example.com'],
      allowedOrigins: [],
      bodyLimitBytes: 1_048_576,
      requestTimeoutMs: 25_000,
      authTimeoutMs: 2_000,
      authMaxInFlight: 16,
      maxInFlight: 32,
      shutdownGraceMs: 30_000,
    });
  });

  it('uses Railway PORT and permits the explicit production listener', () => {
    expect(
      parseHttpServerConfig({
        ...requiredEnvironment,
        EDITOR_MCP_HTTP_HOST: '0.0.0.0',
        PORT: '4321',
        EDITOR_MCP_HTTP_ALLOWED_ORIGINS: 'https://agent.example',
        EDITOR_MCP_AUTH_TIMEOUT_MS: '1500',
      }),
    ).toMatchObject({
      host: '0.0.0.0',
      port: 4321,
      allowedOrigins: ['https://agent.example'],
      authTimeoutMs: 1_500,
    });
  });

  it.each([
    [{}, 'missing required values'],
    [
      { ...requiredEnvironment, EDITOR_MCP_PUBLIC_URL: 'http://mcp.example.com/mcp' },
      'non-HTTPS public URL',
    ],
    [
      { ...requiredEnvironment, EDITOR_MCP_PUBLIC_URL: 'https://mcp.example.com/other' },
      'wrong resource path',
    ],
    [
      { ...requiredEnvironment, EDITOR_MCP_PUBLIC_URL: 'https://mcp.example.com/mcp?x=1' },
      'query resource',
    ],
    [
      { ...requiredEnvironment, EDITOR_MCP_AUTH_ISSUER_URL: 'http://auth.example.com' },
      'non-HTTPS issuer',
    ],
    [
      { ...requiredEnvironment, EDITOR_MCP_HTTP_ALLOWED_HOSTS: 'preview.example.com' },
      'missing canonical host',
    ],
    [{ ...requiredEnvironment, EDITOR_MCP_HTTP_ALLOWED_ORIGINS: '*' }, 'wildcard origin'],
    [{ ...requiredEnvironment, EDITOR_MCP_HTTP_BODY_LIMIT_BYTES: '100' }, 'tiny body limit'],
    [{ ...requiredEnvironment, EDITOR_MCP_AUTH_MAX_IN_FLIGHT: '0' }, 'zero auth bulkhead'],
    [
      { ...requiredEnvironment, EDITOR_MCP_HTTP_PORT: '1111', PORT: '4321' },
      'conflicting Railway and application ports',
    ],
  ] as const)('rejects %s (%s)', (environment, _description) => {
    void _description;
    expect(() => parseHttpServerConfig(environment)).toThrow();
  });

  it('creates a complete validated test configuration without process.env', () => {
    const config = createHttpServerConfig({ port: 0 });
    expect(config.port).toBe(0);
    expect(config.publicUrl.href).toBe('http://127.0.0.1/mcp');
  });
});
