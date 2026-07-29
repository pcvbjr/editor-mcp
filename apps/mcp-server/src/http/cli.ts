#!/usr/bin/env node

import process from 'node:process';

import { main } from './main.js';

void main().catch((error: unknown) => {
  const message =
    error instanceof Error && error.message.length > 0 ? error.message : 'unknown error';
  process.stderr.write(
    `MCP HTTP server failed to initialize: ${message.replace(/[\r\n]+/gu, ' ')}\n`,
  );
  process.exitCode = 1;
});
