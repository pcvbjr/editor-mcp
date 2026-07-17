import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

import packageManifest from '../../package.json' with { type: 'json' };

import { ObservedStdioTransport } from '../support/observed-stdio-transport.js';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const compiledCli = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

describe('compiled MCP stdio process', () => {
  it('completes initialization through the official stdio client transport', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [compiledCli],
      cwd: repositoryRoot,
      stderr: 'pipe',
    });
    const stderr: string[] = [];
    transport.stderr?.on('data', (chunk: Buffer) => {
      stderr.push(chunk.toString());
    });
    const client = new Client({ name: 'official-stdio-client', version: '1.0.0' });

    try {
      await client.connect(transport, { timeout: 5_000 });
      expect(client.getServerVersion()).toMatchObject({
        name: packageManifest.name,
        version: packageManifest.version,
      });
    } finally {
      await client.close();
    }

    expect(stderr.join('')).toBe('');
  });

  it('starts through the advertised bin target and exits with code zero on EOF', async () => {
    const binTarget = packageManifest.bin['editor-mcp'];
    expect(binTarget).toBe('./dist/cli.js');
    const symlinkDirectory = await mkdtemp(`${tmpdir()}/editor-mcp-bin-`);
    const symlinkPath = `${symlinkDirectory}/editor-mcp`;
    try {
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
    } finally {
      await rm(symlinkDirectory, { recursive: true, force: true });
    }
  });

  it('bounds cleanup when an observed child ignores EOF and graceful termination', async () => {
    const transport = new ObservedStdioTransport(
      process.execPath,
      ['--eval', "process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1_000);"],
      repositoryRoot,
      20,
    );

    await transport.start();
    await expect(transport.close()).resolves.toBeUndefined();

    const exit = await transport.childExit;
    expect(exit.signal !== null || (exit.code !== null && exit.code !== 0)).toBe(true);
  });
});
