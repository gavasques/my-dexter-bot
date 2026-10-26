import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {mkdtempSync,existsSync,readdirSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dispatchAction} from '@dexter/hub';
import {checkManifest} from '@dexter/gateway';
import {inspectMcpMetadata,MCP_METADATA_CATALOG_LIMITS} from '@dexter/connectors';
import {planHostStartup} from '../packages/cli/src/host-startup.js';
import {serviceLab,hostLab,CATALOG,READ,SERVICE_ORIGIN,LINK_ORIGIN,COMPOSIO_KEY,type HostLab} from './fixtures/connections-lab.js';
import {ConnectionsPlatformService} from '../packages/connections-service/src/index.js';

async function setup(host:HostLab){
  const bot=host.store.createBot({name:'Recovery fixture',profileId:'default',engine:'claude'}),thread=host.store.createThread(bot.id);
  const turn=host.store.createTurn(thread.id,{clientRequestId:randomUUID(),content:'Connect my synthetic account.'}).turn;
  host.store.claimNextTurn(thread.id);
  host.store.setGrant({botId:bot.id,tool:'dexter.harness.connections.request',destination:'dexter-harness-owner-proposals',policy:'ask'});
  const catalog=await host.runtime.admin.catalog(),action=host.store.requestAction({botId:bot.id,threadId:thread.id,tool:'dexter.harness.connections.request',destination:'dexter-harness-owner-proposals',arguments:{},idempotencyKey:randomUUID()});
  host.store.bindToolAction(action.id,turn.id,'setup');host.store.decideAction(action.id,{decision:'allow',requestHash:action.requestHash});
  const request={clientRequestId:randomUUID(),expectedBotRevision:bot.revision,target:{kind:'managed' as const,serviceId:'gmail',catalogPin:catalog.pin}};
  await dispatchAction(host.store,action.id,async()=>({requestId:host.store.createConnectionWorkflow(action.id,request).id}));
  return {catalog,workflow:host.store.connectionWorkflow(`setup_${action.id}`)!};
}
test('setup choices list only live authorization links, ordered; expired/failed GETs never mint a replacement link',{timeout:15_000},async t=>{
  const svc=await serviceLab(t),host=await hostLab(t,svc),{catalog,workflow}=await setup(host);
  const make=async()=>host.runtime.admin.startAuthorization({expectedHostID:host.store.hostId,clientRequestId:randomUUID(),serviceId:'gmail',catalogPin:catalog.pin,profileId:null,label:null,replacesAccountId:null,setupRequestId:workflow.id});
  const first=(await make()).authorization,second=(await make()).authorization;
  assert.deepEqual(host.runtime.admin.setupAuthorizations!(workflow.id),[first,second].sort((a,b)=>a.createdAt-b.createdAt||a.clientRequestId.localeCompare(b.clientRequestId)).map(a=>a.clientRequestId));
  const db=new DatabaseSync(join(host.dir,'connections.sqlite'));
  db.prepare("UPDATE attempts SET state='failed' WHERE client_request_id=?").run(first.clientRequestId);
  db.prepare('UPDATE attempts SET expires_at=0 WHERE client_request_id=?').run(second.clientRequestId);db.close();
  assert.deepEqual(host.runtime.admin.setupAuthorizations!(workflow.id),[]);
  const before=svc.composio.count('POST','/api/v3.1/connected_accounts/link');await host.runtime.admin.authorization(first.clientRequestId);await host.runtime.admin.authorization(second.clientRequestId);
  assert.equal(svc.composio.count('POST','/api/v3.1/connected_accounts/link'),before);
  const third=(await make()).authorization;assert.deepEqual(host.runtime.admin.setupAuthorizations!(workflow.id),[third.clientRequestId]);
  assert.equal(svc.composio.count('POST','/api/v3.1/connected_accounts/link'),before+1);
});
test('managed catalog accepts 16 services x32 definitions over256KiB while preserving per-definition quarantine',{timeout:15_000},async t=>{
  const catalog=Array.from({length:16},(_,i)=>({...CATALOG[0]!,serviceId:`service${i}`,tools:Array.from({length:32},(_,j)=>checkManifest({...READ,name:`gmail.read${i}_${j}`,upstreamSlug:`GMAIL_READ_${i}_${j}`,description:'Synthetic metadata '.repeat(35)}))}));
  assert(Buffer.byteLength(JSON.stringify(catalog))>256*1024);
  const svc=await serviceLab(t,{catalog}),host=await hostLab(t,svc),observed=await host.runtime.admin.catalog();
  assert.equal(observed.services.length,16);assert(observed.services.every(s=>s.tools.length===32));
  const canary='Bearer AbC0def123GhI456jKlM789pqRst';
  assert.equal(inspectMcpMetadata({description:canary}).safe,false,'canary is credential-shaped, not an exempt placeholder');
  const contaminated=catalog.map((entry,i)=>i?entry:{...entry,tools:entry.tools.map((tool,j)=>j?tool:checkManifest({...tool,description:canary}))});
  // Quarantine removes one definition before publication; healthy definitions remain usable.
  // An inert transport proves no provider call/effect is needed to construct or inspect the catalog.
  const root=mkdtempSync(join(tmpdir(),'dx-managed-quarantine-')),dataDir=join(root,'service');
  let providerCalls=0;
  const service=new ConnectionsPlatformService({dataDir,publicOrigin:SERVICE_ORIGIN,catalog:contaminated,
    composio:{apiKey:()=>COMPOSIO_KEY,authorizationOrigins:[LINK_ORIGIN],fetch:async()=>{providerCalls++;throw new Error('Quarantined metadata must not contact the provider.');}},
    installations:{resolve:()=>null}});
  t.after(()=>{service.close();rmSync(root,{recursive:true,force:true});});
  const safe=service.catalog(),tools=safe.services.flatMap(entry=>entry.tools);
  assert.equal(safe.services.length,16);assert.equal(tools.length,511);
  assert.equal(safe.services.find(entry=>entry.serviceId==='service0')!.tools.length,31);
  for(const entry of safe.services.filter(entry=>entry.serviceId!=='service0'))assert.equal(entry.tools.length,32);
  assert.deepEqual(tools.map(tool=>checkManifest(tool).name).sort(),catalog.flatMap(entry=>entry.tools).filter(tool=>tool.name!=='gmail.read0_0').map(tool=>tool.name).sort());
  assert.equal(JSON.stringify(safe).includes(canary),false);
  assert.equal(inspectMcpMetadata(safe,[canary],MCP_METADATA_CATALOG_LIMITS).safe,true);
  assert.equal(providerCalls,0);
  const db=new DatabaseSync(join(dataDir,'connections-service.sqlite'),{readOnly:true});
  try{for(const table of ['attempts','accounts','disconnects','executions'])assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n,0,`${table}: catalog inspection creates no account or execution`);}
  finally{db.close();}
  const variants=[canary,encodeURIComponent(canary),Buffer.from(canary).toString('base64')];
  const checkPersisted=(dir:string):void=>{for(const entry of readdirSync(dir,{withFileTypes:true})){
    const path=join(dir,entry.name);if(entry.isDirectory())checkPersisted(path);
    else if(entry.isFile())for(const value of variants)assert.equal(readFileSync(path).includes(Buffer.from(value)),false,'credential canary is not persisted');
  }};
  checkPersisted(dataDir);assert.equal(providerCalls,0);
});
test('trusted startup accepts only reviewed exact Mac private origins; cloud and malformed origins refuse before creating data',{timeout:15_000},async t=>{
  const dir=mkdtempSync(join(tmpdir(),'dx-egress-startup-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const options={dataDir:join(dir,'host'),enableEngines:true,enableMcp:true,nativeMcp:{runsOn:'owner_mac' as const,privateOrigins:['http://10.1.2.3:4317','https://auth.home.test']}};
  const plan=planHostStartup({route:'production',options});assert.equal(plan.description.nativeMcp,'owner_mac');assert.equal(existsSync(options.dataDir),false);
  const invalid:[string,string[]][]=[['path',['http://127.0.0.1:99/path']],['userinfo',['https://user:pass@auth.home.test']],['credential query',['https://auth.home.test?token=x']],['metadata IP',['http://169.254.169.254']],['duplicate',['https://auth.home.test','https://auth.home.test']]];
  for(const [name,privateOrigins]of invalid)await t.test(`reject ${name}`,()=>
    assert.throws(()=>planHostStartup({route:'production',options:{...options,nativeMcp:{runsOn:'owner_mac',privateOrigins}}}),/Invalid private MCP origins/));
  await t.test('cloud refuses a private origin',()=>assert.throws(()=>planHostStartup({route:'production',options:{...options,nativeMcp:{runsOn:'cloud',privateOrigins:['http://127.0.0.1:99']}}}),/Invalid private MCP origins/));
  assert.equal(existsSync(options.dataDir),false);
});
