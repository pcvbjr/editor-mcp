import { request as httpRequest } from 'node:http';
import { describe, expect, it } from 'vitest';

import { createHttpServerConfig } from '../../src/http/config.js';
import { createTestHttpHarness } from '../support/http-test-harness.js';

const config = createHttpServerConfig({
  port: 0,
  allowedHosts: ['127.0.0.1', 'localhost'],
  allowedOrigins: ['https://agent.example'],
});

function requestWithAuthority(url: URL, authority: string): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers: { host: authority } }, (response) => {
      response.resume();
      response.once('end', () => {
        resolve(response.statusCode);
      });
    });
    request.once('error', reject);
    request.end();
  });
}

describe('HTTP request security', () => {
  it('allows native clients and an exact configured origin', async () => {
    const harness = createTestHttpHarness({ config });
    const baseUrl = await harness.start();
    try {
      expect((await fetch(new URL('/healthz', baseUrl))).status).toBe(200);
      expect(
        (
          await fetch(new URL('/healthz', baseUrl), {
            headers: { origin: 'https://agent.example' },
          })
        ).status,
      ).toBe(200);
    } finally {
      await harness.close();
    }
  });

  it.each([
    [{ origin: 'https://evil.example' }],
    [{ origin: 'null' }],
    [{ origin: 'https://agent.example.evil' }],
  ])('rejects an untrusted request with headers %o', async (headers) => {
    const harness = createTestHttpHarness({ config });
    const baseUrl = await harness.start();
    try {
      const response = await fetch(new URL('/healthz', baseUrl), { headers });
      expect(response.status).toBe(403);
    } finally {
      await harness.close();
    }
  });

  it('rejects an untrusted Host authority', async () => {
    const harness = createTestHttpHarness({ config });
    const baseUrl = await harness.start();
    try {
      await expect(
        requestWithAuthority(new URL('/healthz', baseUrl), 'evil.example'),
      ).resolves.toBe(403);
    } finally {
      await harness.close();
    }
  });

  it('accepts Railway health authority only on health routes', async () => {
    const harness = createTestHttpHarness({ config });
    const baseUrl = await harness.start();
    try {
      const health = await requestWithAuthority(
        new URL('/healthz', baseUrl),
        'healthcheck.railway.app',
      );
      const metadata = await requestWithAuthority(
        new URL('/.well-known/oauth-protected-resource/mcp', baseUrl),
        'healthcheck.railway.app',
      );
      expect(health).toBe(200);
      expect(metadata).toBe(403);
    } finally {
      await harness.close();
    }
  });

  it('replaces invalid request IDs and emits no permissive CORS headers', async () => {
    const harness = createTestHttpHarness({ config });
    const baseUrl = await harness.start();
    try {
      const response = await fetch(new URL('/healthz', baseUrl), {
        headers: { 'x-railway-request-id': 'invalid request id' },
      });
      expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/u);
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
      expect(response.headers.get('x-powered-by')).toBeNull();
    } finally {
      await harness.close();
    }
  });
});
