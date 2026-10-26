import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,createSecretKey,randomBytes,randomUUID} from 'node:crypto';
import {chmodSync,existsSync,linkSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,renameSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {serve} from '@hono/node-server';
import {HostServices} from '../packages/cli/dist/host-services.js';
import {OutputFilesService} from '../packages/cli/dist/output-files.js';
import {createHostApp,createAuthorizedHostRouter} from '../packages/hub/dist/http.js';
import {HostStore} from '../packages/hub/dist/index.js';
import {OutputFilesStatusSchema,OutputLocationsSchema,OutputNamespacesSchema,OutputEntriesSchema,OutputItemSchema,OutputDestinationReceiptSchema} from '../packages/contracts/dist/index.js';
import {captureCheckpointArtifact,openCheckpointArtifact,doctor} from '../packages/operations/dist/index.js';

// Output folders (general / Bots / Times) of one base. Synthetic data directories, folders and processes owned by this
// test only; no real account, Keychain, TCC location, VPS, SSH or network beyond loopback.
const dir=prefix=>{const value=realpathSync(mkdtempSync(join(tmpdir(),prefix)));chmodSync(value,0o700);return value;};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const catalog=()=>[{id:'claude',available:true,defaultModel:'synthetic-model',models:[{id:'synthetic-model',reasoningEfforts:[],speeds:[]}],reasoningEfforts:[],speeds:[]}];
const idle=id=>({id,sessionReuse:'turn',capabilities:{resume:true,interrupt:true,fork:false,steer:false},status:async()=>({engine:id,installed:true,authentication:'unverified',billing:'unknown'}),
  open:async threadId=>({threadId,nativeCursor:'synthetic'}),async *turn(session,turnId){yield {type:'turn.completed',threadId:session.threadId,turnId,usage:{}};},respondToTool:async()=>{},interrupt:async()=>{},close:async()=>{}});
function host(t,dataDir){
  let services=new HostServices({dataDir,enableEngines:true,enableMcp:true,engineCommands:{claude:'/usr/bin/false'},engineCatalog:catalog,makeDriver:idle});
  let app=createHostApp(services.store,{outputFiles:services.outputFilesHttp});
  const f={get services(){return services;},get store(){return services.store;},get tools(){return services.botWorkspaceTools;},
    api:async(method,path,body)=>{const r=await app.request('http://127.0.0.1'+path,{method,...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})});
      const type=r.headers.get('content-type')??'';return {status:r.status,headers:r.headers,json:type.includes('json')?await r.json():null,bytes:type.includes('json')?null:new Uint8Array(await r.arrayBuffer())};},
    async reopen(){await services.shutdown();services=new HostServices({dataDir,enableEngines:true,enableMcp:true,engineCommands:{claude:'/usr/bin/false'},engineCatalog:catalog,makeDriver:idle});
      app=createHostApp(services.store,{outputFiles:services.outputFilesHttp});},
    turn(botId){const thread=services.store.createThread(botId),{turn}=services.store.createTurn(thread.id,{clientRequestId:randomUUID(),content:'synthetic'});
      assert.equal(services.store.claimNextTurn(thread.id).id,turn.id);return turn.id;},
    bot(name){return services.store.createBot({name,profileId:'synthetic',engine:'claude'});}};
  t.after(async()=>{await services.shutdown();});
  return f;
}
const destination=(f,clientRequestId,expectedRevision,destination)=>f.api('PUT','/v1/output-files/destination',{expectedHostID:f.store.hostId,clientRequestId,expectedRevision,destination});

test('implicit legacy generation: nothing moves, bots stay in bot-files, nothing is persisted by reads',t=>{
  const data=dir('dx-outputs-legacy-');t.after(()=>rmSync(data,{recursive:true,force:true}));
  mkdirSync(join(data,'bot-files','bot_old'),{recursive:true,mode:0o700});writeFileSync(join(data,'bot-files','bot_old','kept.txt'),'old output');
  const service=new OutputFilesService({dataDir:data,identity:()=>({hostId:'host_synthetic',ownerId:'owner_synthetic'}),bots:()=>[{id:'bot_old',name:'Old bot'},{id:'bot_new',name:'New bot'}]});
  t.after(()=>service.close());
  const status=OutputFilesStatusSchema.parse(service.status());
  assert.equal(status.persisted,false);assert.equal(status.revision,1);
  assert.deepEqual({kind:status.current.kind,layout:status.current.layout,path:status.current.path,namespaces:status.current.namespaces},
    {kind:'host_data_legacy',layout:'legacy',path:data,namespaces:{general:false,bots:true,teams:true}});
  const ns=OutputNamespacesSchema.parse(service.namespaces({}));
  assert.deepEqual(ns.items.map(i=>[i.ref,i.label,i.exists,i.relativePath]),[['bot:bot_new','New bot',false,'bot-files/bot_new'],['bot:bot_old','Old bot',true,'bot-files/bot_old']],
    'no general namespace in the legacy layout: the data directory holds internal stores');
  assert.throws(()=>service.entries({namespace:'general'}),e=>e.code==='not_found');
  const old=OutputEntriesSchema.parse(service.entries({namespace:'bot:bot_old'}));
  assert.deepEqual(old.items.map(i=>[i.name,i.type,i.bytes]),[['kept.txt','file',10]]);
  const tool=service.toolNamespace({kind:'bot',id:'bot_new',turnId:null},false);
  assert.equal(tool.path,join(data,'bot-files','bot_new'));assert.equal(tool.relative,'bot-files/bot_new');
  assert.equal(service.toolNamespace({kind:'team',id:'team_a',turnId:null},false).path,join(data,'team-files','team_a'));
  assert.equal(existsSync(join(data,'output-files.sqlite')),false,'reads never create the ledger');
  service.toolNamespace({kind:'bot',id:'bot_new',turnId:null},true);
  assert.equal(OutputFilesStatusSchema.parse(service.status()).persisted,true);
  assert.deepEqual(readdirSync(join(data,'bot-files','bot_old')),['kept.txt']);
});

test('destination change: owner CAS + receipt + replay, new files only, ledger keeps old outputs, restart and lost ACK',async t=>{
  const data=dir('dx-outputs-host-'),chosen=dir('dx-outputs-chosen-');t.after(()=>{rmSync(data,{recursive:true,force:true});rmSync(chosen,{recursive:true,force:true});});
  const f=host(t,data),bot=f.bot('Writer');
  const pinned=f.turn(bot.id);
  f.tools.write({botId:bot.id,turnId:pinned},{path:'report.md',text:'# before'});
  assert.equal(readFileSync(join(data,'bot-files',bot.id,'report.md'),'utf8'),'# before');
  const before=(await f.api('GET','/v1/output-files/status')).json;assert.equal(before.revision,1);assert.equal(before.persisted,true);
  assert.equal((await destination(f,'dest-1',2,{kind:'owner_path',path:chosen})).status,409,'stale revision');
  for(const bad of ['relative/path','/',join(chosen,'missing'),data,join(data,'bot-files')]) assert.equal((await destination(f,'dest-bad',1,{kind:'owner_path',path:bad})).status,400,bad);
  const shared=dir('dx-outputs-shared-');t.after(()=>rmSync(shared,{recursive:true,force:true}));chmodSync(shared,0o777);
  assert.equal((await destination(f,'dest-shared',1,{kind:'owner_path',path:shared})).status,403,'group/world-writable folder refused');
  const linked=join(dir('dx-outputs-link-'),'link');symlinkSync(chosen,linked);
  assert.equal((await destination(f,'dest-link',1,{kind:'owner_path',path:linked})).status,400,'symlinked folder refused');
  const changed=await destination(f,'dest-1',1,{kind:'owner_path',path:chosen});
  assert.equal(changed.status,200);const receipt=OutputDestinationReceiptSchema.parse(changed.json);
  assert.deepEqual({...receipt,createdAt:0,requestHash:''},{version:1,hostId:f.store.hostId,clientRequestId:'dest-1',requestHash:'',previousRevision:1,revision:2,
    previousGeneration:1,generation:2,destination:{kind:'owner_path',path:chosen},existingFilesMoved:false,createdAt:0});
  assert.deepEqual((await destination(f,'dest-1',1,{kind:'owner_path',path:chosen})).json,receipt,'replay returns the original receipt');
  assert.equal((await destination(f,'dest-1',1,{kind:'host_data_default'})).status,409,'same id, other body');
  assert.equal((await destination(f,'dest-2',2,{kind:'owner_path',path:chosen})).status,409,'already current');
  // Not reparented: the turn that started on generation 1 keeps it; a new turn uses the new folder.
  f.tools.write({botId:bot.id,turnId:pinned},{path:'late.md',text:'same turn'});
  assert.equal(readFileSync(join(data,'bot-files',bot.id,'late.md'),'utf8'),'same turn');
  const fresh=f.turn(bot.id);f.tools.write({botId:bot.id,turnId:fresh},{path:'report.md',text:'# after'});
  assert.equal(readFileSync(join(chosen,'Bots',bot.id,'report.md'),'utf8'),'# after');
  assert.equal(readFileSync(join(data,'bot-files',bot.id,'report.md'),'utf8'),'# before','existing output never moved or overwritten');
  const ledger=OutputLocationsSchema.parse((await f.api('GET','/v1/output-files/locations')).json);
  assert.deepEqual(ledger.items.map(l=>[l.generation,l.kind,l.current,l.availability,l.retiredAt===null]),[[2,'owner_path',true,'available',true],[1,'host_data_legacy',false,'available',false]]);
  const old=OutputEntriesSchema.parse((await f.api('GET',`/v1/output-files/entries?generation=1&namespace=bot:${bot.id}`)).json);
  assert.deepEqual(old.items.map(i=>i.name),['late.md','report.md']);
  const now=OutputEntriesSchema.parse((await f.api('GET',`/v1/output-files/entries?namespace=bot:${bot.id}`)).json);
  assert.deepEqual(now.items.map(i=>i.name),['report.md']);
  const general=OutputEntriesSchema.parse((await f.api('GET','/v1/output-files/entries?namespace=general')).json);
  assert.deepEqual(general.items.map(i=>[i.name,i.type]),[['Bots','directory']]);
  // Restart: same ledger and receipt; the lost-ACK client reads the original receipt instead of reposting.
  await f.reopen();
  const after=OutputFilesStatusSchema.parse((await f.api('GET','/v1/output-files/status')).json);
  assert.deepEqual([after.revision,after.current.generation,after.current.path],[2,2,chosen]);
  assert.deepEqual((await f.api('GET','/v1/output-files/receipts/dest-1')).json,receipt);
  assert.equal((await f.api('GET','/v1/output-files/receipts/never-sent')).status,404);
  // Back to the default folder inside the base: another generation; nothing from the chosen folder moves.
  const back=await destination(f,'dest-3',2,{kind:'host_data_default'});
  assert.equal(back.status,200);assert.equal(back.json.destination.path,join(data,'outputs'));
  f.tools.write({botId:bot.id,turnId:f.turn(bot.id)},{path:'third.md',text:'3'});
  assert.equal(readFileSync(join(data,'outputs','Bots',bot.id,'third.md'),'utf8'),'3');
  assert.ok(existsSync(join(chosen,'Bots',bot.id,'report.md')));
  // The chosen folder replaced behind the host's back: fail closed, never another folder.
  await destination(f,'dest-4',3,{kind:'owner_path',path:chosen}).then(r=>assert.equal(r.status,200));
  renameSync(chosen,chosen+'-moved');mkdirSync(chosen,{mode:0o700});t.after(()=>rmSync(chosen+'-moved',{recursive:true,force:true}));
  assert.equal((await f.api('GET','/v1/output-files/status')).json.current.availability,'replaced');
  assert.throws(()=>f.tools.write({botId:bot.id,turnId:f.turn(bot.id)},{path:'x.md',text:'x'}),e=>e.code==='unavailable');
  assert.equal(readdirSync(chosen).length,0);
  assert.equal((await f.api('GET',`/v1/output-files/entries?namespace=bot:${bot.id}`)).status,503);
});

test('owner reads are no-follow and bounded: traversal, symlink, hardlink, secret names, query keys, paired clients',async t=>{
  const data=dir('dx-outputs-guards-'),outside=dir('dx-outputs-outside-');t.after(()=>{rmSync(data,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});});
  const f=host(t,data),bot=f.bot('Guarded');
  f.tools.write(bot.id,{path:'notes/ok.txt',text:'fine'});
  const root=join(data,'bot-files',bot.id);
  writeFileSync(join(outside,'secret.txt'),'OUTSIDE_SENTINEL');
  symlinkSync(outside,join(root,'escape'));symlinkSync(join(outside,'secret.txt'),join(root,'linked.txt'));
  linkSync(join(outside,'secret.txt'),join(root,'hard.txt'));
  writeFileSync(join(root,'.env'),'SECRET=1');writeFileSync(join(root,'auth.json'),'{}');writeFileSync(join(root,'.dexter-write-x.tmp'),'');
  const ns=`bot:${bot.id}`;
  const listed=OutputEntriesSchema.parse((await f.api('GET',`/v1/output-files/entries?namespace=${ns}`)).json);
  assert.deepEqual(listed.items.map(i=>[i.name,i.type]),[['escape','blocked'],['hard.txt','blocked'],['linked.txt','blocked'],['notes','directory']]);
  assert.deepEqual(listed.hidden,{secretLike:2,internal:1});
  assert.ok(!JSON.stringify(listed).includes('OUTSIDE_SENTINEL'));
  for(const path of ['../x','/etc','notes/../..','escape/secret.txt','a\\b']) assert.ok([400,403].includes((await f.api('GET',`/v1/output-files/entries?namespace=${ns}&path=${encodeURIComponent(path)}`)).status),path);
  for(const path of ['linked.txt','hard.txt','.env','auth.json','escape/secret.txt']) assert.ok([400,403].includes((await f.api('GET',`/v1/output-files/item?namespace=${ns}&path=${encodeURIComponent(path)}`)).status),path);
  assert.equal((await f.api('GET',`/v1/output-files/entries?namespace=bot:${bot.id}&unknown=1`)).status,400);
  assert.equal((await f.api('GET',`/v1/output-files/entries?namespace=${ns}&namespace=${ns}`)).status,400,'duplicate key');
  assert.equal((await f.api('GET','/v1/output-files/entries?namespace=bot:../x')).status,400);
  assert.equal((await f.api('GET','/v1/output-files/entries?namespace=general')).status,404,'legacy layout has no general listing');
  const item=OutputItemSchema.parse((await f.api('GET',`/v1/output-files/item?namespace=${ns}&path=notes/ok.txt`)).json);
  assert.deepEqual([item.bytes,item.sha256,item.mediaType,item.exportable],[4,sha('fine'),'text/plain',true]);
  assert.equal((await f.api('GET',`/v1/output-files/content?namespace=${ns}&path=notes/ok.txt&pin=${'0'.repeat(64)}`)).status,409,'stale pin');
  const authority={principal:'paired-client',installationId:f.store.hostId,ownerId:f.store.ownerId,deviceId:'dev',role:'owner-phone',
    scopes:['chat.read','chat.write','approvals.read','approvals.decide','devices.read','devices.manage','grants.read','grants.manage'],pinGeneration:1,bindingRevision:1,assertCurrent(){},noteSelfRevoke(){}};
  const router=createAuthorizedHostRouter(f.store);
  for(const [method,path] of [['GET','/v1/output-files/status'],['GET','/v1/output-files/entries'],['GET','/v1/output-files/content'],['PUT','/v1/output-files/destination']])
    assert.equal((await router.request(path,{method,...(method==='PUT'?{body:'{}',headers:{'content-type':'application/json'}}:{})},{authority})).status,403,path);
});

test('binary export over real loopback HTTP: chunks bound to the file pin, SHA-256 verified, bytes never in JSON',async t=>{
  const data=dir('dx-outputs-export-'),chosen=dir('dx-outputs-export-dest-');t.after(()=>{rmSync(data,{recursive:true,force:true});rmSync(chosen,{recursive:true,force:true});});
  const f=host(t,data),bot=f.bot('Exporter');
  assert.equal((await destination(f,'dest-x',1,{kind:'owner_path',path:chosen})).status,200);
  f.tools.write({botId:bot.id,turnId:f.turn(bot.id)},{path:'slides/readme.txt',text:'deck'});
  const video=randomBytes(9*1024*1024+123);writeFileSync(join(chosen,'Bots',bot.id,'slides','clip.mp4'),video);
  const server=await new Promise(resolve=>{const s=serve({fetch:createHostApp(f.store,{outputFiles:f.services.outputFilesHttp}).fetch,hostname:'127.0.0.1',port:0},info=>resolve({s,url:`http://127.0.0.1:${info.port}`}));});
  t.after(()=>new Promise(done=>server.s.close(()=>done())));
  const get=path=>fetch(server.url+path);
  const ns=`bot:${bot.id}`,item=OutputItemSchema.parse(await (await get(`/v1/output-files/item?namespace=${ns}&path=slides/clip.mp4`)).json());
  assert.deepEqual([item.bytes,item.mediaType,item.sha256],[video.length,'video/mp4',sha(video)]);
  const parts=[];
  for(let offset=0;offset<item.bytes;){
    const r=await get(`/v1/output-files/content?namespace=${ns}&path=slides/clip.mp4&pin=${item.pin}&offset=${offset}`);
    assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),'application/octet-stream');assert.equal(r.headers.get('x-content-type-options'),'nosniff');
    assert.match(r.headers.get('content-disposition'),/^attachment; filename\*=UTF-8''clip\.mp4$/);assert.equal(r.headers.get('cache-control'),'no-store');
    const chunk=Buffer.from(await r.arrayBuffer());assert.ok(chunk.length>0&&chunk.length<=8*1024*1024);parts.push(chunk);offset+=chunk.length;
  }
  assert.equal(parts.length,2);assert.equal(sha(Buffer.concat(parts)),item.sha256);
  // The file changes between chunks: the old pin is refused, never mixed bytes.
  writeFileSync(join(chosen,'Bots',bot.id,'slides','clip.mp4'),Buffer.concat([video,Buffer.from('x')]));
  assert.equal((await get(`/v1/output-files/content?namespace=${ns}&path=slides/clip.mp4&pin=${item.pin}&offset=0`)).status,409);
});

test('Operations: doctor and checkpoint classify output stores exactly; contents and paths are never carried',async t=>{
  const data=dir('dx-outputs-ops-'),out=dir('dx-outputs-ops-out-');t.after(()=>{rmSync(data,{recursive:true,force:true});rmSync(out,{recursive:true,force:true});});
  const f=host(t,data),bot=f.bot('Ops');
  f.tools.write(bot.id,{path:'legacy.txt',text:'LEGACY_OUTPUT_SENTINEL'});
  assert.equal((await destination(f,'dest-ops',1,{kind:'host_data_default'})).status,200);
  const turn=f.turn(bot.id);f.tools.write({botId:bot.id,turnId:turn},{path:'new.txt',text:'NEW_OUTPUT_SENTINEL'});
  f.store.finishTurn(turn,'completed',null);
  await f.services.shutdown();
  const report=doctor(data);
  for(const entry of ['bot-files','output-files.sqlite','outputs']) assert.ok(report.excludedPresent.includes(entry),entry);
  assert.equal(report.unknownEntries,0);
  const store=new HostStore({dataDir:data});t.after(()=>store.close());
  const checkpoint=store.checkpointForTransfer('ckp_output_folders_fixture_2026');
  const key={keyId:'synthetic-outputs',use:fn=>fn(createSecretKey(Buffer.alloc(32,7)))};
  const artifact=captureCheckpointArtifact({source:store,checkpoint,key,output:join(out,'outputs.dxg8')});
  const opened=openCheckpointArtifact(artifact.path,key);
  assert.deepEqual([...opened.manifest.excluded.present].filter(e=>['bot-files','output-files.sqlite','outputs'].includes(e)).sort(),['bot-files','output-files.sqlite','outputs']);
  const bytes=readFileSync(artifact.path);
  for(const needle of ['LEGACY_OUTPUT_SENTINEL','NEW_OUTPUT_SENTINEL']) assert.ok(!bytes.includes(needle),needle);
  assert.ok(![...opened.members.keys()].some(name=>name.includes('output')),'no output member in the artifact');
});

test('pending writes are never reparented: same process keeps the original folder; after a restart the stale pin blocks it',async t=>{
  const {HarnessOperationSurface,HARNESS_OPERATION_DESTINATION}=await import('../packages/cli/dist/harness-operation-surface.js');
  const data=dir('dx-outputs-pins-'),chosen=dir('dx-outputs-pins-dest-');t.after(()=>{rmSync(data,{recursive:true,force:true});rmSync(chosen,{recursive:true,force:true});});
  const f=host(t,data),bot=f.bot('Pinned'),surfaces=[];
  t.after(async()=>{for(const s of surfaces)await s.close();});
  const surface=()=>{const s=new HarnessOperationSurface({store:f.store,base:f.services.gateway,catalog:f.services.engineCatalog,runtime:()=>f.services.runtime,
    skills:()=>f.services.skillsHttp,effectiveSkills:()=>[],workspace:()=>f.services.botWorkspaceTools});surfaces.push(s);return s;};
  const propose=(turnId,path)=>{const s=surface(),token=s.issueCapability({turnId}).token;
    return s.call(token,{connectionId:HARNESS_OPERATION_DESTINATION,tool:'dexter.harness.files.write',callId:'write-'+path,arguments:{path,text:'PINNED '+path}}).then(r=>({s,r}));};
  const first=await propose(f.turn(bot.id),'kept.md'),second=await propose(f.turn(bot.id),'stale.md');
  assert.equal(first.r.status,'awaiting_approval');assert.equal(second.r.status,'awaiting_approval');
  assert.equal((await destination(f,'dest-pins',1,{kind:'owner_path',path:chosen})).status,200);
  // Same process: the proposing turn is bound to generation 1, so the approved effect lands where it was reviewed.
  f.store.decideAction(first.r.actionId,{decision:'allow',requestHash:first.r.requestHash});
  const kept=await first.s.continueOwnerAction(f.store.getAction(first.r.actionId));
  assert.equal(kept.state,'succeeded');
  assert.equal(readFileSync(join(data,'bot-files',bot.id,'kept.md'),'utf8'),'PINNED kept.md');
  assert.equal(existsSync(join(chosen,'Bots',bot.id,'kept.md')),false);
  // Restart: the binding is gone; the pin no longer matches the current destination, so the effect is blocked, not moved.
  await f.reopen();
  f.store.decideAction(second.r.actionId,{decision:'allow',requestHash:second.r.requestHash});
  const stale=await surface().continueOwnerAction(f.store.getAction(second.r.actionId));
  assert.equal(stale.state,'blocked');
  assert.equal(existsSync(join(data,'bot-files',bot.id,'stale.md')),false);assert.equal(existsSync(join(chosen,'Bots',bot.id,'stale.md')),false);
});
