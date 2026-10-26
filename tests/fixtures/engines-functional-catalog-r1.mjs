import { createInterface } from 'node:readline';
const protocol = process.argv[2], mode = process.env.DEXTER_FIXTURE_MODE;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
if (process.argv.includes('--version')) { console.log(protocol === 'msp' ? 'Muse Code 1.4.4-R5419.1' : 'grok 1.0.50'); process.exit(0); }
createInterface({ input: process.stdin }).on('line', line => {
  const { id, method } = JSON.parse(line);
  if (id === undefined) return;
  const reply = result => send({ jsonrpc: '2.0', id, result });
  if (method === 'initialize') {
    if (mode === 'auth') { process.stderr.write('fixture-private-stderr\n'); send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'token=fixture-private-value', data: { kind: 'authRequired', cursor: 'fixture-private-cursor' } } }); return; }
    if (protocol === 'msp') reply({ schema: { version: 1, fingerprint: 'sha256:7c94f153c41659cb3f1bd3c3e04438be254644cb2a97d65d48edc7449b74858a' }, sessionDurability: 'ephemeral', grantedCapabilities: [] });
    else reply({ protocolVersion: 1, agentInfo: { name: protocol === 'antigravity' ? 'antigravity-acp' : 'grok', version: protocol === 'antigravity' ? '1.3.0' : '1.0.50' },
      agentCapabilities: { _meta: { 'x.ai/hooks': { blockingEvents: ['pre_tool_use'], decisions: ['deny'] } } },
      _meta: { grokShell: true, agentVersion: '1.0.50', modelState: mode === 'empty' ? {} : {
        currentModelId: mode === 'unknown-default' ? 'unadvertised' : 'grok-fixture', availableModels: [{ modelId: 'grok-fixture' }],
        configOptions: [{ id: 'reasoning_effort', type: 'select', currentValue: 'medium', options: ['low', 'medium', 'high'].map(value => ({ value })) },
          { id: 'speed', type: 'select', currentValue: 'fast', options: [{ value: 'fast' }] }] } } });
  } else if (method === 'model/list') reply({ providerId: 'meta', models: mode === 'empty' ? [] : [{ modelId: 'muse-synthetic-1', providerId: 'meta', isDefault: true, variants: ['low', 'high', 'max', 'ultra'] }] });
  else throw Error('Catalog attempted session or inference: ' + method);
});
