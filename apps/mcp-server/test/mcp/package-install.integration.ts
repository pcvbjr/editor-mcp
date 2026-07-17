import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import packageManifest from '../../package.json' with { type: 'json' };

const mcpServerDirectory = fileURLToPath(new URL('../../', import.meta.url));
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

function runPnpm(arguments_: readonly string[], cwd: string): void {
  const result = spawnSync(pnpmCommand, [...arguments_], {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
  });

  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      [
        `pnpm ${arguments_.join(' ')} failed with status ${String(result.status)}`,
        result.stdout,
        result.stderr,
      ]
        .filter((part) => part.length > 0)
        .join('\n'),
    );
  }
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'editor-mcp-package-'));
const consumerDirectory = join(temporaryDirectory, 'consumer');

try {
  runPnpm(['pack', '--pack-destination', temporaryDirectory], mcpServerDirectory);
  const tarballNames = (await readdir(temporaryDirectory)).filter((name) => name.endsWith('.tgz'));
  assert.equal(tarballNames.length, 1, 'package smoke expected exactly one tarball');
  const tarballName = tarballNames[0];
  assert.ok(tarballName);
  const tarballPath = join(temporaryDirectory, tarballName);

  await mkdir(consumerDirectory);
  await writeFile(
    join(consumerDirectory, 'package.json'),
    `${JSON.stringify({ name: 'editor-mcp-package-consumer', private: true }, null, 2)}\n`,
  );
  runPnpm(['add', '--prefer-offline', '--ignore-scripts', tarballPath], consumerDirectory);

  const installedPackageDirectory = join(
    consumerDirectory,
    'node_modules',
    '@editor-mcp',
    'mcp-server',
  );
  await access(join(installedPackageDirectory, 'dist', 'cli.js'));
  await assert.rejects(access(join(installedPackageDirectory, 'src')));
  await assert.rejects(access(join(installedPackageDirectory, 'dist', 'tsconfig.tsbuildinfo')));

  const installedBin = join(
    consumerDirectory,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'editor-mcp.CMD' : 'editor-mcp',
  );
  const transport = new StdioClientTransport({
    command: installedBin,
    cwd: consumerDirectory,
    stderr: 'pipe',
  });
  const stderr: string[] = [];
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderr.push(chunk.toString());
  });
  const client = new Client({ name: 'packed-package-client', version: '1.0.0' });

  try {
    await client.connect(transport, { timeout: 5_000 });
    assert.deepEqual(client.getServerVersion(), {
      name: packageManifest.name,
      version: packageManifest.version,
    });
  } finally {
    await client.close();
  }

  assert.equal(stderr.join(''), '');
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
