import { z } from 'zod';

import type { CapabilityRegistry } from '../../src/server.js';

const probeInputSchema = z
  .object({
    message: z.string().min(1),
  })
  .strict();

type ProbeInput = z.infer<typeof probeInputSchema>;

const probeOutputSchema = z
  .object({
    echo: z.string(),
  })
  .strict();

export function registerProbeTool(server: CapabilityRegistry, onCall: () => void): void {
  server.registerTool(
    'test.probe',
    {
      inputSchema: probeInputSchema,
      outputSchema: probeOutputSchema,
    },
    ({ message }: ProbeInput) => {
      onCall();
      const output = { echo: message };
      return {
        content: [{ type: 'text', text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );
}
