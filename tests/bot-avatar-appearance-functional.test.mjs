import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync,backup} from 'node:sqlite';
import {deflateSync} from 'node:zlib';
import {HostStore} from '../packages/hub/dist/index.js';
import {HostServices} from '../packages/cli/dist/host-services.js';
import {HarnessOperationSurface,HARNESS_OPERATION_DESTINATION} from '../packages/cli/dist/harness-operation-surface.js';
import {createHostApp} from '../packages/hub/dist/http.js';
import {checkHubExact,checkExactSchema} from '../packages/operations/dist/exact.js';
import {checkFullSchema} from '../packages/operations/dist/full-schemas.js';
import {BOT_AVATAR_APPEARANCES_META_KEY,MAX_BOT_AVATAR_APPEARANCES_METADATA_BYTES,
  BotAvatarAppearanceSchema,botAvatarAppearancesConfigurationJSON} from '../packages/contracts/dist/index.js';

const recipe={version:1,body:'bean',eyes:'focused',colorHex:'#A45BCC',finish:'glass',motion:'subtle'};
const second={version:1,body:'cloud',eyes:'wide',colorHex:'#42C6B5',finish:'flat',motion:'lively'};
const code=name=>error=>error?.code===name;
const refused=error=>['invalid_input','forbidden','conflict','unauthorized'].includes(error?.code);
const directory=t=>{const root=realpathSync(mkdtempSync(join(tmpdir(),'dexter-avatar-recipe-')));
  t.after(()=>rmSync(root,{recursive:true,force:true}));return root;};
function png(){
  const chunk=(type,data)=>{const body=Buffer.concat([Buffer.from(type),data]),head=Buffer.alloc(4),tail=Buffer.alloc(4);let crc=0xffffffff;
    for(const byte of body){crc^=byte;for(let i=0;i<8;i++)crc=(crc&1)?0xedb88320^(crc>>>1):crc>>>1;}
    head.writeUInt32BE(data.length);tail.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([head,body,tail]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(1,0);header.writeUInt32BE(1,4);header[8]=8;header[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),
    chunk('IDAT',deflateSync(Buffer.from([0,17,21,34,255]))),chunk('IEND',Buffer.alloc(0))]);
}
const image=store=>store.uploadAvatarImage({expectedHostID:store.hostId,clientRequestId:randomUUID(),mediaType:'image/png',dataBase64:png().toString('base64')});
function metadata(databasePath){const db=new DatabaseSync(databasePath,{readOnly:true});try{
  return {version:db.prepare('PRAGMA user_version').get().user_version,
    meta:db.prepare('SELECT key,value FROM meta ORDER BY key').all(),bots:db.prepare('SELECT * FROM bots ORDER BY id').all(),
    events:db.prepare('SELECT * FROM events ORDER BY cursor').all(),leases:db.prepare('SELECT * FROM host_lease').all()};
}finally{db.close();}}

test('avatar recipes create atomically, restart, CAS, preserve legacy PNG/emoji and clear explicitly',async t=>{
  const root=directory(t);let store=new HostStore({dataDir:join(root,'host')});t.after(()=>store.close());
  const legacy=store.createBot({name:'Legacy',profileId:'synthetic',engine:'codex'}),asset=image(store);
  const old=store.patchBot(legacy.id,{expectedRevision:0,avatarEmoji:'🦊',avatarImageId:asset.id});
  assert.equal(old.avatarAppearance,null);
  const before=metadata(store.databasePath);assert.ok(!before.meta.some(row=>row.key===BOT_AVATAR_APPEARANCES_META_KEY));
  const created=store.createBot({name:'Recipe',profileId:'synthetic',engine:'codex',avatarAppearance:{...recipe,colorHex:'#a45bcc'}});
  assert.deepEqual(created.avatarAppearance,recipe);assert.equal(created.revision,0);
  assert.equal(store.summary().schemaVersion,16);assert.deepEqual(store.listBots().find(bot=>bot.id===created.id).avatarAppearance,recipe);
  const identity={installationId:store.hostId,ownerId:store.ownerId};store.close();
  store=new HostStore({dataDir:join(root,'host'),existingInstallation:identity});
  assert.deepEqual(store.getBot(created.id).avatarAppearance,recipe);
  const renamed=store.patchBot(created.id,{expectedRevision:0,name:'Preserved'});assert.deepEqual(renamed.avatarAppearance,recipe);
  const preserved=metadata(store.databasePath);
  assert.throws(()=>store.patchBot(created.id,{expectedRevision:0,avatarAppearance:second}),code('conflict'));
  assert.throws(()=>store.patchBot(created.id,{expectedRevision:1,avatarAppearance:{...recipe,version:2}}),code('invalid_input'));
  assert.deepEqual(metadata(store.databasePath),preserved,'stale/invalid input leaves metadata, revisions and events unchanged');
  const selected=store.patchBot(old.id,{expectedRevision:old.revision,avatarImageId:null,avatarAppearance:second});
  assert.equal(selected.avatarImage,null);assert.deepEqual(selected.avatarAppearance,second);assert.equal(selected.avatarEmoji,'🦊');
  assert.equal(selected.revision,old.revision+1);assert.deepEqual(store.readAvatarImage(asset.id).data,png());
  const imported=store.patchBot(selected.id,{expectedRevision:selected.revision,avatarImageId:asset.id,avatarAppearance:null});
  assert.equal(imported.avatarAppearance,null);assert.deepEqual(imported.avatarImage,asset);assert.equal(imported.avatarEmoji,'🦊');
  const cleared=store.patchBot(created.id,{expectedRevision:renamed.revision,avatarAppearance:null});
  assert.equal(cleared.avatarAppearance,null);assert.ok(!metadata(store.databasePath).meta.some(row=>row.key===BOT_AVATAR_APPEARANCES_META_KEY));
  const unchanged=store.patchBot(imported.id,{expectedRevision:imported.revision,roleDescription:'Metadata only'});
  assert.deepEqual(unchanged.avatarImage,asset);assert.equal(unchanged.avatarEmoji,'🦊');assert.equal(unchanged.avatarAppearance,null);
});

test('canonical SQLite backup admits optional hub16 recipe metadata and leaves historical admission closed',async t=>{
  const root=directory(t),store=new HostStore({dataDir:join(root,'host')});t.after(()=>store.close());
  const first=store.createBot({name:'One',profileId:'synthetic',engine:'codex',avatarAppearance:recipe});
  const other=store.createBot({name:'Two',profileId:'synthetic',engine:'codex',avatarAppearance:second});
  const db=new DatabaseSync(store.databasePath,{readOnly:true});t.after(()=>db.close());
  const identity={installationId:store.hostId,ownerId:store.ownerId};
  assert.deepEqual(checkHubExact(db),identity);assert.deepEqual(checkFullSchema(db,'hub'),identity);
  const encoded=db.prepare('SELECT value FROM meta WHERE key=?').get(BOT_AVATAR_APPEARANCES_META_KEY).value;
  assert.equal(encoded,botAvatarAppearancesConfigurationJSON({version:1,bots:{[other.id]:second,[first.id]:recipe}}));
  const copied=join(root,'backup.sqlite');await backup(db,copied);const snapshot=new DatabaseSync(copied);
  try{
    assert.deepEqual(checkHubExact(snapshot),identity);
    assert.equal(snapshot.prepare('SELECT value FROM meta WHERE key=?').get(BOT_AVATAR_APPEARANCES_META_KEY).value,encoded);
    snapshot.exec('PRAGMA user_version=15');assert.throws(()=>checkExactSchema(snapshot,'hub15'),code('unsupported_schema'));
  }finally{snapshot.close();}
});

test('invalid, noncanonical, oversized and foreign recipe metadata fail closed without open side effects',async t=>{
  const cases=[
    ['unsupported version',botId=>JSON.stringify({version:2,bots:{[botId]:recipe}}),'unsupported_schema'],
    ['unsupported body',botId=>botAvatarAppearancesConfigurationJSON({version:1,bots:{[botId]:{...recipe,body:'star'}}}),'unsupported_schema'],
    ['lowercase color',botId=>botAvatarAppearancesConfigurationJSON({version:1,bots:{[botId]:{...recipe,colorHex:'#a45bcc'}}}),'unsupported_schema'],
    ['unreviewed field',botId=>JSON.stringify({version:1,bots:{[botId]:{...recipe,url:'https://synthetic.invalid'}}}),'unsupported_schema'],
    ['noncanonical order',botId=>JSON.stringify({bots:{[botId]:recipe},version:1}),'unsupported_schema'],
    ['invalid JSON',()=>'{','unsupported_schema'],
    ['oversized',()=> ' '.repeat(MAX_BOT_AVATAR_APPEARANCES_METADATA_BYTES+1),'unsupported_schema'],
    ['missing bot',()=>botAvatarAppearancesConfigurationJSON({version:1,bots:{bot_missing:recipe}}),'reference_broken'],
    ['foreign owner',botId=>botAvatarAppearancesConfigurationJSON({version:1,bots:{[botId]:recipe}}),'reference_broken'],
  ];
  const root=directory(t);
  for(const [label,encode,expected] of cases){
    const dataDir=join(root,label),seed=new HostStore({dataDir});
    const bot=seed.createBot({name:'Synthetic',profileId:'synthetic',engine:'codex'}),identity={installationId:seed.hostId,ownerId:seed.ownerId};
    const databasePath=seed.databasePath;seed.close();
    const db=new DatabaseSync(databasePath);
    try{
      db.prepare('INSERT INTO meta VALUES(?,?)').run(BOT_AVATAR_APPEARANCES_META_KEY,encode(bot.id));
      if(label==='foreign owner')db.prepare('UPDATE bots SET owner_id=? WHERE id=?').run('synthetic_foreign',bot.id);
      assert.throws(()=>checkHubExact(db),code(expected),label);
    }finally{db.close();}
    const before=metadata(databasePath),digest=createHash('sha256').update(readFileSync(databasePath)).digest('hex');
    assert.throws(()=>new HostStore({dataDir,existingInstallation:identity}),code('conflict'),label);
    assert.throws(()=>new HostStore({dataDir}),code('conflict'),label);
    assert.deepEqual(metadata(databasePath),before,label);
    assert.equal(createHash('sha256').update(readFileSync(databasePath)).digest('hex'),digest,label);
  }
});

const catalog=()=>[{id:'codex',available:true,installed:true,adapterSupported:true,defaultModel:null,
  reasoningEfforts:[],speeds:[],models:[]}];
const driver=id=>({id,capabilities:{resume:true,interrupt:true,fork:false,steer:false},status:async()=>({engine:id,installed:true}),
  open:async threadId=>({threadId,nativeCursor:'synthetic-avatar'}),async *turn(session,turnId){yield{type:'turn.completed',threadId:session.threadId,turnId,usage:{}};},
  respondToTool:async()=>{},interrupt:async()=>{},close:async()=>{}});
function harness(t){
  const root=directory(t),services=new HostServices({dataDir:join(root,'host'),enableEngines:true,enableMcp:true,engineCommands:{codex:'/usr/bin/false'},makeDriver:driver,engineCatalog:catalog});
  const app=createHostApp(services.store,{runtime:services.runtime});
  const actor=services.store.createBot({name:'Actor',profileId:'synthetic',engine:'codex'});
  const peer=services.store.createBot({name:'Peer',profileId:'synthetic',engine:'codex'});
  const surface=new HarnessOperationSurface({store:services.store,base:services.gateway,catalog,runtime:()=>services.runtime});
  const thread=services.store.createThread(actor.id),{turn}=services.store.createTurn(thread.id,{clientRequestId:'synthetic-avatar-turn',content:'Synthetic'});
  t.after(async()=>{await surface.close();if(services.store.getTurn(turn.id).state==='running')services.store.finishTurn(turn.id,'completed',null);await services.shutdown();});
  services.store.claimNextTurn(thread.id);
  const token=surface.issueCapability({turnId:turn.id}).token;
  const call=(name,id,args={})=>surface.call(token,{connectionId:HARNESS_OPERATION_DESTINATION,tool:`dexter.harness.${name}`,callId:id,arguments:args});
  const decide=async(receipt,decision='allow')=>{const response=await app.request(`http://127.0.0.1/v1/actions/${receipt.actionId}/decisions`,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({decision,requestHash:receipt.requestHash})});assert.equal(response.status,200);};
  return{root,services,actor,peer,surface,turn,call,decide};
}

test('harness avatar changes derive own identity, pin structured input, deny/stale/replay and explicit PNG clear atomically',async t=>{
  const f=harness(t),store=f.services.store,asset=image(store);
  let actor=store.patchBot(f.actor.id,{expectedRevision:0,avatarEmoji:'🦊',avatarImageId:asset.id});
  const args={expectedRevision:actor.revision,avatarAppearanceJson:JSON.stringify({...recipe,colorHex:'#a45bcc'}),clearAvatarImage:true};
  const denied=await f.call('bots.update','denied',args);
  assert.equal(denied.status,'awaiting_approval');
  const proposal=store.getAction(denied.actionId);assert.equal(proposal.request.botId,actor.id);
  assert.deepEqual(proposal.request.arguments.input,{expectedRevision:actor.revision,avatarAppearance:recipe,avatarImageId:null});
  assert.ok(!('avatarAppearanceJson' in proposal.request.arguments.input));assert.equal(proposal.request.arguments.pin.revision,actor.revision);
  await f.decide(denied,'deny');assert.equal((await f.call('bots.update','denied',args)).status,'denied');
  assert.deepEqual(store.getBot(actor.id),actor);
  const stale=await f.call('bots.update','stale',args);actor=store.patchBot(actor.id,{expectedRevision:actor.revision,name:'Owner changed'});
  await f.decide(stale);assert.equal((await f.call('bots.update','stale',args)).status,'blocked');assert.equal(store.getBot(actor.id).avatarAppearance,null);
  const behindArgs={expectedRevision:actor.revision,avatarAppearanceJson:JSON.stringify(recipe),clearAvatarImage:false};
  const behind=await f.call('bots.update','behind',behindArgs);await f.decide(behind);
  const saved=await f.call('bots.update','behind',behindArgs);assert.equal(saved.status,'succeeded');
  assert.equal(saved.result.bot.activeAvatarKind,'image');assert.equal(saved.result.bot.avatarImageId,asset.id);assert.deepEqual(saved.result.bot.avatarAppearance,recipe);
  assert.ok(!JSON.stringify(saved.result).includes('dataBase64'));
  const revision=saved.result.bot.revision;
  assert.equal((await f.call('bots.update','behind',behindArgs)).actionId,saved.actionId);assert.equal(store.getBot(actor.id).revision,revision);
  const selectArgs={expectedRevision:revision,avatarAppearanceJson:JSON.stringify(second),clearAvatarImage:true};
  const select=await f.call('bots.update','select',selectArgs);await f.decide(select);
  const selected=await f.call('bots.update','select',selectArgs);assert.equal(selected.status,'succeeded');assert.equal(selected.result.bot.activeAvatarKind,'appearance');
  assert.equal(selected.result.bot.avatarImageId,null);assert.deepEqual(selected.result.bot.avatarAppearance,second);assert.equal(selected.result.bot.revision,revision+1);
  assert.equal((await f.call('bots.update','select',selectArgs)).actionId,selected.actionId);assert.equal(store.getBot(actor.id).revision,revision+1);
  assert.equal(store.getBot(f.peer.id).avatarAppearance,null);assert.deepEqual(store.readAvatarImage(asset.id).data,png());
  await assert.rejects(f.call('bots.update','spoof',{...selectArgs,botId:f.peer.id}),refused);
  for(const invalid of ['null','{',JSON.stringify({...recipe,version:2}),JSON.stringify({...recipe,eyes:'unknown'}),JSON.stringify({...recipe,colorHex:'red'}),JSON.stringify({...recipe,bytes:'fake'}),' '.repeat(513)])
    await assert.rejects(f.call('bots.update',`invalid-${randomUUID()}`,{expectedRevision:revision+1,avatarAppearanceJson:invalid}),code('invalid_input'));
  const clearArgs={expectedRevision:revision+1,avatarAppearanceJson:''};const clear=await f.call('bots.update','clear',clearArgs);await f.decide(clear);
  const cleared=await f.call('bots.update','clear',clearArgs);assert.equal(cleared.result.bot.avatarAppearance,null);assert.equal(cleared.result.bot.activeAvatarKind,'emoji');
});

test('owner handoff settles the frozen recipe proposal once after the engine turn ends',async t=>{
  const f=harness(t),args={expectedRevision:f.actor.revision,avatarAppearanceJson:JSON.stringify(recipe)};
  const pending=await f.call('bots.update','handoff',args);f.services.store.finishTurn(f.turn.id,'completed',null);
  await f.decide(pending);const approved=f.services.store.getAction(pending.actionId);
  const first=await f.surface.continueOwnerAction(approved);assert.equal(first.state,'succeeded');assert.equal(first.authorization.source,'exact_owner');
  assert.deepEqual(first.result.bot.avatarAppearance,recipe);assert.equal(first.result.bot.revision,1);
  const replay=await f.surface.continueOwnerAction(f.services.store.getAction(first.id));assert.equal(replay.id,first.id);
  assert.equal(f.services.store.getBot(f.actor.id).revision,1);assert.deepEqual(f.services.store.getBot(f.actor.id).avatarAppearance,recipe);
});

test('harness creation persists a canonical avatar recipe with basic bot authority and replay deduplication',async t=>{
  const f=harness(t),args={name:'Recipe specialist',engine:'codex',avatarAppearanceJson:JSON.stringify({...recipe,colorHex:'#a45bcc'})};
  const before=f.services.store.listBots().length,pending=await f.call('bots.create','create',args);assert.equal(pending.status,'awaiting_approval');
  await f.decide(pending);const made=await f.call('bots.create','create',args);assert.equal(made.status,'succeeded');
  const bot=f.services.store.getBot(made.result.bot.id);assert.deepEqual(bot.avatarAppearance,recipe);assert.equal(bot.profileId,f.actor.profileId);
  assert.equal(bot.canSeeBots,false);assert.equal(bot.canSendActions,false);assert.equal(bot.canReceiveOrders,false);assert.equal(bot.isMaster,false);
  assert.deepEqual(made.result.grantedTools,[]);assert.equal((await f.call('bots.create','create',args)).actionId,made.actionId);
  assert.equal(f.services.store.listBots().length,before+1);
  assert.equal(BotAvatarAppearanceSchema.safeParse({...recipe,colorHex:'#a45bcc'}).data.colorHex,'#A45BCC');
});
