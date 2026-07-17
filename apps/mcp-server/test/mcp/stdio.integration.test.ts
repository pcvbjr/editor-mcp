import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { fileURLToPath } from 'node:url';
import { mkdtemp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

import packageManifest from '../../package.json' with { type: 'json' };

import { ObservedStdioTransport } from '../support/observed-stdio-transport.js';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const compiledCli = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

describe('compiled MCP stdio process', () => {
  it('starts through the advertised bin target and exits with code zero on EOF', async () => {
    const binTarget = packageManifest.bin['editor-mcp'];
    expect(binTarget).toBe('./dist/cli.js');
    const symlinkDirectory = await mkdtemp(`${tmpdir()}/editor-mcp-bin-`);
    const symlinkPath = `${symlinkDirectory}/editor-mcp`;
    await symlink(compiledCli, symlinkPath);

    const transport = new ObservedStdioTransport(process.execPath, [symlinkPath], repositoryRoot);
    const client = new Client({ name: 'stdio-integration-client', version: '1.0.0' });

    try {
      await client.connect(transport, { timeout: 5_000 });
      expect(client.getServerVersion()).toMatchObject({
        name: packageManifest.name,
        version: packageManifest.version,
      });
      expect(client.getServerCapabilities()?.tools).toBeUndefined();
      expect(client.getServerCapabilities()?.resources).toBeUndefined();
      expect(client.getServerCapabilities()?.prompts).toBeUndefined();
    } finally {
      await client.close();
    }

    await expect(transport.childExit).resolves.toEqual({ code: 0, signal: null });
    expect(transport.errors).toEqual([]);
    expect(transport.stderr.join('')).toBe('');
  });
});
