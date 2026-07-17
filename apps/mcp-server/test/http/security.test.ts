import { describe, expect, it } from 'vitest';

import { createHttpApp } from '../../src/http/app.js';
import { createHttpServerConfig } from '../../src/http/config.js';

const config = createHttpServerConfig({
  allowedHosts: ['127.0.0.1', 'localhost'],
  allowedOrigins: ['https://agent.example'],
});
const app = createHttpApp({ config });

describe('HTTP request security', () => {
  it('allows native clients without Origin and ignores the port in an allowed hostname', async () => {
    const response = await app.request('http://127.0.0.1:43123/healthz');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });

  it('allows an exact configured origin', async () => {
    const response = await app.request('http://127.0.0.1:43123/healthz', {
      headers: { Origin: 'https://agent.example' },
    });

    expect(response.status).toBe(200);
  });

  it.each([
    ['http://evil.example/healthz', undefined],
    ['http://127.0.0.1:43123/healthz', { Origin: 'https://evil.example' }],
    ['http://127.0.0.1:43123/healthz', { Origin: 'null' }],
    ['http://127.0.0.1:43123/healthz', { Origin: 'https://agent.example.evil' }],
  ] as const)('rejects an untrusted request', async (url, headers) => {
    const response =
      headers === undefined ? await app.request(url) : await app.request(url, { headers });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'Forbidden' });
  });

  it.each(['user@localhost', 'evil@localhost:43123', 'localhost/path', 'localhost?query'])(
    'rejects malformed Host authority %s',
    async (host) => {
      const response = await app.request('http://127.0.0.1:43123/healthz', {
        headers: { Host: host },
      });

      expect(response.status).toBe(403);
    },
  );

  it('does not emit permissive CORS headers', async () => {
    const response = await app.request('http://127.0.0.1:43123/healthz');

    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});
