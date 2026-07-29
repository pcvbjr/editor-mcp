import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import type { InternalErrorReporter } from '../../src/diagnostics.js';
import { createHttpServerConfig } from '../../src/http/config.js';
import { createTestHttpHarness } from '../support/http-test-harness.js';

describe('HTTP application contract', () => {
  it('serves separate health, readiness, and protected-resource routes', async () => {
    const harness = createTestHttpHarness();
    const baseUrl = await harness.start();
    try {
      await expect(
        fetch(new URL('/healthz', baseUrl)).then((response) => response.json()),
      ).resolves.toEqual({ status: 'ok' });
      await expect(
        fetch(new URL('/readyz', baseUrl)).then((response) => response.json()),
      ).resolves.toEqual({ status: 'ready' });
      const metadata = await fetch(new URL('/.well-known/oauth-protected-resource/mcp', baseUrl));
      expect(metadata.status).toBe(200);
      await expect(metadata.json()).resolves.toMatchObject({
        resource: 'http://127.0.0.1/mcp',
        authorization_servers: ['https://authkit.example.test'],
      });
      expect((await fetch(new URL('/unknown', baseUrl))).status).toBe(404);
    } finally {
      await harness.close();
    }
  });

  it('rejects unsupported methods and missing bearer credentials', async () => {
    const harness = createTestHttpHarness();
    const baseUrl = await harness.start();
    try {
      const getResponse = await fetch(new URL('/mcp', baseUrl));
      expect(getResponse.status).toBe(405);
      expect(getResponse.headers.get('allow')).toBe('POST');

      const unauthorized = await fetch(new URL('/mcp', baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.headers.get('www-authenticate')).toContain('resource_metadata=');
    } finally {
      await harness.close();
    }
  });

  it('rejects new MCP work after readiness is withdrawn', async () => {
    const createServer = vi.fn();
    const harness = createTestHttpHarness({ createServer });
    const baseUrl = await harness.start();
    harness.readiness.markNotReady();
    try {
      const response = await fetch(new URL('/mcp', baseUrl), {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': 'application/json',
        },
        body: '{}',
      });
      expect(response.status).toBe(503);
      expect(response.headers.get('retry-after')).toBe('1');
      expect(createServer).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });

  it('bounds and sanitizes JSON parsing failures', async () => {
    const harness = createTestHttpHarness({
      config: createHttpServerConfig({ port: 0, bodyLimitBytes: 1_024 }),
    });
    const baseUrl = await harness.start();
    try {
      const malformed = await fetch(new URL('/mcp', baseUrl), {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': 'application/json',
        },
        body: '{',
      });
      expect(malformed.status).toBe(400);
      expect(await malformed.text()).not.toContain('SyntaxError');

      const oversized = await fetch(new URL('/mcp', baseUrl), {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ value: 'x'.repeat(2_000) }),
      });
      expect(oversized.status).toBe(413);
    } finally {
      await harness.close();
    }
  });

  it('sanitizes request failures and reports request and cleanup causes internally', async () => {
    const reportError = vi.fn<InternalErrorReporter>();
    const harness = createTestHttpHarness({
      reportError,
      createServer: () => ({
        connect: () => Promise.reject(new Error('TOP_SECRET_REQUEST')),
        close: () => Promise.reject(new Error('TOP_SECRET_CLOSE')),
      }),
    });
    const baseUrl = await harness.start();
    try {
      const response = await fetch(new URL('/mcp', baseUrl), {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': 'application/json',
        },
        body: '{}',
      });
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain('TOP_SECRET');
      expect(reportError.mock.calls.map(([event]) => event.phase)).toEqual(
        expect.arrayContaining(['request', 'close']),
      );
    } finally {
      await harness.close();
    }
  });

  it('maps invalid verifier tokens to a safe 401 response', async () => {
    const harness = createTestHttpHarness({
      tokenVerifier: {
        verifyAccessToken: () => Promise.reject(new InvalidTokenError('Invalid token')),
      },
    });
    const baseUrl = await harness.start();
    try {
      const response = await fetch(new URL('/mcp', baseUrl), {
        method: 'POST',
        headers: { authorization: 'Bearer rejected', 'content-type': 'application/json' },
        body: '{}',
      });
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain('rejected');
    } finally {
      await harness.close();
    }
  });

  it('never records bearer credentials in structured request logs', async () => {
    const messages: string[] = [];
    const logger = pino({}, { write: (message) => messages.push(message) });
    const harness = createTestHttpHarness({
      logger,
      tokenVerifier: {
        verifyAccessToken: () => Promise.reject(new InvalidTokenError('Invalid token')),
      },
    });
    const baseUrl = await harness.start();
    try {
      await fetch(new URL('/mcp?access_token=TOP_SECRET_QUERY', baseUrl), {
        method: 'POST',
        headers: {
          authorization: 'Bearer TOP_SECRET_BEARER',
          'content-type': 'application/json',
        },
        body: '{}',
      });
      expect(messages.join('')).not.toContain('TOP_SECRET_BEARER');
      expect(messages.join('')).not.toContain('TOP_SECRET_QUERY');
      expect(messages.join('')).not.toContain('authorization');
    } finally {
      await harness.close();
    }
  });
});
