/* c8 ignore file -- process entrypoint is exercised by the live harness, not unit tests. */
import { createServer } from 'node:http';

import { createVisualHarnessHandler } from './index.js';

const host = process.env['HOST'] ?? '127.0.0.1';
const parsedPort = Number(process.env['PORT'] ?? '4173');
if (!Number.isSafeInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535) {
  throw new TypeError('PORT must be an integer between 1 and 65535');
}

const server = createServer(createVisualHarnessHandler());
server.listen(parsedPort, host, () => {
  process.stdout.write(
    `Editor MCP fixture browser: http://${host}:${String(parsedPort)}/fixtures\n`,
  );
});

const shutdown = (): void => {
  server.close((error) => {
    if (error !== undefined) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    }
  });
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
