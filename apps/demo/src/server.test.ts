import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

import { HocuspocusProvider } from '@hocuspocus/provider';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, describe, expect, it } from 'vitest';

interface Identity {
  readonly tenantId: string;
  readonly documentId: string;
  readonly documentIncarnation: string;
  readonly collaborationField: string;
  readonly schemaId: string;
  readonly schemaVersion: number;
}

interface ChangeRecord {
  readonly id: string;
  readonly status: 'accepted' | 'pending' | 'rejected';
  readonly suggestionGroupId?: string;
  readonly suggestionGroupName?: string;
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

async function startDemo(): Promise<{ origin: string; collaborationUrl: string }> {
  const apiPort = await availablePort();
  const collaborationPort = await availablePort();
  const origin = `http://127.0.0.1:${String(apiPort)}`;
  const collaborationUrl = `ws://127.0.0.1:${String(collaborationPort)}`;
  const child = spawn(process.execPath, ['dist/server/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      DEMO_PORT: String(apiPort),
      DEMO_COLLABORATION_PORT: String(collaborationPort),
      DEMO_PUBLIC_ORIGIN: origin,
      DEMO_COLLABORATION_URL: collaborationUrl,
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
  return { origin, collaborationUrl };
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

function structuredContent(result: unknown): Record<string, unknown> {
  if (
    typeof result !== 'object' ||
    result === null ||
    !('structuredContent' in result) ||
    typeof result.structuredContent !== 'object' ||
    result.structuredContent === null
  ) {
    throw new Error('MCP result did not contain structured content');
  }
  return result.structuredContent as Record<string, unknown>;
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
  it('lets an external agent create a named edit group and a human review edits separately', async () => {
    const { origin, collaborationUrl } = await startDemo();
    const client = new Client({ name: 'external-agent-smoke', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)) as Transport);

    const tools = await client.listTools();
    expect(tools.tools.map(({ name }) => name)).toEqual([
      'editor.document.create.v1',
      'editor.document.read.v1',
      'editor.document.apply_edits.v1',
    ]);

    const created = structuredContent(
      await client.callTool({
        name: 'editor.document.create.v1',
        arguments: {
          protocolVersion: 1,
          tenantId: 'demo',
          collaborationField: 'default',
          schemaId: 'editor-mcp/mvp',
          schemaVersion: 1,
          idempotencyKey: 'group-review-create',
        },
      }),
    );
    const identity = {
      tenantId: created['tenantId'],
      documentId: created['documentId'],
      documentIncarnation: created['documentIncarnation'],
      collaborationField: created['collaborationField'],
      schemaId: created['schemaId'],
      schemaVersion: created['schemaVersion'],
    } as Identity;
    expect(created['editorUrl']).toContain(identity.documentId);

    const read = structuredContent(
      await client.callTool({
        name: 'editor.document.read.v1',
        arguments: {
          protocolVersion: 1,
          ...identity,
          selection: { kind: 'document' },
          representationProfile: 'agent-html/v1',
        },
      }),
    );
    const blocks = read['blocks'] as readonly { id: string; contentDigest: string }[];
    const anchor = blocks.at(-1);
    if (anchor === undefined) throw new Error('Created document has no anchor block');

    const applied = structuredContent(
      await client.callTool({
        name: 'editor.document.apply_edits.v1',
        arguments: {
          protocolVersion: 1,
          ...identity,
          idempotencyKey: 'group-review-apply',
          readRevision: read['revision'],
          atomic: true,
          changeMode: 'suggest',
          suggestionGroupName: 'Draft launch sections',
          operations: [
            {
              operationId: 'add-summary',
              kind: 'insert_after',
              anchorBlockId: anchor.id,
              expectedAnchorDigest: anchor.contentDigest,
              html: '<h2>Summary</h2><p>Keep this accepted edit.</p>',
            },
            {
              operationId: 'add-risks',
              kind: 'insert_after',
              anchorBlockId: anchor.id,
              expectedAnchorDigest: anchor.contentDigest,
              html: '<h2>Risks</h2><p>Remove this rejected edit.</p>',
            },
          ],
        },
      }),
    );
    const changeIds = applied['generatedChangeIds'] as readonly string[];
    expect(changeIds).toHaveLength(2);

    const sessionResponse = await fetch(
      `${origin}/api/documents/${encodeURIComponent(identity.documentId)}/session?incarnation=${encodeURIComponent(identity.documentIncarnation)}`,
    );
    expect(sessionResponse.status).toBe(200);
    const session = (await sessionResponse.json()) as { documentName: string };
    const provider = new HocuspocusProvider({ url: collaborationUrl, name: session.documentName });
    try {
      await waitForSync(provider);
      const changes = provider.document.getMap<ChangeRecord>('diffChanges');
      const records = changeIds.map((changeId) => changes.get(changeId));
      expect(
        records.every((record) => record?.suggestionGroupName === 'Draft launch sections'),
      ).toBe(true);
      expect(new Set(records.map((record) => record?.suggestionGroupId)).size).toBe(1);

      const review = async (changeId: string, decision: 'accept' | 'reject') => {
        const latest = structuredContent(
          await client.callTool({
            name: 'editor.document.read.v1',
            arguments: {
              protocolVersion: 1,
              ...identity,
              selection: { kind: 'document' },
              representationProfile: 'agent-html/v1',
            },
          }),
        );
        const response = await fetch(
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
              idempotencyKey: `review-${decision}-${changeId}`,
              readRevision: latest['revision'],
              atomic: true,
              changeMode: 'direct',
              operations: [
                {
                  operationId: `${decision}-${changeId}`,
                  kind: decision === 'accept' ? 'accept_change' : 'reject_change',
                  changeId,
                },
              ],
            }),
          },
        );
        expect(response.status).toBe(200);
      };

      const acceptedId = changeIds[0];
      const rejectedId = changeIds[1];
      if (acceptedId === undefined || rejectedId === undefined) {
        throw new Error('Expected two change IDs');
      }
      await review(acceptedId, 'accept');
      await expect.poll(() => changes.get(acceptedId)?.status).toBe('accepted');
      expect(changes.get(rejectedId)?.status).toBe('pending');

      await review(rejectedId, 'reject');
      await expect.poll(() => changes.get(rejectedId)?.status).toBe('rejected');

      const finalRead = structuredContent(
        await client.callTool({
          name: 'editor.document.read.v1',
          arguments: {
            protocolVersion: 1,
            ...identity,
            selection: { kind: 'document' },
            representationProfile: 'agent-html/v1',
          },
        }),
      );
      const representation = finalRead['representation'] as { html: string };
      expect(representation.html).toContain('Keep this accepted edit.');
      expect(representation.html).not.toContain('Remove this rejected edit.');
      expect(representation.html).not.toContain('data-diff-change-kind');
    } finally {
      provider.destroy();
      await client.close();
    }
  }, 15_000);
});
