import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
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
  await access(join(installedPackageDirectory, 'dist', 'http', 'cli.js'));
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

  const installedHttpBin = join(
    consumerDirectory,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'editor-mcp-http.CMD' : 'editor-mcp-http',
  );
  await access(installedHttpBin);
  const metadataServer = createServer((request, response) => {
    if (request.url !== '/.well-known/oauth-authorization-server') {
      response.writeHead(404).end();
      return;
    }
    const address = metadataServer.address();
    if (address === null || typeof address === 'string') {
      response.writeHead(500).end();
      return;
    }
    const issuer = `http://127.0.0.1:${String(address.port)}`;
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        issuer,
        authorization_endpoint: `${issuer}/oauth2/authorize`,
        token_endpoint: `${issuer}/oauth2/token`,
        introspection_endpoint: `${issuer}/oauth2/introspection`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
      }),
    );
  });
  await new Promise<void>((resolve) => metadataServer.listen(0, '127.0.0.1', resolve));
  const metadataAddress = metadataServer.address();
  assert.ok(metadataAddress !== null && typeof metadataAddress !== 'string');
  const childEnvironment = { ...process.env };
  delete childEnvironment['PORT'];
  const httpServer = spawn(installedHttpBin, [], {
    cwd: consumerDirectory,
    env: {
      ...childEnvironment,
      EDITOR_MCP_PUBLIC_URL: 'http://127.0.0.1/mcp',
      EDITOR_MCP_AUTH_ISSUER_URL: `http://127.0.0.1:${String(metadataAddress.port)}`,
      EDITOR_MCP_WORKOS_CLIENT_ID: 'client_package_test',
      EDITOR_MCP_WORKOS_CLIENT_SECRET: 'secret_package_test',
      EDITOR_MCP_HTTP_HOST: '127.0.0.1',
      EDITOR_MCP_HTTP_PORT: '0',
      EDITOR_MCP_HTTP_ALLOWED_HOSTS: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let httpStdout = '';
  let httpStderr = '';
  httpServer.stdout.on('data', (chunk: Buffer) => {
    httpStdout += chunk.toString();
  });
  httpServer.stderr.on('data', (chunk: Buffer) => {
    httpStderr += chunk.toString();
  });
  const httpReady = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`packed HTTP binary did not start: ${httpStderr}`));
    }, 5_000);
    httpServer.stdout.on('data', () => {
      if (httpStdout.includes('/mcp')) {
        clearTimeout(timer);
        resolve();
      }
    });
    httpServer.once('error', reject);
  });
  const httpExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      httpServer.once('exit', (code, signal) => {
        resolve({ code, signal });
      });
    },
  );

  try {
    await httpReady;
    httpServer.kill('SIGTERM');
    assert.deepEqual(await httpExit, { code: 0, signal: null });
    assert.equal(httpStderr, '');
  } finally {
    httpServer.kill('SIGKILL');
    await new Promise<void>((resolve, reject) => {
      metadataServer.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
