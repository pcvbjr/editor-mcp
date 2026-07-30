import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

import { HocuspocusProvider } from '@hocuspocus/provider';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, describe, expect, it } from 'vitest';

interface ChatResponse {
  readonly editorUrl: string;
  readonly session: {
    readonly identity: {
      readonly tenantId: string;
      readonly documentId: string;
      readonly documentIncarnation: string;
      readonly collaborationField: string;
      readonly schemaId: string;
      readonly schemaVersion: number;
    };
    readonly documentName: string;
    readonly collaborationUrl: string;
  };
  readonly result: {
    readonly committedRevision: string;
    readonly generatedChangeIds: readonly string[];
  };
}

const processes: ChildProcess[] = [];

async function availablePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Test port is unavailable');
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
  return address.port;
}

async function startDemo(): Promise<string> {
  const apiPort = await availablePort();
  const collaborationPort = await availablePort();
  const origin = `http://127.0.0.1:${String(apiPort)}`;
  const child = spawn(process.execPath, ['dist/server/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      DEMO_PORT: String(apiPort),
      DEMO_COLLABORATION_PORT: String(collaborationPort),
      DEMO_PUBLIC_ORIGIN: origin,
      DEMO_COLLABORATION_URL: `ws://127.0.0.1:${String(collaborationPort)}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  processes.push(child);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Demo server did not start'));
    }, 10_000);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Demo server exited with ${String(code)}`));
    });
    child.stdout.on('data', (chunk: Buffer) => {
      if (chunk.toString('utf8').includes('Editor MCP demo:')) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  return origin;
}

async function waitForSync(provider: HocuspocusProvider): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Collaboration did not synchronize'));
    }, 5_000);
    provider.on('synced', ({ state }: { state: boolean }) => {
      if (state) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
}

afterEach(async () => {
  await Promise.all(
    processes.splice(0).map(async (child) => {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      await once(child, 'exit');
    }),
  );
});

describe('collaborative product demo', () => {
  it('creates through MCP, synchronizes the suggestion, and accepts it as a human', async () => {
    const origin = await startDemo();
    const mcpClient = new Client({ name: 'external-agent-smoke', version: '1.0.0' });
    await mcpClient.connect(
      new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)) as Transport,
    );
    try {
      const tools = await mcpClient.listTools();
      expect(tools.tools.map(({ name }) => name)).toEqual([
        'editor.document.create.v1',
        'editor.document.read.v1',
        'editor.document.apply_edits.v1',
      ]);
    } finally {
      await mcpClient.close();
    }

    const chatResponse = await fetch(`${origin}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Create a launch brief.' }),
    });
    expect(chatResponse.status).toBe(200);
    const chat = (await chatResponse.json()) as ChatResponse;
    expect(chat.editorUrl).toContain(chat.session.identity.documentId);
    expect(chat.result.generatedChangeIds).toHaveLength(1);
    const changeId = chat.result.generatedChangeIds[0];
    if (changeId === undefined) throw new Error('Suggested change ID is missing');

    const provider = new HocuspocusProvider({
      url: chat.session.collaborationUrl,
      name: chat.session.documentName,
    });
    try {
      await waitForSync(provider);
      const changes = provider.document.getMap<{ status: string }>('diffChanges');
      expect(changes.get(changeId)).toMatchObject({ status: 'pending' });

      const identity = chat.session.identity;
      const reviewResponse = await fetch(
        `${origin}/v1/documents/${encodeURIComponent(identity.documentId)}:applyEdits`,
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer demo-human',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            protocolVersion: 1,
            ...identity,
            idempotencyKey: 'demo-review-integration',
            readRevision: chat.result.committedRevision,
            atomic: true,
            changeMode: 'direct',
            operations: [
              {
                operationId: 'accept-demo-change',
                kind: 'accept_change',
                changeId,
              },
            ],
          }),
        },
      );
      expect(reviewResponse.status).toBe(200);

      await expect.poll(() => changes.get(changeId)?.status).toBe('accepted');
      const query = new URLSearchParams({
        documentIncarnation: identity.documentIncarnation,
        collaborationField: identity.collaborationField,
        schemaId: identity.schemaId,
        schemaVersion: String(identity.schemaVersion),
        representationProfile: 'agent-html/v1',
      });
      const readResponse = await fetch(
        `${origin}/v1/documents/${encodeURIComponent(identity.documentId)}?${query.toString()}`,
        { headers: { authorization: 'Bearer demo-human' } },
      );
      const read = (await readResponse.json()) as { representation: { html: string } };
      expect(read.representation.html).toContain('Collaborative working brief');
      expect(read.representation.html).not.toContain('data-diff-change-id');
    } finally {
      provider.destroy();
    }
  }, 15_000);
});
