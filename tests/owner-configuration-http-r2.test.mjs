import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { HostServices } from '../packages/cli/dist/host-services.js';
import { createHostApp, createAuthorizedHostRouter } from '../packages/hub/dist/http.js';
import { canonicalJson } from '../packages/hub/dist/index.js';
import { checkMcpDefinition, planMcpTools } from '../packages/connectors/dist/index.js';
import { toolDefinitionHash } from '../packages/connectors/dist/mcp/session.js';

const hash=value=>createHash('sha256').update(value).digest('hex');
async function until(read,predicate){const deadline=Date.now()+4000;for(;;){const value=read();if(predicate(value))return value;if(Date.now()>=deadline)throw Error('Synthetic candidate did not settle');await new Promise(resolve=>setTimeout(resolve,10));}}
function fixture(t,{native=false,memoryRoutines}={}){
  const root=realpathSync(mkdtempSync('/private/tmp/owner-configuration-r2-')),dataDir=join(root,'host');let services,app,driverCalls=0;
  const makeDriver=id=>({id,capabilities:{resume:true,interrupt:true,fork:false,steer:false},status:async()=>({engine:id,installed:true,authentication:'unverified',billing:'unknown'}),
    open:async threadId=>({threadId,nativeCursor:'synthetic-owner-source'}),async *turn(session,turnId){driverCalls++;yield{type:'text.delta',threadId:session.threadId,turnId,text:'A literal assistant excerpt suggested for human review. It is quoted context, never a fact or instruction.'};yield{type:'turn.completed',threadId:session.threadId,turnId,usage:{}};},respondToTool:async()=>{},interrupt:async()=>{},close:async()=>{}});
  const open=()=>{
    services=new HostServices({dataDir,enableEngines:true,enableMcp:true,engineCommands:{codex:'/usr/bin/false'},makeDriver,
      engineCatalog:()=>[{id:'codex',available:true,defaultModel:'synthetic',models:[{id:'synthetic',reasoningEfforts:[],speeds:[]}],reasoningEfforts:[],speeds:[]}],
      ...(native?{nativeMcp:{runsOn:'owner_mac',oauth:false}}:{}),...(memoryRoutines===undefined?{}:{memoryRoutines})});
    app=createHostApp(services.store,{runtime:services.runtime,botDocuments:services.botDocumentsHttp,ownerConfiguration:services.ownerConfigurationHttp,
      ...(services.nativeMcpHttp?{mcp:services.nativeMcpHttp}:{})});
  };
  open();t.after(async()=>{await services.shutdown();rmSync(root,{recursive:true,force:true});});
  const call=async(path,body)=>{const response=await app.request('http://127.0.0.1'+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,body:await response.json()};};
  const session=async(bot,windowID=randomUUID())=>{
    const reply=await call('/v1/bots/'+bot.id+'/configuration-session',{expectedHostID:services.store.hostId,expectedOwnerID:services.store.ownerId,expectedBotRevision:bot.revision,windowID});
    assert.equal(reply.status,201);return{...reply.body,path:'/v1/owner-configuration/sessions/'+reply.body.sessionID};
  };
  const decide=(action,decision='allow')=>call('/v1/actions/'+action.id+'/decisions',{requestHash:action.requestHash,decision});
  return{root,dataDir,call,session,decide,reopen:async()=>{await services.shutdown();open();},get services(){return services;},get driverCalls(){return driverCalls;}};
}

test('owner window HTTP: real policy/capture/maintenance lineage, exact decisions, stale base and changed-body refusal, original receipt replay',async t=>{
  const f=fixture(t),bot=f.services.store.createBot({name:'Synthetic owner window',engine:'codex',profileId:'owner-window-profile'}),s=await f.session(bot);
  const policy=(await f.call(s.path+'/memory/policy')).body;
  assert.equal(policy.policy.revision,0);assert.equal(policy.policy.enabled,false);assert.equal(policy.extractor,'literal_excerpt');assert.equal(policy.semanticExtractor,'unconfigured');assert.equal(policy.automaticMemoryWrites,false);
  const input={expectedRevision:0,enabled:true,maintenanceEnabled:true,minIntervalMs:60000,maxNotesPerDay:4,maxNoteCharacters:128};
  const before=f.services.store.summary();
  assert.equal((await f.call(s.path+'/memory/policy/proposals',{clientRequestId:'stale-policy',input:{...input,expectedRevision:1}})).status,409);
  assert.equal(f.services.store.listActions().length,0);assert.deepEqual(f.services.store.summary(),before);
  const request={clientRequestId:'enable-policy',input},pending=await f.call(s.path+'/memory/policy/proposals',request);
  assert.equal(pending.status,201);assert.equal(pending.body.state,'awaiting_approval');assert.equal(f.driverCalls,0);
  const origin=f.services.store.toolActionOrigin(pending.body.id),turn=f.services.store.getTurn(origin.turnId);
  assert.equal(turn.state,'completed');assert.equal(turn.outputMessageId,null);assert.equal(turn.outputChars,0);
  assert.equal(f.services.store.ownerSettingsIntent(turn.id).bodyHash,hash(canonicalJson({operation:'memory.policy.update',input})));
  assert.equal(f.services.store.createActionResultTurn(pending.body.id),null);
  assert.equal((await f.call(s.path+'/memory/policy/proposals',request)).body.id,pending.body.id);
  assert.equal((await f.call(s.path+'/memory/policy/proposals',{clientRequestId:request.clientRequestId,input:{...input,maxNoteCharacters:64}})).status,409);
  const recovered=(await f.call(s.path+'/requests/enable-policy')).body;
  assert.equal(recovered.action.id,pending.body.id);assert.equal(recovered.intent.windowId,s.windowID);
  const foreign=await f.session(bot);
  assert.equal((await f.call(foreign.path+'/memory/policy/receipts/'+pending.body.id)).status,403);
  assert.equal((await f.call('/v1/actions/'+pending.body.id+'/decisions',{requestHash:'0'.repeat(64),decision:'allow'})).status,409);
  assert.equal((await f.decide(pending.body)).body.state,'succeeded');assert.equal(f.driverCalls,0);
  const policyReceipt=(await f.call(s.path+'/memory/policy/receipts/'+pending.body.id)).body;
  assert.equal(policyReceipt.policyReceipt.policy.revision,1);assert.equal(policyReceipt.action.authorization.source,'exact_owner');
  assert.equal(f.services.botDocumentsHttp.read(bot.id).revision,0);
  // A genuinely completed synthetic source turn drives the first-party literal extractor, not the owner proposal turn.
  const thread=f.services.store.createThread(bot.id),source=f.services.runtime.startTurn(thread.id,{clientRequestId:'real-source-input',content:'Synthetic owner asks for a response'}).turn;
  assert.equal((await f.services.runtime.waitForTurn(source.id,4000)).state,'completed');
  const job=await until(()=>f.services.context.memoryRoutines.jobs(bot.id)[0],value=>value?.state==='candidate');
  assert.equal(job.source.turnId,source.id);assert.equal(job.source.role,'assistant');assert.ok(job.note.length<=128);assert.equal(f.driverCalls,1);
  const captureBody={clientRequestId:'review-capture',jobId:job.id},capture=await f.call(s.path+'/memory/capture/proposals',captureBody);
  assert.equal(capture.status,201);assert.equal(capture.body.request.tool,'dexter.harness.memory.append');
  assert.equal((await f.call(s.path+'/memory/capture/proposals',captureBody)).body.id,capture.body.id);
  assert.equal((await f.call(s.path+'/requests/review-capture')).body.action.id,capture.body.id);
  assert.equal((await f.decide(capture.body)).body.state,'succeeded');assert.equal(f.services.botDocumentsHttp.read(bot.id).memory,job.note);
  const docs=f.services.botDocumentsHttp.read(bot.id);
  f.services.botDocumentsHttp.compareAndSet(bot.id,{expectedRevision:docs.revision,soul:docs.soul,user:docs.user,memory:'Literal repeated block\n\nLiteral repeated block',clientRequestId:'synthetic-human-edit'});
  const preview=(await f.call(s.path+'/memory/maintenance-preview')).body;
  assert.equal(preview.removed.length,1);
  const stale={clientRequestId:'stale-maintenance',input:{expectedRevision:preview.expectedRevision,memoryHash:preview.memoryHash,nextMemoryHash:preview.nextMemoryHash}};
  const current=f.services.botDocumentsHttp.read(bot.id);
  f.services.botDocumentsHttp.compareAndSet(bot.id,{expectedRevision:current.revision,soul:current.soul,user:current.user,memory:'Human replacement wins',clientRequestId:'synthetic-later-human-edit'});
  assert.equal((await f.call(s.path+'/memory/maintenance/proposals',stale)).status,409);assert.equal(f.services.botDocumentsHttp.read(bot.id).memory,'Human replacement wins');
  assert.equal(f.driverCalls,1);
  const paired=createAuthorizedHostRouter(f.services.store);
  assert.equal((await paired.request('http://localhost/v1/bots/'+bot.id+'/configuration-session',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,404);
});

test('owner window HTTP: consolidated native MCP plan is scoped, pinned, stale-safe and replay preserves original effect without new grants',async t=>{
  const f=fixture(t,{native:true,memoryRoutines:{}}),bot=f.services.store.createBot({name:'Synthetic native owner',engine:'codex',profileId:'owner-native-profile'});
  const definition={id:'synthetic-gmail',name:'Synthetic repeated endpoint',auth:'none',runsOn:'any',transport:{type:'streamable_http',url:'https://synthetic.invalid/mcp'}};
  f.services.nativeMcpAdmin.addServerWithReceipt({requestId:'synthetic-register',expectedInstancePin:null,definition},{installationId:f.services.store.hostId,ownerId:f.services.store.ownerId,origin:{kind:'owner_local'}});
  const tool={name:'echo_text',description:'Synthetic tool',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false},annotations:{}};
  const plans=planMcpTools(checkMcpDefinition(definition),[{...tool,definitionHash:toolDefinitionHash(tool)}]),db=new DatabaseSync(join(f.dataDir,'native-mcp.sqlite'));
  try{f.services.store.withWriterLease(()=>{db.prepare('INSERT INTO catalogs VALUES(?,?)').run(definition.id,JSON.stringify(plans.map(p=>({id:p.manifest.name,mcpName:p.mcpName,description:p.manifest.description,effect:p.manifest.effect,state:p.status,manifest:p.manifest,argumentNames:p.argumentNames}))));db.prepare("UPDATE servers SET status='ready' WHERE id=?").run(definition.id);});}finally{db.close();}
  await f.reopen();f.services.nativeMcpAdmin.setBotSelection(definition.id,bot.id,{toolIds:[],policy:'ask'});
  const s=await f.session(f.services.store.getBot(bot.id)),review=(await f.call(s.path+'/mcp/selection')).body;
  assert.equal(review.instances.length,1);assert.equal((await f.call(s.path+'/memory/policy')).body.extractor,'unconfigured');
  const catalog=(await f.call(s.path+'/mcp/catalog/'+definition.id)).body;assert.equal(catalog.tools.length,1);
  const input={mode:'explicit',expectedRevision:review.revision,expectedInventoryPin:review.inventoryPin,expectedSelectionPin:review.selectionPin,instances:[{serverId:definition.id,toolIds:[catalog.tools[0].id]}]};
  const plan=(await f.call(s.path+'/mcp/plan',input)).body;assert.equal(plan.targets[0].generation,review.instances[0].generation);
  const request={clientRequestId:'native-selection',plan},pending=await f.call(s.path+'/mcp/proposals',request);
  assert.equal(pending.status,201);assert.equal(pending.body.state,'awaiting_approval');assert.equal((await f.call(s.path+'/mcp/receipts/'+pending.body.id)).body.selection,null);
  const action=(await f.decide(pending.body)).body;assert.equal(action.state,'succeeded');assert.equal(f.driverCalls,0);
  const receipt=(await f.call(s.path+'/mcp/receipts/'+action.id)).body;
  assert.equal(receipt.selection.receipt.phase,'completed');assert.equal(receipt.selection.authenticationVerified,false);
  const grant=f.services.store.getGrant(bot.id,catalog.tools[0].id,plan.targets[0].connectionId);assert.equal(grant.policy,'ask');
  assert.equal((await f.call(s.path+'/mcp/proposals',request)).body.id,action.id);
  assert.deepEqual(f.services.store.getGrant(bot.id,catalog.tools[0].id,plan.targets[0].connectionId),grant);
  assert.equal((await f.call(s.path+'/mcp/proposals',{clientRequestId:'stale-old-plan',plan})).status,409);
  assert.equal((await f.call(s.path+'/requests/native-selection')).body.action.id,action.id);
  const savedReceipt=receipt.selection.receipt,windowID=s.windowID;
  await f.reopen();const restored=await f.session(f.services.store.getBot(bot.id),windowID);
  assert.equal((await f.call(s.path+'/requests/native-selection')).status,403);
  const observed=(await f.call(restored.path+'/mcp/receipts/'+action.id)).body;
  assert.deepEqual(observed.selection.receipt,savedReceipt);assert.equal(observed.selection.grantsReplayed,false);assert.equal(f.driverCalls,0);
});
