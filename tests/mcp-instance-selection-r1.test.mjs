import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSecretKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { test } from 'node:test';
import { HostStore } from '@dexter/hub';
import { CapabilityGateway } from '@dexter/gateway';
import { NativeMcpRuntime, checkMcpDefinition, planMcpTools } from '@dexter/connectors';
import { toolDefinitionHash } from '../packages/connectors/dist/mcp/session.js';
import { mcpSetupHash, mcpSetupCanonicalJSON } from '../packages/connectors/dist/mcp/setup-receipts.js';
import { HarnessOperationSurface, HARNESS_OPERATION_DESTINATION } from '../packages/cli/dist/harness-operation-surface.js';
import { APPROVAL_POLICY_SCOPE_VERSION } from '@dexter/contracts';
import { AuthorityCoordinator, LocalAuthorityController, openCheckpointArtifact } from '@dexter/operations';
import { FULL_SCHEMAS, nativeMcpSchemaLabel } from '../packages/operations/dist/full-schemas.js';
import { validateNativeMcp } from '../packages/operations/dist/native-mcp.js';
import { decodeCheckpointManifest } from '../packages/operations/dist/checkpoint.js';
import { resolveLimits } from '../packages/operations/dist/manifest.js';
const def=id=>({id,name:'Same synthetic Gmail label',auth:'broker',runsOn:'any',transport:{type:'streamable_http',url:'https://gmail.synthetic.invalid/mcp',headers:{authorization:{kind:'secret',key:'token',prefix:'Bearer '}}}});
const syntheticTool={name:'echo_text',description:'Synthetic public tool',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false},annotations:{}};
const discovery=[{...syntheticTool,definitionHash:toolDefinitionHash(syntheticTool)}];
const dbRows=(path,sql)=>{const db=new DatabaseSync(path,{readOnly:true});try{return db.prepare(sql).all();}finally{db.close();}};
async function fixture(t,legacy2=false){
 const root=mkdtempSync(join(tmpdir(),'mcp-instance-selection-synthetic-')),dir=join(root,'host');let store=new HostStore({dataDir:dir}),runtime,gateway,surfaces=[],turns=[],sequence=0,failGrant=0,grantCalls=0,lose=false;
 const quiet={fetch:0,custody:0,load:0,save:0,remove:0};
 const watch=()=>{const original=store.setGrant.bind(store);store.setGrant=input=>{if(input.tool.startsWith('mcp.')){grantCalls++;if(failGrant&&grantCalls===failGrant)throw Error('synthetic grant interruption');}return original(input);};};watch();
 if(legacy2){const db=new DatabaseSync(join(dir,'native-mcp.sqlite'));try{db.exec(FULL_SCHEMAS.nativeMcp.sql);for(const [k,v]of[['schema','2'],['installation',store.hostId],['owner',store.ownerId]])db.prepare('INSERT INTO meta VALUES(?,?)').run(k,v);}finally{db.close();}}
 const open=()=>{
  runtime=new NativeMcpRuntime({host:{runsOn:'owner_mac',stdioRoot:join(root,'never-started'),fetch:async()=>{quiet.fetch++;throw Error('forbidden synthetic network');}},
   credentials:{custody:{kind:'synthetic',read:async()=>{quiet.custody++;throw Error('forbidden synthetic custody');}}},
   oauth:{store:{load:async()=>{quiet.load++;throw Error('forbidden token load');},save:async()=>{quiet.save++;throw Error('forbidden token save');},remove:async()=>{quiet.remove++;throw Error('forbidden token remove');}}}});
  gateway=new CapabilityGateway({store,broker:runtime.broker,adapter:runtime.adapter});runtime.bind(store,gateway);
 };
 const closeRuntime=async()=>{if(runtime)await runtime.close();if(gateway)gateway.close();runtime=undefined;gateway=undefined;};
 const close=async()=>{for(const s of surfaces)await s.close();surfaces=[];for(const turn of turns){const live=store.getTurn(turn.id);if(live.state==='running')store.finishTurn(turn.id,'completed',null);}turns=[];await closeRuntime();};
 const restart=async()=>{await close();store.close();store=new HostStore({dataDir:dir});watch();open();};
 open();let upgradeCounts;
 if(legacy2){const n=new DatabaseSync(join(dir,'native-mcp.sqlite'),{readOnly:true}),h=new DatabaseSync(store.databasePath,{readOnly:true});try{upgradeCounts=validateNativeMcp(n,h);}finally{n.close();h.close();}}
 t.after(async()=>{await close();store.close();rmSync(root,{recursive:true,force:true});});
 const path=join(dir,'native-mcp.sqlite');
 const bots=[store.createBot({name:'A',engine:'codex',profileId:'same-profile'}),store.createBot({name:'B',engine:'codex',profileId:'same-profile'}),store.createBot({name:'C',engine:'codex',profileId:'same-profile'})];
 const owner={installationId:store.hostId,ownerId:store.ownerId,origin:{kind:'owner_local'}};
 for(let i=1;i<=6;i++)runtime.admin.addServerWithReceipt({requestId:'register-'+i,expectedInstancePin:null,definition:def('gmail-'+i)},owner);
 // Seed reviewed catalogs in owned SQLite from the ACTUAL first-party pure planner. No transport/custody/discovery call.
 const seed=new DatabaseSync(path);try{store.withWriterLease(()=>{for(let i=1;i<=6;i++){
  const definition=checkMcpDefinition(def('gmail-'+i)),plans=planMcpTools(definition,discovery);
  assert.equal(plans[0].status,'publishable');
  const tools=plans.map(p=>({id:p.manifest.name,mcpName:p.mcpName,description:p.manifest.description,effect:p.manifest.effect,state:p.status,manifest:p.manifest,argumentNames:p.argumentNames}));
  seed.prepare('INSERT INTO catalogs VALUES(?,?)').run(definition.id,JSON.stringify(tools));seed.prepare("UPDATE servers SET status='ready' WHERE id=?").run(definition.id);
 }});}finally{seed.close();}
 await closeRuntime();open();
 for(let i=1;i<=5;i++)runtime.admin.setBotSelection('gmail-'+i,bots[0].id,{toolIds:[],policy:'ask'});
 const live=(bot,thread=store.createThread(bot.id))=>{
  const {turn}=store.createTurn(thread.id,{clientRequestId:'turn-'+(++sequence),content:'Synthetic instance selection'});store.claimNextTurn(thread.id);turns.push(turn);
  const surface=new HarnessOperationSurface({store,base:gateway,catalog:async()=>[],runtime:()=>undefined,skills:()=>undefined,effectiveSkills:()=>[],mcp:()=>{
   const own=runtime.admin;return {...own,applyInstanceSelection:id=>{const result=own.applyInstanceSelection(id);if(lose){lose=false;throw Error('synthetic completed receipt ACK lost');}return result;}};
  }});surfaces.push(surface);return{bot,thread,turn,surface,token:surface.issueCapability({turnId:turn.id}).token};
 };
 const call=(l,name,id,args={})=>l.surface.call(l.token,{connectionId:HARNESS_OPERATION_DESTINATION,tool:'dexter.harness.'+name,callId:id,arguments:args});
 const plan=async(l,ids,mode='explicit')=>{const r=(await call(l,'mcp.instance_selection','review-'+(++sequence))).result;
  const input={mode,expectedInventoryPin:r.inventoryPin,expectedSelectionPin:r.selectionPin,expectedRevision:r.revision,instances:ids.map(serverId=>({serverId,toolIds:['mcp.'+serverId+'.echo_text']}))};
  return (await call(l,'mcp.instance_selection_plan','plan-'+(++sequence),{selection_json:JSON.stringify(input)})).result;};
 const propose=(l,p,id)=>call(l,'mcp.select_instances',id,{plan_json:JSON.stringify(p)});
 const allow=async(l,p,id)=>{const pending=await propose(l,p,id);assert.equal(pending.status,'awaiting_approval');store.decideAction(pending.actionId,{decision:'allow',requestHash:pending.requestHash});return propose(l,p,id);};
 return{root,dir,path,bots,live,call,plan,propose,allow,restart,close,closeRuntime,open,upgradeCounts,get store(){return store;},get admin(){return runtime.admin;},get gateway(){return gateway;},get grantCalls(){return grantCalls;},failAt:n=>{failGrant=n;},lose:()=>{lose=true;},quiet};
}
function noPrivate(f){assert.deepEqual(f.quiet,{fetch:0,custody:0,load:0,save:0,remove:0});}

test('3B: five repeated endpoints, A1/B2,3/Csnapshot-all; exact approval, future6 excluded, replay and destination-only deselection',async t=>{
 const f=await fixture(t),[a,b,c]=f.bots,la=f.live(a),lb=f.live(b),lc=f.live(c);
 f.store.setBotApprovalPolicy(c.id,{expectedHostId:f.store.hostId,expectedRevision:0,clientRequestId:'approve-all-does-not-select',mode:'approve_all',eligibleScopeVersion:APPROVAL_POLICY_SCOPE_VERSION});
 const connections=f.gateway.registry.listConnections(a.profileId);assert.equal(connections.length,5);assert.equal(new Set(connections.map(x=>x.credentialRef)).size,5);assert.equal(new Set(connections.map(x=>x.upstreamAccountRef)).size,5);
 assert.equal(new Set(f.admin.listServers().map(s=>s.destination)).size,1);
 const pa=await f.plan(la,['gmail-1']),pb=await f.plan(lb,['gmail-2','gmail-3']),pc=await f.plan(lc,['gmail-1','gmail-2','gmail-3','gmail-4','gmail-5'],'all_connected');
 const deny=await f.propose(la,pa,'deny');f.store.decideAction(deny.actionId,{decision:'deny',requestHash:deny.requestHash});assert.equal(f.grantCalls,0);
 const ca=await f.allow(la,pa,'a'),cb=await f.allow(lb,pb,'b'),cc=await f.allow(lc,pc,'c');for(const x of[ca,cb,cc])assert.equal(x.status,'succeeded');
 assert.deepEqual(f.admin.instanceSelectionReview(a.id).selected.map(x=>x.serverId),['gmail-1']);assert.deepEqual(f.admin.instanceSelectionReview(b.id).selected.map(x=>x.serverId),['gmail-2','gmail-3']);
 assert.equal(cc.result.receipt.plan.targets.length,5);assert.equal(cc.result.authenticationVerified,false);assert.equal(f.grantCalls,8);
 assert.equal(lc.surface.listTools(lc.token).filter(x=>x.name.startsWith('mcp.')).length,0,'new tools are admitted next turn');
 const revisions=connections.map(x=>f.store.getGrant(c.id,'mcp.'+x.toolkit.slice(4)+'.echo_text',x.id)?.revision);
 f.admin.setBotSelection('gmail-6',a.id,{toolIds:[],policy:'ask'});assert.equal(f.admin.instanceSelectionReview(c.id).instances.length,6);
 const receipt=f.admin.applyInstanceSelection(cc.actionId);assert.equal(receipt.replayed,true);assert.equal(receipt.grantsReplayed,false);assert.equal(receipt.receipt.plan.targets.length,5);assert.equal(f.grantCalls,8);
 assert.equal(f.store.getGrant(c.id,'mcp.gmail-6.echo_text',f.gateway.registry.listConnections().find(x=>x.toolkit==='mcp-gmail-6').id),null);
 assert.deepEqual(connections.map(x=>f.store.getGrant(c.id,'mcp.'+x.toolkit.slice(4)+'.echo_text',x.id)?.revision),revisions);
 const next=await f.plan(lb,['gmail-3']);assert.equal((await f.allow(lb,next,'deselect-b2')).status,'succeeded');
 const conn2=connections.find(x=>x.toolkit==='mcp-gmail-2');assert.equal(f.store.getGrant(b.id,'mcp.gmail-2.echo_text',conn2.id).policy,'deny');assert.equal(f.store.getGrant(c.id,'mcp.gmail-2.echo_text',conn2.id).policy,'ask');assert.equal(f.gateway.registry.getConnection(conn2.id).status,'active');
 const ga=f.store.getGrant(a.id,'mcp.gmail-1.echo_text',connections.find(x=>x.toolkit==='mcp-gmail-1').id);assert.equal(ga.policy,'ask');
 const count=f.grantCalls;f.store.setGrant({botId:c.id,tool:'mcp.gmail-1.echo_text',destination:connections.find(x=>x.toolkit==='mcp-gmail-1').id,policy:'deny'});
 assert.equal(f.admin.applyInstanceSelection(cc.actionId).current,'changed');assert.equal(f.grantCalls,count+1,'replay never restores a revoked grant');
 noPrivate(f);
});

test('3B: CAS inventory/selection, forged profile/origin reject; partial and completed-ACKlost receipts survive reopen without grant replay',async t=>{
 const f=await fixture(t),a=f.bots[0],l=f.live(a),p=await f.plan(l,['gmail-1','gmail-2','gmail-3']);
 const forged=structuredClone(p);forged.targets[0].connectionId='conn_forged';await assert.rejects(f.propose(l,forged,'forged'));assert.equal(f.grantCalls,0);
 const stale=await f.plan(l,['gmail-1','gmail-2','gmail-3','gmail-4','gmail-5'],'all_connected');const pending=await f.propose(l,stale,'stale-all');
 f.admin.setBotSelection('gmail-6',a.id,{toolIds:[],policy:'ask'});f.store.decideAction(pending.actionId,{decision:'allow',requestHash:pending.requestHash});assert.equal((await f.propose(l,stale,'stale-all')).status,'blocked');assert.equal(f.grantCalls,0);
 const fresh=await f.plan(l,['gmail-1','gmail-2','gmail-3']);f.failAt(2);const partial=await f.allow(l,fresh,'partial');assert.equal(partial.status,'unknown');
 const read=f.admin.instanceSelectionReceipt(partial.actionId);assert.equal(read.receipt.phase,'partial');assert.equal(read.matchingStepStates,1);assert.equal(read.totalSteps,3);assert.equal(f.grantCalls,2);
 const before=dbRows(f.path,'SELECT * FROM instance_selection_receipts');const thread=l.thread;await f.restart();assert.deepEqual(dbRows(f.path,'SELECT * FROM instance_selection_receipts'),before);assert.equal(f.grantCalls,2);
 assert.equal(f.admin.applyInstanceSelection(partial.actionId).receipt.phase,'partial');assert.equal(f.grantCalls,2);
 const next=f.live(f.store.getBot(a.id),thread),own=await f.call(next,'mcp.instance_selection_receipt','read-original',{action_id:partial.actionId});assert.equal(own.result.dispatcherState,'unknown');assert.equal(own.result.selection.receipt.phase,'partial');
 const wrong=f.live(f.bots[1]);await assert.rejects(f.call(wrong,'mcp.instance_selection_receipt','wrong-bot',{action_id:partial.actionId}));
 const repair=await f.plan(next,['gmail-1','gmail-2','gmail-3']);f.failAt(0);f.lose();const lost=await f.allow(next,repair,'new-exact-approval');assert.equal(lost.status,'unknown');
 const complete=f.admin.instanceSelectionReceipt(lost.actionId);assert.equal(complete.receipt.phase,'completed');assert.equal(complete.current,'matches');assert.equal(f.admin.instanceSelectionReceipt(partial.actionId).receipt.phase,'partial','later approval does not turn old partial into success');
 const grants=f.grantCalls;await f.restart();assert.equal(f.admin.applyInstanceSelection(lost.actionId).receipt.phase,'completed');assert.equal(f.grantCalls,grants);
 noPrivate(f);
});

test('3B: Native2 upgrade has legitimate zero new counts; Native3 checkpoint/restore retains history without authority and tamper/downgrade refuses',async t=>{
 const f=await fixture(t,true),a=f.bots[0],l=f.live(a),p=await f.plan(l,['gmail-1','gmail-2']),done=await f.allow(l,p,'portable');assert.equal(done.status,'succeeded');
 assert.deepEqual(f.upgradeCounts,{servers:0,catalogs:0,selections:0,connections:0,setupReceipts:0,instanceSelectionHeads:0,instanceSelectionReceipts:0});
 const db=new DatabaseSync(f.path,{readOnly:true});try{assert.equal(nativeMcpSchemaLabel(db),'native-mcp-v3');assert.equal(db.prepare('SELECT COUNT(*) AS n FROM instance_selection_heads').get().n,1);}finally{db.close();}
 await f.close();const original=dbRows(f.path,'SELECT * FROM instance_selection_receipts');
 const {privateKey,publicKey}=generateKeyPairSync('ed25519'),secret=createSecretKey(randomBytes(32)),key={keyId:'synthetic-selection-checkpoint',use:fn=>fn(secret)},owner={publicKey,sign:bytes=>sign(null,bytes,privateKey)};
 const coordinator=AuthorityCoordinator.open(join(f.root,'coordinator'),{ownerId:f.store.ownerId,ownerPublicKey:publicKey});t.after(()=>coordinator.close());
 const control=new LocalAuthorityController({coordinator}),hold=await control.quiesce({quiesceForMaintenance:async()=>f.store}),artifact=join(f.root,'selection.dxg8'),dest=join(f.root,'restored');
 const prepared=control.prepare(hold,{output:artifact,key}),decoded=openCheckpointArtifact(artifact,key);
 assert.equal(decoded.manifest.schemas.nativeMcp,'native-mcp-v3');assert.equal(decoded.manifest.counts.nativeMcp.instanceSelectionReceipts,1);assert.equal(decoded.manifest.counts.nativeMcp.instanceSelectionHeads,1);
 control.revokeSource({store:f.store},prepared.checkpointId,dest);
 control.activate({artifact,key,receipt:control.issueReceipt(owner,prepared.checkpointId)});
 const target=join(dest,'native-mcp.sqlite');assert.deepEqual(dbRows(target,'SELECT * FROM instance_selection_receipts'),original);assert.equal(dbRows(target,'SELECT COUNT(*) AS n FROM connections')[0].n,0);
 const h=new DatabaseSync(join(dest,basename(f.store.databasePath)),{readOnly:true}),n=new DatabaseSync(target,{readOnly:true});try{assert.equal(validateNativeMcp(n,h).instanceSelectionReceipts,1);}finally{h.close();n.close();}
 for(const label of ['native-mcp-v2','native-mcp-v1']){const historical=structuredClone(decoded.manifest);historical.schemas.nativeMcp=label;delete historical.counts.nativeMcp.instanceSelectionHeads;delete historical.counts.nativeMcp.instanceSelectionReceipts;if(label==='native-mcp-v1')delete historical.counts.nativeMcp.setupReceipts;assert.doesNotThrow(()=>decodeCheckpointManifest(historical,resolveLimits()));}
 const bad=structuredClone(decoded.manifest);delete bad.counts.nativeMcp.instanceSelectionReceipts;assert.throws(()=>decodeCheckpointManifest(bad,resolveLimits()));
 const c=join(f.root,'tamper.sqlite');copyFileSync(target,c);const tamper=new DatabaseSync(c);try{tamper.prepare("UPDATE instance_selection_receipts SET receipt_hash=?").run('0'.repeat(64));assert.throws(()=>nativeMcpSchemaLabel(tamper));}finally{tamper.close();}
 const forgedPath=join(f.root,'forged-origin.sqlite');copyFileSync(target,forgedPath);const forged=new DatabaseSync(forgedPath),boundHub=new DatabaseSync(join(dest,basename(f.store.databasePath)),{readOnly:true});try{
  const row=forged.prepare('SELECT * FROM instance_selection_receipts').get(),receipt={...JSON.parse(row.receipt),originHash:'f'.repeat(64)};
  forged.prepare('UPDATE instance_selection_receipts SET receipt=?,receipt_hash=?').run(mcpSetupCanonicalJSON(receipt),mcpSetupHash(receipt));
  assert.throws(()=>validateNativeMcp(forged,boundHub),e=>e.code==='reference_broken','a recomputed native checksum does not forge canonical Hub origin');
 }finally{forged.close();boundHub.close();}
 const downgrade=new DatabaseSync(target);try{downgrade.prepare("UPDATE meta SET value='2' WHERE key='schema'").run();assert.throws(()=>nativeMcpSchemaLabel(downgrade));}finally{downgrade.close();}
 noPrivate(f);
});
