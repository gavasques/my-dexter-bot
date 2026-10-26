import { createInterface } from 'node:readline';

// Synthetic transport only: no real provider, account, configuration or network access.
const args = process.argv.slice(2);
const mode = process.env.DEXTER_FIXTURE_MODE ?? 'native-selection';
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const flag = name => args.includes(name) ? args[args.indexOf(name) + 1] : null;
if (args.includes('--version')) { console.log('synthetic-engine 1.2.3'); process.exit(0); }
if (args.includes('--help')) {
  console.log(`Options:
  --model <model>     Provide an alias (e.g. 'fixture-opus' or 'fixture-sonnet')
                     or a model's full name.
  --effort <level>    Effort level (low, high)
  --output-format <format> Output format
`);
  process.exit(0);
}
if (args.includes('auth')) {
  console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }));
  process.exit(0);
}

const lines = createInterface({ input: process.stdin });
// Keep Codex RPC alive until its client closes it; Claude exits after its result.
const heartbeat = setInterval(() => {}, 1000);
let threadOptions = null;
const nativeThread = 'synthetic-native-thread';
lines.on('line', line => {
  const request = JSON.parse(line);
  if (args.includes('-p')) {
    send({ type: 'system', subtype: 'init', session_id: flag('--session-id') ?? flag('--resume') });
    send({ type: 'result', subtype: 'success', result: JSON.stringify({
      model: flag('--model'), effort: flag('--effort'), fast: args.includes('--fast'),
      speed: flag('--speed'), serviceTier: flag('--service-tier'),
    }), usage: {} });
    clearInterval(heartbeat);
    return;
  }
  if (request.method === 'initialized') return;
  const reply = result => send({ id: request.id, result });
  if (request.method === 'initialize') { reply({ userAgent: 'synthetic' }); return; }
  if (request.method === 'model/list') {
    // Deliberately distinct catalog row id and native model id catches wrong projection.
    reply({ data: [{ id: 'picker-row', model: 'fixture-native-model', displayName: 'Synthetic Model',
      isDefault: true, hidden: false, defaultReasoningEffort: 'deep',
      supportedReasoningEfforts: [{ reasoningEffort: 'deep' }, { reasoningEffort: 'light' }],
      serviceTiers: [{ id: 'fixture-priority', name: 'Synthetic Priority' }, { id: 'fixture-standard', name: 'Synthetic Standard' }],
    }, { id: 'hidden-row', model: 'fixture-hidden-model', hidden: true,
      supportedReasoningEfforts: [], serviceTiers: [] }], nextCursor: null });
    return;
  }
  if (mode === 'catalog-only') {
    // A catalog must never open a thread or query account/config metadata.
    send({ id: request.id, error: { code: -32601 } });
    return;
  }
  if (request.method === 'account/read') { reply({ account: { type: 'chatgpt' } }); return; }
  if (request.method === 'config/read') { reply({ config: {} }); return; }
  if (request.method === 'thread/start' || request.method === 'thread/resume') {
    threadOptions = { model: request.params.model, serviceTier: request.params.serviceTier };
    reply({ thread: { id: nativeThread }, instructionSources: [] });
    return;
  }
  if (request.method === 'turn/start') {
    const turnId = 'synthetic-native-turn';
    const observed = { thread: threadOptions, turn: {
      model: request.params.model, effort: request.params.effort, serviceTier: request.params.serviceTier,
    } };
    reply({ turn: { id: turnId } });
    send({ method: 'item/agentMessage/delta', params: { threadId: nativeThread, turnId, delta: JSON.stringify(observed) } });
    send({ method: 'turn/completed', params: { threadId: nativeThread, turn: { id: turnId, status: 'completed' } } });
    return;
  }
  send({ id: request.id, error: { code: -32601 } });
});
