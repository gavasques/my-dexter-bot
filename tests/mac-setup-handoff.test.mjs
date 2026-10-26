import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { HostServices } from '../packages/cli/dist/host-services.js';
import { HarnessOperationSurface, HARNESS_OPERATION_DESTINATION } from '../packages/cli/dist/harness-operation-surface.js';
import { createHostApp } from '../packages/hub/dist/http.js';
import { APPROVAL_POLICY_SCOPE_VERSION, MAC_SETUP_HANDOFF_TTL_MS, MacSetupHandoffSchema, MacSetupStatusSchema,
  currentMacSetupHandoff } from '../packages/contracts/dist/index.js';

// Synthetic host stores, route metadata and tool views only. No native helper, screen, permission or external service is invoked.
const driver=id=>({id,capabilities:{resume:true,interrupt:true,fork:false,steer:false},status:async()=>({engine:id,installed:true}),
  open:async threadId=>({threadId,nativeCursor:'synthetic'}),async *turn(session,turnId){yield{type:'turn.completed',threadId:session.threadId,turnId,usage:{}};},
  respondToTool:async()=>{},interrupt:async()=>{},close:async()=>{}});
const catalog=async()=>[{id:'codex',available:true,models:[{id:'synthetic',reasoningEfforts:[],speeds:[]}],defaultModel:'synthetic',reasoningEfforts:[],speeds:[]}];
const route=(botId,operation='mac.cua.observe',suffix='own')=>({id:`dvr_${suffix}`,botId,deviceId:`dev_${suffix}`,tool:operation,
  fingerprint:'a'.repeat(64),generation:1,pinRevision:1,schemaHash:'b'.repeat(64),operationVersion:'1',revision:1,status:'active',minimumGrantRevision:1,needsFreshGrant:false});
const view=r=>({name:r.tool,connectionId:r.id,connectionLabel:'Synthetic own Mac',description:'Synthetic published metadata',effect:'read',requiresApproval:true,
  inputSchema:{type:'object',properties:{},required:[],additionalProperties:false}});
function fixture(t,{known=true}={}){
  const root=realpathSync(mkdtempSync('/private/tmp/dexter-mac-setup-handoff-')),surfaces=[],turns=[],counts={network:0,custody:0,baseCalls:0};
  const records={routes:[],views:[],known};let sequence=0;
  const services=new HostServices({dataDir:join(root,'host'),enableEngines:true,enableMcp:true,engineCommands:{codex:'/usr/bin/false'},makeDriver:driver,engineCatalog:catalog,
    nativeMcp:{runsOn:'owner_mac',oauth:{fetch:async()=>{counts.network++;throw Error('No setup network expected');},
      store:{load:async()=>{counts.custody++;return null;},save:async()=>{counts.custody++;},remove:async()=>{counts.custody++;}}}}});
  // Store-only decisions deliberately avoid a different HostServices surface continuing our synthetic route provider.
  const app=createHostApp(services.store,{});
  const makeSurface=()=>{const base={issueCapability:services.gateway.issueCapability.bind(services.gateway),
    revokeCapability:services.gateway.revokeCapability.bind(services.gateway),listTools:token=>[...services.gateway.listTools(token),...records.views],
    call:async()=>{counts.baseCalls++;throw Error('Passive setup must not dispatch base operations');}};
    const surface=new HarnessOperationSurface({store:services.store,base,catalog:services.engineCatalog,runtime:()=>services.runtime,
      skills:()=>services.skillsHttp,effectiveSkills:()=>[],macSetupRoutes:botId=>{records.onRead?.(botId);return records.known?records.routes:undefined;}});surfaces.push(surface);return surface;};
  const bot=()=>services.store.createBot({name:'Synthetic own bot',profileId:'synthetic',engine:'codex'});
  const live=(actor,thread=services.store.createThread(actor.id),surface=makeSurface(),ttlMs)=>{
    const {turn}=services.store.createTurn(thread.id,{clientRequestId:`mac-setup-${++sequence}`,content:'Synthetic Mac setup'});
    services.store.claimNextTurn(thread.id);turns.push(turn);
    return{bot:actor,thread,turn,surface,token:surface.issueCapability({turnId:turn.id,...(ttlMs===undefined?{}:{ttlMs})}).token};};
  const decide=async(receipt,decision='allow')=>{const response=await app.request(`http://127.0.0.1/v1/actions/${receipt.actionId}/decisions`,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({decision,requestHash:receipt.requestHash})});
    assert.equal(response.status,200);return response.json();};
  t.after(async()=>{for(const s of surfaces)await s.close();for(const turn of turns)if(services.store.getTurn(turn.id).state==='running')services.store.finishTurn(turn.id,'completed',null);
    await services.shutdown();rmSync(root,{recursive:true,force:true});});
  return{services,app,counts,records,makeSurface,bot,live,decide};
}
const call=(live,name,callId,args={})=>live.surface.call(live.token,{connectionId:HARNESS_OPERATION_DESTINATION,tool:`dexter.harness.${name}`,callId,arguments:args});
const status=async live=>MacSetupStatusSchema.parse((await call(live,'mac.setup.status','status')).result);
const quiet=f=>assert.deepEqual(f.counts,{network:0,custody:0,baseCalls:0});

for(const mode of ['ask','accept_edits','approve_all','full_access'])test(`Mac setup: ${mode} exact owner approval, deny, receipts and replay have no setup effects`,async t=>{
  const f=fixture(t),actor=f.bot(),live=f.live(actor);
  f.services.store.setBotApprovalPolicy(actor.id,{expectedHostId:f.services.store.hostId,expectedRevision:0,clientRequestId:`mode-${mode}`,mode,eligibleScopeVersion:APPROVAL_POLICY_SCOPE_VERSION});
  const revision=(await status(live)).configurationRevision,args={expected_revision:revision};
  assert.equal(live.surface.listTools(live.token).find(v=>v.name==='dexter.harness.mac.setup.request').requiresApproval,true);
  const denied=await call(live,'mac.setup.request','deny',args);assert.equal(denied.status,'awaiting_approval');quiet(f);await f.decide(denied,'deny');
  assert.equal((await call(live,'mac.setup.request','deny',args)).status,'denied');quiet(f);
  const pending=await call(live,'mac.setup.request','approve',args);assert.equal(pending.status,'awaiting_approval');quiet(f);await f.decide(pending);
  const approved=await call(live,'mac.setup.request','approve',args);assert.equal(approved.status,'succeeded');quiet(f);
  const action=f.services.store.getAction(approved.actionId),receipt=MacSetupHandoffSchema.parse(approved.result);
  assert.equal(action.authorization.source,'exact_owner');assert.equal(action.authorization.ownerId,f.services.store.ownerId);assert.equal(action.decidedBy,f.services.store.ownerId);
  assert.deepEqual(Object.keys(receipt).sort(),['kind','target','hostId','botId','threadId','actionId','requestHash','configurationRevision','expiresAt'].sort());
  assert.equal(receipt.target,'computer_access');assert.equal(receipt.hostId,f.services.store.hostId);assert.equal(receipt.botId,actor.id);
  assert.equal(receipt.threadId,live.thread.id);assert.equal(receipt.actionId,action.id);assert.equal(receipt.requestHash,action.requestHash);
  assert.equal(receipt.configurationRevision,revision);assert.ok(receipt.expiresAt>action.updatedAt && receipt.expiresAt<=action.updatedAt+MAC_SETUP_HANDOFF_TTL_MS);
  assert.ok(currentMacSetupHandoff(receipt,action.updatedAt));assert.equal(currentMacSetupHandoff(receipt,receipt.expiresAt),null);
  assert.deepEqual((await call(live,'mac.setup.request','approve',args)).result,receipt);
  assert.deepEqual((await call(live,'actions.read','receipt',{action_id:action.id})).result.result,receipt);
  assert.deepEqual(f.services.store.summary().counts.devices,{online:0,stale:0,revoked:0});assert.deepEqual(f.records.routes,[]);quiet(f);
});

test('Mac setup: legacy Allow still asks exactly; Deny and expiry block without changing their grants',async t=>{
  const f=fixture(t),actor=f.bot(),live=f.live(actor),args={expected_revision:(await status(live)).configurationRevision};
  f.services.store.setGrant({botId:actor.id,tool:'dexter.harness.mac.setup.request',destination:HARNESS_OPERATION_DESTINATION,policy:'allow'});
  const grant=f.services.store.getGrant(actor.id,'dexter.harness.mac.setup.request',HARNESS_OPERATION_DESTINATION);
  assert.equal(live.surface.listTools(live.token).find(v=>v.name==='dexter.harness.mac.setup.request').requiresApproval,true);
  const pending=await call(live,'mac.setup.request','legacy',args);assert.equal(pending.status,'awaiting_approval');await f.decide(pending);
  assert.equal((await call(live,'mac.setup.request','legacy',args)).status,'succeeded');
  assert.deepEqual(f.services.store.getGrant(actor.id,'dexter.harness.mac.setup.request',HARNESS_OPERATION_DESTINATION),grant);
  for(const policy of ['deny','ask']){
    f.services.store.setGrant({botId:actor.id,tool:'dexter.harness.mac.setup.request',destination:HARNESS_OPERATION_DESTINATION,policy,...(policy==='ask'?{expiresAt:Date.now()-1}:{})});
    assert.ok(!live.surface.listTools(live.token).some(v=>v.name==='dexter.harness.mac.setup.request'));
    await assert.rejects(call(live,'mac.setup.request',policy,args),e=>e.code==='forbidden');
  }quiet(f);
});

test('Mac setup: unknown composition, closed status projection and strict foreign-field refusal are passive',async t=>{
  const f=fixture(t,{known:false}),live=f.live(f.bot()),before=f.services.store.summary().counts,read=await status(live);
  assert.equal(read.routeConfiguration,'unknown');assert.ok(read.operations.every(op=>op.grantValidity==='unknown' && !op.published && !op.turnAdmitted));
  for(const field of ['nativeTCC','helper','localPolicy','session','readiness'])assert.equal(read[field],'unknown');
  assert.deepEqual(f.services.store.summary().counts,before);
  for(const extra of [{botId:'other'},{hostId:'other'},{threadId:'other'},{deviceId:'device'},{url:'https://example.invalid'},{modelPath:'/private/path'},{permissions:['screen']},{origin:{ownerId:'other'}},{target:'other'}]){
    await assert.rejects(call(live,'mac.setup.status',`status-${Object.keys(extra)[0]}`,extra),e=>e.code==='invalid_input');
    await assert.rejects(call(live,'mac.setup.request',`request-${Object.keys(extra)[0]}`,{expected_revision:read.configurationRevision,...extra}),e=>e.code==='invalid_input');
  }
  for(const expected_revision of [undefined,0,'A'.repeat(64),'0'.repeat(63),'g'.repeat(64)])
    await assert.rejects(call(live,'mac.setup.request',`invalid-${String(expected_revision)}`,expected_revision===undefined?{}:{expected_revision}),e=>e.code==='invalid_input');
  assert.deepEqual(f.services.store.summary().counts,before);quiet(f);
});

test('Mac setup: own routes only, live grant metadata and frozen turn admission do not change configuration CAS',async t=>{
  const f=fixture(t),actor=f.bot(),foreign=f.bot(),own=route(actor.id),other=route(foreign.id,'mac.cua.control','foreign');
  f.records.routes=[own,other];f.records.views=[view(own),view(other)];
  const live=f.live(actor),before=await status(live),operation=before.operations.find(op=>op.operation===own.tool);
  assert.equal(operation.published,true);assert.equal(operation.turnAdmitted,true);assert.equal(operation.grantValidity,'missing');
  assert.equal(before.operations.find(op=>op.operation===other.tool).published,false);
  const serialized=JSON.stringify(before);for(const privateValue of [own.deviceId,own.id,other.deviceId,other.id,own.fingerprint,own.schemaHash])assert.ok(!serialized.includes(privateValue));
  other.revision++;other.fingerprint='c'.repeat(64);assert.equal((await status(live)).configurationRevision,before.configurationRevision);
  f.services.store.setGrant({botId:actor.id,tool:own.tool,destination:own.deviceId,policy:'ask'});
  assert.equal((await status(live)).operations.find(op=>op.operation===own.tool).grantValidity,'valid');
  f.services.store.setGrant({botId:actor.id,tool:own.tool,destination:own.deviceId,policy:'ask',expiresAt:Date.now()-1});
  assert.equal((await status(live)).operations.find(op=>op.operation===own.tool).grantValidity,'expired');
  f.services.store.setGrant({botId:actor.id,tool:own.tool,destination:own.deviceId,policy:'deny'});
  assert.equal((await status(live)).operations.find(op=>op.operation===own.tool).grantValidity,'denied');
  assert.equal((await status(live)).configurationRevision,before.configurationRevision);
  const added=route(actor.id,'mac.cua.control','added');f.records.routes.push(added);f.records.views.push(view(added));
  const after=await status(live);assert.notEqual(after.configurationRevision,before.configurationRevision);
  assert.equal(after.operations.find(op=>op.operation===added.tool).published,true);assert.equal(after.operations.find(op=>op.operation===added.tool).turnAdmitted,false);
  f.records.views=[];assert.equal((await status(live)).operations.find(op=>op.operation===own.tool).turnAdmitted,false);quiet(f);
});

test('Mac setup: configuration changes after ready preflight refuse execution and create no handoff result',async t=>{
  const f=fixture(t),actor=f.bot(),own=route(actor.id);f.records.routes=[own];const live=f.live(actor);
  const args={expected_revision:(await status(live)).configurationRevision},pending=await call(live,'mac.setup.request','dispatch-race',args);
  await f.decide(pending);let reads=0;f.records.onRead=()=>{if(++reads===2)own.pinRevision++;};
  const result=await call(live,'mac.setup.request','dispatch-race',args);assert.equal(result.status,'unknown');
  assert.equal(MacSetupHandoffSchema.safeParse(result.result).success,false);
  assert.deepEqual(await call(live,'mac.setup.request','dispatch-race',args),result,'unknown dispatcher receipt is durable and cannot re-execute');quiet(f);
});

test('Mac setup: route CAS conflicts before proposal and blocks changes between approval and execution',async t=>{
  const f=fixture(t),actor=f.bot(),own=route(actor.id);f.records.routes=[own];const live=f.live(actor),revision=(await status(live)).configurationRevision;
  await assert.rejects(call(live,'mac.setup.request','stale',{expected_revision:'0'.repeat(64)}),e=>e.code==='conflict');
  assert.equal(f.services.store.listActions().length,0);
  const pending=await call(live,'mac.setup.request','raced',{expected_revision:revision});own.generation++;await f.decide(pending);
  assert.equal((await call(live,'mac.setup.request','raced',{expected_revision:revision})).status,'blocked');
  own.generation--;const current=(await status(live)).configurationRevision,p2=await call(live,'mac.setup.request','removed',{expected_revision:current});
  f.records.routes=[];await f.decide(p2);assert.equal((await call(live,'mac.setup.request','removed',{expected_revision:current})).status,'blocked');
  f.records.routes=[{...own,id:'dvr_recreated',revision:1}];assert.notEqual((await status(live)).configurationRevision,current);
  const p3=await call(live,'mac.setup.request','composition',{expected_revision:(await status(live)).configurationRevision});
  f.records.known=false;await f.decide(p3);assert.equal((await call(live,'mac.setup.request','composition',{expected_revision:f.services.store.getAction(p3.actionId).request.arguments.input.expected_revision})).status,'blocked');quiet(f);
});

test('Mac setup: durable replay preserves expired TTL and conflicts on changed call; foreign receipt and expired capability refuse',async t=>{
  const f=fixture(t),actor=f.bot(),live=f.live(actor),args={expected_revision:(await status(live)).configurationRevision};
  const pending=await call(live,'mac.setup.request','durable',args);await f.decide(pending);const approved=await call(live,'mac.setup.request','durable',args);
  await assert.rejects(call(live,'mac.setup.request','durable',{expected_revision:'0'.repeat(64)}),e=>e.code==='conflict');
  await assert.rejects(call(f.live(f.bot()),'actions.read','foreign',{action_id:approved.actionId}),e=>e.code==='forbidden');
  await assert.rejects(call(f.live(actor),'actions.read','other-thread',{action_id:approved.actionId}),e=>e.code==='forbidden');
  const replacement=f.makeSurface(),newToken=replacement.issueCapability({turnId:live.turn.id}).token,continued={...live,surface:replacement,token:newToken};
  assert.deepEqual((await call(continued,'mac.setup.request','durable',args)).result,approved.result);
  const originalNow=f.services.store.now.bind(f.services.store);f.services.store.now=()=>approved.result.expiresAt+1;
  assert.equal((await status(continued)).configurationRevision,args.expected_revision,'clock is not part of configuration CAS');
  assert.equal(currentMacSetupHandoff(approved.result,f.services.store.now()),null);
  assert.deepEqual((await call(continued,'mac.setup.request','durable',args)).result,approved.result,'expired receipt is never renewed by replay');
  f.services.store.now=originalNow;
  // Let the capability/catalog assemble before expiring it; a 1ms TTL can fail during issueCapability itself.
  const expiring=f.live(f.bot(),undefined,undefined,250);await new Promise(resolve=>setTimeout(resolve,300));
  await assert.rejects(call(expiring,'mac.setup.status','expired'),e=>e.code==='unauthorized');quiet(f);
});

test('Mac setup: owner continuation after the proposing turn finishes issues only the navigation receipt',async t=>{
  const f=fixture(t),live=f.live(f.bot()),args={expected_revision:(await status(live)).configurationRevision},pending=await call(live,'mac.setup.request','closed-turn',args);
  f.services.store.finishTurn(live.turn.id,'completed',null);await f.decide(pending);
  const action=await live.surface.continueOwnerAction(f.services.store.getAction(pending.actionId));assert.equal(action.state,'succeeded');
  assert.equal(MacSetupHandoffSchema.parse(action.result).threadId,live.thread.id);assert.deepEqual(f.services.store.summary().counts.devices,{online:0,stale:0,revoked:0});quiet(f);
});
