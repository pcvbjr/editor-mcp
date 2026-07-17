export const mcpHeaders = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
} as const;

export const initializeBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'http-contract-client', version: '1.0.0' },
  },
});
