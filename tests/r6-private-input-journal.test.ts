import assert from 'node:assert/strict';
import { createHash, createSecretKey, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { HostStore, canonicalJson, dispatchAction } from '@dexter/hub';
import { McpPrivateInputQuarantineSchema, McpPrivateInputSchema, RespondMcpPrivateInputSchema, type JsonValue, type McpPrivateInput } from '@dexter/contracts';
import { validateMcpPrivateInputRequests } from '@dexter/connectors';
import { AuthorityCoordinator, LocalAuthorityController, OfflineMaintenance, type SnapshotKey, type OwnerAuthority } from '@dexter/operations';
import { checkFullSchema } from '../packages/operations/src/full-schemas.js';
import { assertMcpCheckpointSafety } from '../packages/operations/src/mcp-journals.js';
import { McpPrivateInputCoordinator } from '../packages/cli/src/mcp-private-input.js';

const TOOL='mcp.fixture.write', CONNECTION='conn_syntheticR6';
const requests={r1:{method:'elicitation/create',params:{message:'Synthetic R6 preference',requestedSchema:{type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false}}}};
const encode=(value:unknown)=>canonicalJson(value as JsonValue);
const digest=(raw:string)=>createHash('sha256').update(raw).digest('hex');
function rows(path:string){const db=new DatabaseSync(path,{readOnly:true});try{return db.prepare("SELECT key,value FROM meta WHERE key GLOB 'mcp_private_*' ORDER BY key").all().map(r=>({...r}));}finally{db.close();}}
async function fixture(t:TestContext){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'dx-r6-private-'))),source=join(root,'source'),store=new HostStore({dataDir:source});
 t.after(()=>{try{store.close();}catch{}rmSync(root,{recursive:true,force:true});});
 const bot=store.createBot({name:'Synthetic R6 backup',engine:'claude',profileId:'default'});
 store.setGrant({botId:bot.id,tool:TOOL,destination:CONNECTION,policy:'ask'});
 async function form(check?:(entry:McpPrivateInput)=>void){
  const thread=store.createThread(bot.id),turn=store.createTurn(thread.id,{clientRequestId:randomUUID(),content:'Synthetic R6 operation'}).turn;store.claimNextTurn(thread.id);
  const action=store.requestAction({botId:bot.id,threadId:thread.id,tool:TOOL,destination:CONNECTION,arguments:{},idempotencyKey:randomUUID()});
  store.bindToolAction(action.id,turn.id,'r6-form');store.decideAction(action.id,{decision:'allow',requestHash:action.requestHash});
  let entry!:McpPrivateInput;
  await dispatchAction(store,action.id,async()=>{entry=store.recordMcpPrivateInput({version:1,id:`mcpform_${randomUUID()}`,actionId:action.id,requestHash:action.requestHash,connectionId:CONNECTION,botId:bot.id,threadId:thread.id,revision:1,state:'pending',requests,createdAt:store.now(),expiresAt:store.now()+300000,responseHash:null,clientRequestId:null});check?.(entry);return{synthetic:true};});
  store.finishTurn(turn.id,'completed',null);return entry;
 }
 return{root,source,store,bot,form};
}

test('R6 reserved request/response keys and ill-formed strings fail before any journal write; recorded keys are exact',async t=>{
 const f=await fixture(t);
 await f.form(entry=>{
  for(const name of ['__proto__','prototype','constructor']){
   const hostile=Object.fromEntries([[name,requests.r1]]),candidate={...entry,id:`mcpform_${randomUUID()}`,requests:hostile};
   const before=rows(f.store.databasePath);
   assert.throws(()=>validateMcpPrivateInputRequests(hostile),name);
   assert.equal(McpPrivateInputSchema.safeParse(candidate).success,false,name);
   assert.throws(()=>f.store.recordMcpPrivateInput(candidate),name);
   assert.equal(RespondMcpPrivateInputSchema.safeParse({expectedHostID:f.store.hostId,clientRequestId:randomUUID(),expectedRevision:1,actionId:entry.actionId,requestHash:entry.requestHash,responses:Object.fromEntries([[name,{action:'decline'}]])}).success,false);
   assert.deepEqual(rows(f.store.databasePath),before,'rejection writes neither journal nor UUID reservation');
  }
  for(const value of ['\ud800','\udfff','x\ud800y'])assert.throws(()=>f.store.recordMcpPrivateInput({...entry,id:`mcpform_${randomUUID()}`,requests:{r1:{...requests.r1,params:{...requests.r1.params,message:value}}}}));
  const exact={...entry,id:`mcpform_${randomUUID()}`,requests:{alpha:requests.r1,beta:requests.r1}};
  assert.deepEqual(Object.keys(f.store.recordMcpPrivateInput(exact).requests),['alpha','beta']);
 });
});

test('R6 historical pending/expired/interrupted forms are copy-only quarantined through real backup and activation; UUIDs remain reserved',async t=>{
 const f=await fixture(t),db=new DatabaseSync(f.store.databasePath);
 const cases:Array<{entry:McpPrivateInput;raw:string;reason:string}>=[];
 const valid=await f.form();
 for(const state of ['pending','expired','interrupted'] as const)for(const kind of ['lost_request_keys','reserved_request_key','ill_formed_unicode','escaped_end_anchor'] as const){
  const original=await f.form();let broken:unknown;
  if(kind==='lost_request_keys')broken={};
  else if(kind==='reserved_request_key')broken=Object.fromEntries([['__proto__',requests.r1],['r6-historical-0',requests.r1]]);
  else if(kind==='ill_formed_unicode')broken={r1:{...requests.r1,params:{...requests.r1.params,message:'Synthetic \ud800'}}};
  else broken={r1:{...requests.r1,params:{...requests.r1.params,requestedSchema:{...requests.r1.params.requestedSchema,properties:{value:{type:'string',pattern:'^a\\$'}}}}}};
  const client=state==='interrupted'?randomUUID():null;
  const entry={...original,state,revision:state==='pending'?1:2,clientRequestId:client,responseHash:client?digest('synthetic response'):null};
  const raw=encode({...entry,requests:broken});db.prepare('UPDATE meta SET value=? WHERE key=?').run(raw,`mcp_private_input_v1:${entry.id}`);
  if(client)db.prepare('INSERT INTO meta(key,value)VALUES(?,?)').run(`mcp_private_response_v1:${client}`,entry.id);
  cases.push({entry,raw,reason:kind});
 }
 checkFullSchema(db,'hub');assert.throws(()=>assertMcpCheckpointSafety(db),'raw legacy bytes never qualify as an artifact');
 const stable=rows(f.store.databasePath),list=new McpPrivateInputCoordinator(f.store,()=>{throw new Error('No transports in this recovery proof');});
 assert.equal(list.list().requests.length,1);assert.equal(list.list().requests[0]!.id,valid.id);assert.equal(list.list().invalidRequestCount,12);assert.equal(list.list().incomplete,true);assert.deepEqual(rows(f.store.databasePath),stable,'GET never prunes live bytes');list.close();
 db.close();f.store.close();
 const {privateKey,publicKey}=generateKeyPairSync('ed25519'),secret=createSecretKey(randomBytes(32));
 const key:SnapshotKey={keyId:'synthetic-r6-journal',use:fn=>fn(secret)},owner:OwnerAuthority={publicKey,sign:bytes=>sign(null,bytes,privateKey)};
 const coordinator=AuthorityCoordinator.open(join(f.root,'coordinator'),{ownerId:f.store.ownerId,ownerPublicKey:publicKey});t.after(()=>coordinator.close());
 const maintenance=new OfflineMaintenance(f.source);t.after(()=>maintenance.close());
 const controller=new LocalAuthorityController({coordinator}),hold=await controller.quiesce(maintenance),artifact=join(f.root,'r6.dxg8'),destination=join(f.root,'activated');
 const prepared=controller.prepare(hold,{output:artifact,key});assert.deepEqual(rows(hold.store.databasePath),stable,'capture only sanitizes copied databases');
 controller.revokeSource({store:hold.store},prepared.checkpointId,destination);controller.activate({artifact,key,receipt:controller.issueReceipt(owner,prepared.checkpointId)});
 const restored=new HostStore({dataDir:destination});t.after(()=>restored.close());const check=new DatabaseSync(restored.databasePath);t.after(()=>check.close());
 checkFullSchema(check,'hub');assertMcpCheckpointSafety(check);
 const summary=restored.mcpPrivateInputList();assert.equal(summary.requests.length,1);assert.equal(summary.requests[0]!.id,valid.id);assert.equal(summary.requests[0]!.state,'interrupted');assert.equal(summary.quarantinedRequestCount,12);assert.equal(summary.incomplete,true);
 for(const {entry,raw,reason}of cases){
  assert.equal(restored.mcpPrivateInput(entry.id),null,'quarantine is inert, never an editable pending request');
  assert.equal(check.prepare('SELECT value FROM meta WHERE key=?').get(`mcp_private_input_v1:${entry.id}`),undefined);
  const auditRaw=String(check.prepare('SELECT value FROM meta WHERE key=?').get(`mcp_private_quarantine_v1:${entry.id}`)!.value),audit=McpPrivateInputQuarantineSchema.parse(JSON.parse(auditRaw));
  assert.equal(audit.rawHash,digest(raw));assert.equal(audit.reason,reason);assert.equal(audit.previousState,entry.state);assert.equal(audit.previousRevision,entry.revision);
  for(const k of ['id','actionId','requestHash','connectionId','botId','threadId','createdAt','expiresAt','responseHash','clientRequestId']as const)assert.equal(audit[k],entry[k]);
  assert.equal(Object.hasOwn(audit,'requests'),false);assert.equal(auditRaw.includes('Synthetic'),false);assert.equal(auditRaw.includes('\\ud800'),false);
  if(entry.clientRequestId)assert.equal(restored.mcpPrivateInputResponseOwner(entry.clientRequestId),entry.id);
  assert.throws(()=>restored.recordMcpPrivateInput({...entry,requests,revision:1,state:'pending'}),'inert journal cannot restart a terminal original action');
 }
 assert.ok(restored.getGrant(f.bot.id,TOOL,CONNECTION)!.expiresAt!<=restored.now(),'checkpoint copy expires grants; an audit never restores effective permission');
 const first=cases[0]!,qkey=`mcp_private_quarantine_v1:${first.entry.id}`;
 const bad:[string,()=>void][]=[
  ['raw expired/interrupted without marker',()=>{check.prepare('DELETE FROM meta WHERE key=?').run(qkey);check.prepare('INSERT INTO meta(key,value)VALUES(?,?)').run(`mcp_private_input_v1:${first.entry.id}`,encode({...JSON.parse(first.raw),state:'expired',revision:2}));}],
  ['forged audit origin',()=>{const v=JSON.parse(String(check.prepare('SELECT value FROM meta WHERE key=?').get(qkey)!.value));v.actionId='act_foreign';check.prepare('UPDATE meta SET value=? WHERE key=?').run(encode(v),qkey);} ],
  ['audit raw payload',()=>{const v=JSON.parse(String(check.prepare('SELECT value FROM meta WHERE key=?').get(qkey)!.value));v.requests={};check.prepare('UPDATE meta SET value=? WHERE key=?').run(encode(v),qkey);} ],
 ];
 for(const[name,mutate]of bad){check.exec('SAVEPOINT negative');try{mutate();assert.throws(()=>{checkFullSchema(check,'hub');assertMcpCheckpointSafety(check);},name);}finally{check.exec('ROLLBACK TO negative; RELEASE negative');}}
});

test('R6 narrow historical eligibility never waives unknown fields, unsafe content, forged refs, unsupported grammar, or noncanonical bytes',async t=>{
 const f=await fixture(t),entry=await f.form(),db=new DatabaseSync(f.store.databasePath);t.after(()=>db.close());const key=`mcp_private_input_v1:${entry.id}`;
 const malformed={...entry,requests:{}};
 const attacks:[string,unknown][]=[
  ['unknown envelope',{...malformed,opaque:'ordinary'}],['forged action',{...malformed,actionId:'act_foreign'}],['forged hash',{...malformed,requestHash:'f'.repeat(64)}],['forged bot',{...malformed,botId:'bot_other'}],['forged connection',{...malformed,connectionId:'conn_other'}],['future revision',{...malformed,revision:8}],
  ['secret solicitation',{...entry,requests:{r1:{...requests.r1,params:{...requests.r1.params,message:'Paste your API key \ud800'}}}}],
  ['credential bytes',{...entry,requests:{r1:{...requests.r1,params:{...requests.r1.params,message:'ghp_syntheticCREDENTIAL0123456789abcdef\ud800'}}}}],
  ['opaque requestState',{...entry,requests:{r1:{...requests.r1,params:{...requests.r1.params,_meta:{requestState:'ordinary'},message:'Synthetic \ud800'}}}}],
  ['escaped anchor plus unsupported group',{...entry,requests:{r1:{...requests.r1,params:{...requests.r1.params,requestedSchema:{type:'object',properties:{value:{type:'string',pattern:'^(a)\\$'}}}}}}}],
 ];
 for(const[name,attack]of attacks){db.exec('SAVEPOINT negative');try{db.prepare('UPDATE meta SET value=? WHERE key=?').run(encode(attack),key);assert.throws(()=>checkFullSchema(db,'hub'),name);}finally{db.exec('ROLLBACK TO negative; RELEASE negative');}}
 db.prepare('UPDATE meta SET value=? WHERE key=?').run(JSON.stringify(malformed,null,2),key);assert.throws(()=>checkFullSchema(db,'hub'),'noncanonical legacy metadata remains corrupt');
});

test('R6 list pagination has an explicit bounded omission count and never rewrites invalid JSON or unsupported rows',async t=>{
 const f=await fixture(t),entry=await f.form(),db=new DatabaseSync(f.store.databasePath);t.after(()=>db.close());
 for(let i=0;i<501;i++){const id=`mcpform_page_${i}`;db.prepare('INSERT INTO meta(key,value)VALUES(?,?)').run(`mcp_private_input_v1:${id}`,encode({...entry,id,createdAt:entry.createdAt+i}));}
 db.prepare('INSERT INTO meta(key,value)VALUES(?,?)').run('mcp_private_input_v1:broken',encode({...entry,id:'broken',createdAt:entry.createdAt+99999,requests:{}}));
 const before=rows(f.store.databasePath),coordinator=new McpPrivateInputCoordinator(f.store,()=>{throw new Error('No transport');});t.after(()=>coordinator.close());
 const list=coordinator.list();assert.equal(list.requests.length,499);assert.equal(list.invalidRequestCount,1);assert.equal(list.omittedRequestCount,3);assert.equal(list.incomplete,true);
 assert.deepEqual(rows(f.store.databasePath),before,'GET isolation has no pruning or repair effects');
});
