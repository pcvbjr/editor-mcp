import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const probeInputSchema = z
  .object({
    message: z.string().min(1),
  })
  .strict();

const probeOutputSchema = z
  .object({
    echo: z.string(),
  })
  .strict();

export function registerProbeTool(server: McpServer, onCall: () => void): void {
  server.registerTool(
    'test.probe',
    {
      inputSchema: probeInputSchema,
      outputSchema: probeOutputSchema,
    },
    ({ message }) => {
      onCall();
      const output = { echo: message };
      return {
        content: [{ type: 'text', text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );
}
