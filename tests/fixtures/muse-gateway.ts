import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';

const receipt = process.argv[2]!;
createInterface({ input: process.stdin }).on('line', line => {
  const value = JSON.parse(line) as { id?: number; method: string; params: { name?: string; arguments?: { text: string } } };
  if (value.id === undefined) return;
  let result: object = {};
  if (value.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'dexter_gateway_fixture', version: '1' } };
  if (value.method === 'tools/list') result = { tools: [{ name: 'dx_0123456789abcdef01234567', description: 'Exact synthetic action', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }] };
  if (value.method === 'tools/call') {
    if (value.params.name !== 'dx_0123456789abcdef01234567') process.exit(2);
    const denied = value.params.arguments?.text === 'deny-synthetic-action';
    writeFileSync(receipt, JSON.stringify({ tool: value.params.name, text: value.params.arguments?.text, approved: !denied }), { mode: 0o600 });
    result = { content: [{ type: 'text', text: denied ? 'Denied by host' : 'Exact action executed' }], isError: denied };
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: value.id, result })}\n`);
});
