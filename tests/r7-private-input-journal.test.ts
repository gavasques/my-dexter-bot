import assert from 'node:assert/strict';
import { createSecretKey, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { MCP_PRIVATE_INPUT_JOURNAL_LIMITS, McpPrivateInputSchema, mcpPrivateInputCanonicalBytes,
  mcpPrivateInputJournalRequests, mcpPrivateInputRequestsFitJournal, type McpPrivateInput, type JsonValue } from '@dexter/contracts';
import { validateMcpPrivateInputRequests } from '@dexter/connectors';
import { HostStore, canonicalJson } from '@dexter/hub';
import { CapabilityGateway, type AdapterCall } from '@dexter/gateway';
import { AuthorityCoordinator, LocalAuthorityController, OfflineMaintenance, checkFullSchema,
  type SnapshotKey, type OwnerAuthority } from '@dexter/operations';
import { McpPrivateInputCoordinator } from '../packages/cli/src/mcp-private-input.js';
// Enter the source Operations graph through its public index before its intentional exact/full cycle.
await import('../packages/operations/src/index.js');
const { checkHubExact } = await import('../packages/operations/src/exact.js');
const { validateHubMcpJournals, assertMcpCheckpointSafety } = await import('../packages/operations/src/mcp-journals.js');

const shared = JSON.parse(readFileSync(resolve('apps/apple/Tests/DexterHostClientTests/Fixtures/mcp-private-form-r3.json'), 'utf8')) as {
  positive: Array<{name:string;requestJSON:string}>; journalLimits: Record<string,number>;
};
const maximum = JSON.parse(shared.positive.find(item => item.name === 'r7-max-8x64KiB-schema-2048-message-128-id')!.requestJSON) as Record<string,unknown>;
const ordinary = {r1:{method:'elicitation/create',params:{message:'Synthetic preference',requestedSchema:{type:'object',properties:{value:{type:'string'}}}}}};
const encoded = (value:unknown) => canonicalJson(value as JsonValue);
function meta(path:string) {
  const db = new DatabaseSync(path,{readOnly:true});
  try { return db.prepare('SELECT key,value FROM meta ORDER BY key').all().map(row=>({...row})); } finally { db.close(); }
}
function rawInput(path:string,id:string):{text:string;input:McpPrivateInput} {
  const db = new DatabaseSync(path,{readOnly:true});
  try { const text=String(db.prepare('SELECT value FROM meta WHERE key=?').get(`mcp_private_input_v1:${id}`)!.value);return{text,input:JSON.parse(text) as McpPrivateInput}; }
  finally { db.close(); }
}
function checks(store:Pick<HostStore,"databasePath"|"ownerId"|"hostId">,artifact=false) {
  const db=new DatabaseSync(store.databasePath,{readOnly:true});
  try { validateHubMcpJournals(db,{ownerId:store.ownerId,installationId:store.hostId});checkHubExact(db);checkFullSchema(db,'hub');if(artifact)assertMcpCheckpointSafety(db); }
  finally { db.close(); }
}
async function live(t:TestContext,requests:Record<string,unknown>=ordinary,options:{timers?:boolean;oldClock?:boolean;before?:(store:HostStore,call:AdapterCall,coordinator:McpPrivateInputCoordinator)=>void}={}) {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'dx-r7-mrtr-'))),source=join(root,'source');let now=Date.now()-(options.oldClock?300_001:0);
  const store=new HostStore({dataDir:source,clock:()=>now});let coordinator!:McpPrivateInputCoordinator;
  let ready!:()=>void;const entered=new Promise<void>(resolve=>{ready=resolve;});let wait!:Promise<Record<string,unknown>>,call!:AdapterCall;
  let executions=0,effects=0,settlements=0,cleanupCount=()=>0;
  const gateway=new CapabilityGateway({store,broker:{acquire:()=>({headers:{}}),secretValues:()=>[]},adapter:{execute:async(current,_auth,context)=>{
    executions++;call=current;options.before?.(store,call,coordinator);
    // Use the actual registered 300 s coordinator timer; only its clock is virtual. Gateway's original timer
    // was established before entering this adapter. No production timeout or authorization seam is replaced.
    if(options.timers)t.mock.timers.enable({apis:['setTimeout']});
    const added=t.mock.method(context.signal,'addEventListener'),removed=t.mock.method(context.signal,'removeEventListener');
    wait=coordinator.request(call,requests,context.signal);
    const listener=added.mock.calls.find(record=>record.arguments[0]==='abort')!.arguments[1];
    cleanupCount=()=>removed.mock.calls.filter(record=>record.arguments[0]==='abort'&&record.arguments[1]===listener).length;
    void wait.then(()=>{settlements++;},()=>{settlements++;});ready();await wait;effects++;
    return{isError:false,structuredContent:{confirmed:true}};
  }}});
  coordinator=new McpPrivateInputCoordinator(store,()=>gateway);
  t.after(()=>{try{coordinator.close();}catch{}try{gateway.close();}catch{}try{store.close();}catch{}rmSync(root,{recursive:true,force:true});});
  const bot=store.createBot({name:'Synthetic R7 MRTR',profileId:'default',engine:'claude'}),thread=store.createThread(bot.id);
  const turn=store.createTurn(thread.id,{clientRequestId:randomUUID(),content:'Synthetic R7 operation'}).turn;store.claimNextTurn(thread.id);
  gateway.registerTool({name:'fixture.write',toolkit:'fixture',version:'1.0.0',upstreamSlug:'WRITE',upstreamHost:'fixture.example.test',description:'Synthetic',effect:'write',destinationArgument:null,destinationOrigins:null,inputSchema:{type:'object',properties:{},required:[],additionalProperties:false}});
  const connection=gateway.connectAccount({profileId:'default',toolkit:'fixture',label:'Synthetic',upstreamAccountRef:'synthetic',credentialRef:'synthetic',allowedHosts:['fixture.example.test']});
  store.setGrant({botId:bot.id,tool:'fixture.write',destination:connection.id,policy:'allow'});
  const controller=new AbortController(),operation=gateway.call(gateway.issueCapability({turnId:turn.id}).token,{callId:'original',tool:'fixture.write',connectionId:connection.id,arguments:{}},{signal:controller.signal});
  void operation.catch(()=>{});await entered;
  const input=coordinator.list().requests[0]!;assert.ok(input);assert.equal(store.getAction(input.actionId).state,'running');
  return{root,source,store,gateway,coordinator,controller,operation,input,wait,call,turn,bot,
    clock:(value:number)=>{now=value;},executions:()=>executions,effects:()=>effects,settlements:()=>settlements,cleanupCount:()=>cleanupCount()};
}

async function transfer(t:TestContext,source:string,root:string,ownerId:string,generation:number) {
  const {privateKey,publicKey}=generateKeyPairSync('ed25519'),secret=createSecretKey(randomBytes(32));
  const key:SnapshotKey={keyId:`synthetic-r7-${generation}`,use:fn=>fn(secret)},owner:OwnerAuthority={publicKey,sign:bytes=>sign(null,bytes,privateKey)};
  const authority=AuthorityCoordinator.open(join(root,`coordinator-${generation}`),{ownerId,ownerPublicKey:publicKey});t.after(()=>authority.close());
  const maintenance=new OfflineMaintenance(source);t.after(()=>maintenance.close());const controller=new LocalAuthorityController({coordinator:authority}),hold=await controller.quiesce(maintenance);
  const before=meta(hold.store.databasePath),artifact=join(root,`generation-${generation}.dxg8`),destination=join(root,`activated-${generation}`);
  checks(hold.store);const prepared=controller.prepare(hold,{output:artifact,key});assert.deepEqual(meta(hold.store.databasePath),before,'prepare does not rewrite/prune the source journal');
  controller.revokeSource({store:hold.store},prepared.checkpointId,destination);controller.activate({artifact,key,receipt:controller.issueReceipt(owner,prepared.checkpointId)});
  const restored=new HostStore({dataDir:destination});t.after(()=>{try{restored.close();}catch{}});checks(restored,true);return{restored,destination};
}

test('R7 shared canonical UTF-8 budget includes fixed envelope headroom and preserves original JSON escaping',()=>{
  for(const [key,value]of Object.entries(MCP_PRIVATE_INPUT_JOURNAL_LIMITS))assert.equal(shared.journalLimits[key],value,key);
  assert.equal(MCP_PRIVATE_INPUT_JOURNAL_LIMITS.maxBytes,1_048_576);
  assert.equal(mcpPrivateInputCanonicalBytes({b:'\0',a:'é/\"'}),Buffer.byteLength(encoded({b:'\0',a:'é/\"'})));
  const worst={version:1,id:'x'.repeat(128),actionId:'x'.repeat(128),requestHash:'a'.repeat(64),connectionId:'x'.repeat(128),botId:'x'.repeat(128),threadId:'x'.repeat(128),revision:Number.MAX_SAFE_INTEGER,state:'interrupted',requests:{},createdAt:Number.MAX_SAFE_INTEGER,expiresAt:Number.MAX_SAFE_INTEGER,responseHash:'b'.repeat(64),clientRequestId:randomUUID()};
  assert.ok(mcpPrivateInputCanonicalBytes(worst)<MCP_PRIVATE_INPUT_JOURNAL_LIMITS.envelopeBytes);
  const ceiling=MCP_PRIVATE_INPUT_JOURNAL_LIMITS.maxBytes-MCP_PRIVATE_INPUT_JOURNAL_LIMITS.envelopeBytes;
  const exact=structuredClone(ordinary);exact.r1.params.message='';exact.r1.params.message='x'.repeat(ceiling-mcpPrivateInputCanonicalBytes(exact));
  assert.equal(mcpPrivateInputCanonicalBytes(exact),ceiling);assert.equal(mcpPrivateInputRequestsFitJournal(exact),true);
  assert.equal(McpPrivateInputSchema.safeParse({...worst,requests:exact}).success,true,'raw DTO ceiling is inclusive; protocol field limits are separately enforced');
  exact.r1.params.message+='x';assert.equal(mcpPrivateInputCanonicalBytes(exact),ceiling+1);assert.equal(mcpPrivateInputRequestsFitJournal(exact),false);
  assert.equal(McpPrivateInputSchema.safeParse({...worst,requests:exact}).success,false,'DTO cannot admit the byte above its reserved record budget');
});

test('R7 maximum original closed form and historical lead repro are admitted without narrowing; schema+1 and row+1 refuse before journal/key/revision writes',{timeout:30_000},async t=>{
  validateMcpPrivateInputRequests(maximum);
  const first=Object.values(maximum)[0] as {params:{requestedSchema:{properties:Record<string,{description:string}>};message:string}};
  assert.equal(mcpPrivateInputCanonicalBytes(first.params.requestedSchema),65_536);assert.equal(first.params.message.length,2048);assert.equal(Object.keys(maximum).length,8);
  const aboveSchema=structuredClone(maximum) as typeof maximum;
  ((Object.values(aboveSchema)[0] as typeof first).params.requestedSchema.properties.v15!).description+='x';
  assert.equal(mcpPrivateInputCanonicalBytes((Object.values(aboveSchema)[0] as typeof first).params.requestedSchema),65_537);
  const beyond=structuredClone(ordinary);beyond.r1.params.message='\0'.repeat(Math.ceil(MCP_PRIVATE_INPUT_JOURNAL_LIMITS.maxBytes/6));
  assert.ok(mcpPrivateInputCanonicalBytes(beyond)>MCP_PRIVATE_INPUT_JOURNAL_LIMITS.maxBytes);
  const f=await live(t,maximum,{before:(store,call,coordinator)=>{
    const before=meta(store.databasePath),action=store.getAction(call.actionId!);
    for(const hostile of [aboveSchema,beyond]){assert.throws(()=>coordinator.request(call,hostile,new AbortController().signal));assert.deepEqual(meta(store.databasePath),before);assert.deepEqual(store.getAction(call.actionId!),action);}
    const candidate={version:1,id:`mcpform_${randomUUID()}`,actionId:call.actionId!,requestHash:call.requestHash!,connectionId:call.connectionId,botId:call.scope.botId,threadId:call.scope.threadId,revision:1,state:'pending',requests:structuredClone(ordinary),createdAt:store.now(),expiresAt:store.now()+300_000,responseHash:null,clientRequestId:null};
    candidate.requests.r1.params.message='';
    candidate.requests.r1.params.message='x'.repeat(MCP_PRIVATE_INPUT_JOURNAL_LIMITS.maxBytes+1-mcpPrivateInputCanonicalBytes(candidate));
    assert.equal(mcpPrivateInputCanonicalBytes(candidate),MCP_PRIVATE_INPUT_JOURNAL_LIMITS.maxBytes+1,'actual canonical row is exactly one byte above the hard cap');
    assert.throws(()=>coordinator.request(call,candidate.requests,new AbortController().signal));
    assert.throws(()=>store.recordMcpPrivateInput(candidate),{code:'invalid_input'});assert.deepEqual(meta(store.databasePath),before,'store rejects before entering its writer transaction');
  }});
  const recorded=rawInput(f.store.databasePath,f.input.id);assert.ok(Buffer.byteLength(recorded.text)>600_000);assert.ok(Buffer.byteLength(recorded.text)<MCP_PRIVATE_INPUT_JOURNAL_LIMITS.maxBytes);assert.equal(mcpPrivateInputCanonicalBytes(recorded.input),Buffer.byteLength(recorded.text));
  assert.equal(encoded(recorded.input.requests),encoded(mcpPrivateInputJournalRequests(maximum)));checks(f.store);
  const db=new DatabaseSync(f.store.databasePath);try{db.exec('SAVEPOINT oversized');db.prepare('UPDATE meta SET value=? WHERE key=?').run(encoded({...recorded.input,requests:beyond}),`mcp_private_input_v1:${f.input.id}`);assert.throws(()=>checkHubExact(db),{code:'reference_broken'});db.exec('ROLLBACK TO oversized; RELEASE oversized');}finally{db.close();}
  checks(f.store);f.controller.abort();await f.operation.catch(()=>{});assert.equal(f.executions(),1);assert.equal(f.effects(),0);
});

for(const state of ['pending','expired','interrupted'] as const)test(`R7 maximum legitimate ${state} journal survives real backup→revoke→activate→second backup without quarantine or payload rewriting`,{timeout:30_000},async t=>{
  const f=await live(t,maximum,{timers:state==='expired',oldClock:state==='expired'});
  if(state==='expired'){f.clock(Date.now());t.mock.timers.tick(300_000);await f.operation.catch(()=>{});assert.equal(rawInput(f.store.databasePath,f.input.id).input.state,'expired');assert.ok(f.input.expiresAt<Date.now());}
  else if(state==='interrupted'){f.controller.abort();await f.operation.catch(()=>{});assert.equal(rawInput(f.store.databasePath,f.input.id).input.state,'interrupted');}
  const sourceRow=rawInput(f.store.databasePath,f.input.id);assert.equal(sourceRow.input.state,state);
  // Simulate the unchanged v1 bytes left by a legitimate R5/R6 writer, without re-admission or quarantining it.
  const historicalRequests=JSON.parse(shared.positive.find(item=>item.name==='r7-original-large-row-3x15x2000')!.requestJSON) as Record<string,JsonValue>;
  validateMcpPrivateInputRequests(historicalRequests);
  const historical={...sourceRow.input,id:`mcpform_legacy_${state}`,requests:historicalRequests},historyText=encoded(historical);
  assert.ok(Buffer.byteLength(historyText)>65_536);
  const historyDb=new DatabaseSync(f.store.databasePath);try{historyDb.prepare('INSERT INTO meta(key,value)VALUES(?,?)').run(`mcp_private_input_v1:${historical.id}`,historyText);}finally{historyDb.close();}
  checks(f.store);
  // A real pending row was created by the running action, not injected. Closing the writer models process loss;
  // rejection/cleanup cannot rewrite that source row after close. Ordinary restart recovery makes its action unknown.
  f.store.close();f.coordinator.close();await f.operation.catch(()=>{});try{f.gateway.close();}catch{}
  assert.equal(rawInput(f.store.databasePath,f.input.id).text,sourceRow.text);
  const first=await transfer(t,f.source,f.root,f.store.ownerId,1),recovered=rawInput(first.restored.databasePath,f.input.id).input;
  assert.equal(recovered.state,state==='pending'?'interrupted':state);assert.equal(recovered.revision,2);assert.equal(encoded(recovered.requests),encoded(sourceRow.input.requests));
  const recoveredHistory=rawInput(first.restored.databasePath,historical.id).input;
  assert.equal(recoveredHistory.state,state==='pending'?'interrupted':state);assert.equal(recoveredHistory.revision,2);assert.equal(encoded(recoveredHistory.requests),encoded(historical.requests));
  assert.equal(first.restored.mcpPrivateInputList().requests.length,2);
  assert.equal(first.restored.mcpPrivateInputList().quarantinedRequestCount,0);assert.equal(first.restored.mcpPrivateInputList().invalidRequestCount,0);
  assert.equal(first.restored.getAction(f.input.actionId).state,'unknown');assert.equal(f.executions(),1);assert.equal(f.effects(),0);
  const beforeSecond=rawInput(first.restored.databasePath,f.input.id).text,historyBeforeSecond=rawInput(first.restored.databasePath,historical.id).text;first.restored.close();
  const second=await transfer(t,first.destination,f.root,f.store.ownerId,2);assert.equal(rawInput(second.restored.databasePath,f.input.id).text,beforeSecond,'second backup retains the full canonical large row');assert.equal(rawInput(second.restored.databasePath,historical.id).text,historyBeforeSecond,'large historical rows stay canonical and normal through the second generation');checks(second.restored,true);
});

for(const fence of ['checkpointed','revoked','closed'] as const)for(const termination of ['timer','abort','close'] as const)test(`R7 actual ${fence} store: ${termination} rejects its private wait, cleans once, never throws/replays/writes`,{timeout:10_000},async t=>{
  const f=await live(t,ordinary,{timers:termination==='timer'});
  if(fence==='closed')f.store.close();else{const db=new DatabaseSync(f.store.databasePath);try{db.prepare("UPDATE host_authority SET state=?,checkpoint_id='synthetic-checkpoint',revoked_artifact=? WHERE id=1").run(fence,fence==='revoked'?'a'.repeat(64):null);}finally{db.close();}}
  const before=meta(f.store.databasePath),old=rawInput(f.store.databasePath,f.input.id).text;
  assert.doesNotThrow(()=>{if(termination==='timer')t.mock.timers.tick(300_000);else if(termination==='abort')f.controller.abort();else f.coordinator.close();});
  await assert.rejects(f.wait,{code:'input_required',phase:'after_dispatch'});await f.operation.catch(()=>{});
  assert.doesNotThrow(()=>{f.coordinator.close();f.coordinator.close();f.controller.abort();if(termination==='timer')t.mock.timers.tick(600_000);});
  assert.equal(f.settlements(),1);assert.equal(f.cleanupCount(),1);assert.equal(f.executions(),1);assert.equal(f.effects(),0);
  assert.deepEqual(meta(f.store.databasePath),before);assert.equal(rawInput(f.store.databasePath,f.input.id).text,old,'no revision/key/receipt write is possible after fencing');
});
