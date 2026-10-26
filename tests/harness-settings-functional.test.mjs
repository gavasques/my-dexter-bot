import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {isAbsolute,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// One delivery flow, optionally resolved entirely inside the freshly assembled app runtime.
const packageRoot=process.env.DEXTER_PACKAGED_HOST_DIR;
if(packageRoot!==undefined&&!isAbsolute(packageRoot))throw new Error('DEXTER_PACKAGED_HOST_DIR must be absolute.');
const load=relative=>import(pathToFileURL(join(packageRoot??resolve('.'),packageRoot===undefined?relative:
 relative.replace(/^packages\/([^/]+)\//,'node_modules/@dexter/$1/'))).href);
const [{HostServices},{HarnessOperationSurface,HARNESS_OPERATION_DESTINATION},{createHostApp},guide]=await Promise.all([
 load('packages/cli/dist/host-services.js'),load('packages/cli/dist/harness-operation-surface.js'),
 load('packages/hub/dist/http.js'),load('packages/context/dist/index.js'),
]);
const refused=error=>['invalid_input','forbidden','conflict','unauthorized','unavailable'].includes(error?.code);
const hash=text=>createHash('sha256').update(text,'utf8').digest('hex');
const quotedDocument=(input,name)=>{
 const line=input.split('\n').find(line=>line.startsWith(`${name}.md is `));
 assert.ok(line);return JSON.parse(line.slice(line.indexOf(': ')+2));
};
const bounded=async promise=>{
 let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Synthetic settings turn did not open.')),5000);})]);}
 finally{clearTimeout(timer);}
};

test('configuration manual and own-bot settings use owner approval, exact CAS, isolation and real next-turn context', {timeout:30_000},async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'dexter-harness-settings-')));
 let services,surface;const turns=[],observed=[],observedTurnIds=[],extraSurfaces=[],opened=Promise.withResolvers(),release=Promise.withResolvers();
 const makeDriver=engine=>({id:engine,capabilities:{resume:true,interrupt:true,fork:false,steer:false},
  status:async()=>({engine,installed:true,authentication:'unverified',billing:'unknown'}),
  open:async threadId=>({threadId,nativeCursor:'synthetic-settings-only'}),
  async *turn(session,turnId,input){observed.push(input);observedTurnIds.push(turnId);
   if(observed.length===1){opened.resolve();await release.promise;}
   yield{type:'text.delta',threadId:session.threadId,turnId,text:'Synthetic settings reply'};
   yield{type:'turn.completed',threadId:session.threadId,turnId,usage:{}};
  },respondToTool:async()=>{},interrupt:async()=>{},close:async()=>{}});
 try{
  services=new HostServices({dataDir:join(root,'host'),enableEngines:true,enableMcp:true,
   engineCommands:{codex:'/usr/bin/false'},makeDriver,engineCatalog:()=>[{id:'codex',available:true,defaultModel:'synthetic-model',
    models:[{id:'synthetic-model',reasoningEfforts:[],speeds:[]}],reasoningEfforts:[],speeds:[]}]});
  assert.equal(services.memoryClient,undefined);
  const app=createHostApp(services.store,{runtime:services.runtime,skills:services.skillsHttp,botDocuments:services.botDocumentsHttp});
  const request=(method,path,body)=>app.request(`http://127.0.0.1${path}`,{method,headers:{'content-type':'application/json'},
   ...(body===undefined?{}:{body:JSON.stringify(body)})});
  const decide=async(receipt,decision='allow',requestHash=receipt.requestHash)=>{
   const response=await request('POST',`/v1/actions/${receipt.actionId}/decisions`,{decision,requestHash});
   return response.status;
  };
  const actor=services.store.createBot({name:'Settings actor',profileId:'synthetic',engine:'codex'});
  const other=services.store.createBot({name:'Private specialist',profileId:'synthetic',engine:'codex'});
  services.botDocumentsHttp.compareAndSet(other.id,{expectedRevision:0,soul:'OTHER_PRIVATE_SOUL',user:'OTHER_PRIVATE_USER',memory:'OTHER_PRIVATE_MEMORY'});
  const peerBefore=services.botDocumentsHttp.read(other.id);
  surface=new HarnessOperationSurface({store:services.store,base:services.gateway,catalog:services.engineCatalog,
   runtime:()=>services.runtime,skills:()=>services.skillsHttp,documents:()=>services.botDocumentsHttp,effectiveSkills:()=>[]});
  const thread=services.store.createThread(actor.id),{turn}=services.runtime.startTurn(thread.id,{clientRequestId:'settings-current-turn',content:'Synthetic configuration request'});
  turns.push(turn);await bounded(opened.promise);assert.equal(services.store.getTurn(turn.id).state,'running');
  const token=surface.issueCapability({turnId:turn.id}).token;
  const call=(name,callId,args={})=>surface.call(token,{connectionId:HARNESS_OPERATION_DESTINATION,
   tool:`dexter.harness.${name}`,callId,arguments:args});
  const approved=async(name,callId,args)=>{
   const pending=await call(name,callId,args);assert.equal(pending.status,'awaiting_approval');
   assert.equal(await decide(pending),200);return call(name,callId,args);
  };

  // Progressive catalog is code-owned, bounded and complete; neither listing nor reading grants tools.
  const views=surface.listTools(token),configuration=views.find(view=>view.name==='dexter.harness.configuration');
  assert.ok(configuration);assert.equal(configuration.requiresApproval,false);
  assert.equal(services.store.summary().counts.grants,0);
  const index=await call('configuration','configuration-index');assert.equal(index.status,'succeeded');
  assert.deepEqual(configuration.inputSchema.properties.page.enum,guide.APP_CONFIGURATION_GUIDE_PAGES.map(page=>page.id));
  assert.deepEqual(index.result.pages,guide.APP_CONFIGURATION_GUIDE_PAGES);
  assert.equal(new Set(index.result.pages.map(page=>page.id)).size,index.result.pages.length);
  assert.ok(index.result.pages.length>0);
  for(const page of index.result.pages){
   const loaded=await call('configuration',`page-${page.id}`,{page:page.id});
   assert.equal(loaded.result.id,page.id);assert.equal(hash(loaded.result.markdown),page.sha256);
   assert.equal(loaded.result.markdown.length,page.characters);
   assert.deepEqual(loaded.result.fields.map(field=>field.id),page.fields.map(field=>field.id));
   assert.ok(loaded.result.fields.length>0);
   assert.ok(!JSON.stringify(loaded.result).includes(root));
  }
  const topics=await call('guide','guide-index');assert.ok(topics.result.topics.some(topic=>topic.id==='configuration'));
  assert.deepEqual(views.find(view=>view.name==='dexter.harness.guide').inputSchema.properties.topic.enum,guide.HARNESS_GUIDE_TOPICS.map(topic=>topic.id));
  const configurationTopic=await call('guide','guide-configuration',{topic:'configuration'});
  assert.equal(hash(configurationTopic.result.markdown),configurationTopic.result.sha256);
  await assert.rejects(call('configuration','absent-page',{page:'not-a-configuration-page'}),refused);
  assert.equal(services.store.summary().counts.grants,0);

  const {automation:initialAutomation,...initial}=(await call('documents.read','initial')).result.documents;
  assert.equal(initialAutomation.updates,'automatic');
  // Exact review/CAS campaign honors the owner's explicit Ask choice.
  services.store.setGrant({botId:actor.id,tool:'dexter.harness.documents.update',destination:HARNESS_OPERATION_DESTINATION,policy:'ask'});
  assert.deepEqual(initial,{botId:actor.id,revision:0,soul:'',user:'',memory:'',updatedAt:null,memoryHead:null});
  await assert.rejects(call('documents.read','spoof-read',{botId:other.id}),refused);
  const deniedArgs={expectedRevision:0,document:'MEMORY',markdown:'DENIED_SYNTHETIC_MEMORY'};
  const denied=await call('documents.update','deny-doc',deniedArgs);assert.equal(denied.status,'awaiting_approval');
  const visible=await(await request('GET',`/v1/actions/${denied.actionId}`)).json();
  assert.equal(visible.request.botId,actor.id);assert.equal(visible.request.threadId,thread.id);
  assert.deepEqual(visible.request.arguments.input,deniedArgs);assert.equal(visible.request.arguments.pin.revision,0);
  assert.equal(visible.request.arguments.pin.memoryHash,hash(''));
  assert.equal(await decide(denied,'allow','0'.repeat(64)),409);
  assert.equal(await decide(denied,'deny'),200);assert.equal((await call('documents.update','deny-doc',deniedArgs)).status,'denied');
  assert.deepEqual((({automation,...snapshot})=>snapshot)(services.botDocumentsHttp.read(actor.id)),initial);
  for(const expectedRevision of [-1,0.5,Number.MAX_SAFE_INTEGER,'0'])
   await assert.rejects(call('documents.update',`invalid-revision-${expectedRevision}`,{...deniedArgs,expectedRevision}),refused);
  await assert.rejects(call('documents.update','foreign-doc',{...deniedArgs,botId:other.id}),refused);
  await assert.rejects(call('documents.update','secret-doc',{...deniedArgs,markdown:'api_key='+'synthetic'.repeat(5)}),refused);
  await assert.rejects(call('documents.update','malformed-doc',{...deniedArgs,markdown:'\ud800'}),refused);

  const soulArgs={expectedRevision:0,document:'SOUL',markdown:'OWN_SYNTHETIC_SOUL'};
  const soul=await approved('documents.update','save-soul',soulArgs);assert.equal(soul.status,'succeeded');
  assert.equal(soul.result.appliesNextTurn,true);assert.equal(soul.result.updatedDocument,'SOUL');
  assert.equal(soul.result.documents.revision,1);assert.equal(soul.result.documents.user,'');
  assert.equal((await call('documents.update','save-soul',soulArgs)).actionId,soul.actionId);
  assert.equal(services.botDocumentsHttp.read(actor.id).revision,1,'replay is one-shot even after revision advances');
  await assert.rejects(call('documents.update','save-soul',{...soulArgs,markdown:'Changed'}),error=>error.code==='conflict');

  const staleArgs={expectedRevision:1,document:'MEMORY',markdown:'STALE_PROPOSED_MEMORY'};
  const stale=await call('documents.update','stale-doc',staleArgs);
  services.botDocumentsHttp.compareAndSet(actor.id,{expectedRevision:1,soul:'OWN_SYNTHETIC_SOUL',user:'OWNER_SYNTHETIC_USER',memory:'OWNER_INTERVENING_MEMORY'});
  assert.equal(await decide(stale),200);assert.equal((await call('documents.update','stale-doc',staleArgs)).status,'blocked');
  assert.equal(services.botDocumentsHttp.read(actor.id).memory,'OWNER_INTERVENING_MEMORY');
  const memoryArgs={expectedRevision:2,document:'MEMORY',markdown:'OWN_APPROVED_MEMORY'};
  const memory=await approved('documents.update','save-memory',memoryArgs);assert.equal(memory.status,'succeeded');
  assert.equal(memory.result.documents.user,'OWNER_SYNTHETIC_USER');assert.equal(memory.result.documents.soul,'OWN_SYNTHETIC_SOUL');
  const clearArgs={expectedRevision:3,document:'USER',markdown:''};
  const cleared=await approved('documents.update','clear-user',clearArgs);assert.equal(cleared.status,'succeeded');
  assert.equal(cleared.result.documents.user,'');assert.equal(cleared.result.documents.memory,'OWN_APPROVED_MEMORY');

  const profileArgs={expectedRevision:0,name:'Configured synthetic bot',roleDescription:'Synthetic focused role',avatarEmoji:'🎯'};
  const profile=await approved('bots.update','save-profile',profileArgs);assert.equal(profile.status,'succeeded');
  assert.equal(profile.result.bot.id,actor.id);assert.equal(profile.result.bot.name,profileArgs.name);
  assert.equal(profile.result.bot.roleDescription,profileArgs.roleDescription);assert.equal(profile.result.bot.avatarEmoji,'🎯');
  assert.equal(profile.result.appliesNextTurn,true);
  assert.equal(profile.result.bot.isMaster,false);assert.equal(profile.result.bot.canSeeBots,false);
  assert.equal(profile.result.bot.canSendActions,false);assert.equal(profile.result.bot.canReceiveOrders,false);
  assert.equal((await call('bots.update','save-profile',profileArgs)).actionId,profile.actionId);
  assert.equal(services.store.getBot(actor.id).revision,1);
  for(const extra of [{botId:other.id},{isMaster:true},{canSeeBots:true},{canSendActions:true},{canReceiveOrders:true},
   {defaultSelection:{engine:'codex',model:null,reasoningEffort:null,speed:null}}])
   await assert.rejects(call('bots.update',`spoof-profile-${Object.keys(extra)[0]}`,{...profileArgs,expectedRevision:1,...extra}),refused);
  const profileStaleArgs={expectedRevision:1,roleDescription:'STALE_ROLE'};
  const profileStale=await call('bots.update','stale-profile',profileStaleArgs);
  services.store.patchBot(actor.id,{expectedRevision:1,roleDescription:'Owner latest role'});
  assert.equal(await decide(profileStale),200);assert.equal((await call('bots.update','stale-profile',profileStaleArgs)).status,'blocked');
  assert.equal(services.store.getBot(actor.id).roleDescription,'Owner latest role');
  const reset=await approved('bots.update','reset-profile',{expectedRevision:2,roleDescription:'',avatarEmoji:''});
  assert.equal(reset.status,'succeeded');assert.equal(reset.result.bot.roleDescription,'');assert.equal(reset.result.bot.avatarEmoji,null);
  const finalRole=await approved('bots.update','final-role',{expectedRevision:3,roleDescription:'Own configured synthetic role'});
  assert.equal(finalRole.status,'succeeded');

  // A committed document with a lost receipt becomes unknown, and exact replay never writes it again.
  let uncertainWrites=0;
  const uncertainSurface=new HarnessOperationSurface({store:services.store,base:services.gateway,catalog:services.engineCatalog,
   runtime:()=>services.runtime,skills:()=>services.skillsHttp,effectiveSkills:()=>[],documents:()=>({
    ...services.botDocumentsHttp,executeAction:actionId=>{
     uncertainWrites++;services.botDocumentsHttp.executeAction(actionId);throw new Error('Synthetic lost receipt.');
    },
   })});extraSurfaces.push(uncertainSurface);
  const uncertainThread=services.store.createThread(actor.id),{turn:uncertainTurn}=services.store.createTurn(uncertainThread.id,
   {clientRequestId:'uncertain-settings',content:'Synthetic receipt uncertainty'});
  assert.equal(services.store.claimNextTurn(uncertainThread.id).id,uncertainTurn.id);turns.push(uncertainTurn);
  const uncertainToken=uncertainSurface.issueCapability({turnId:uncertainTurn.id}).token;
  const uncertainArgs={expectedRevision:4,document:'MEMORY',markdown:'OWN_APPROVED_MEMORY'};
  const uncertainCall=()=>uncertainSurface.call(uncertainToken,{connectionId:HARNESS_OPERATION_DESTINATION,
   tool:'dexter.harness.documents.update',callId:'unknown-document',arguments:uncertainArgs});
  const uncertainPending=await uncertainCall();assert.equal(uncertainPending.status,'awaiting_approval');
  assert.equal(await decide(uncertainPending),200);const uncertain=await uncertainCall();assert.equal(uncertain.status,'unknown');
  assert.equal(uncertainWrites,1);assert.equal(services.botDocumentsHttp.read(actor.id).revision,5);
  assert.equal((await uncertainCall()).actionId,uncertain.actionId);assert.equal(uncertainWrites,1);
  services.store.finishTurn(uncertainTurn.id,'completed',null);

  // A changed owner grant cannot be bypassed by an already approved action.
  const revokedArgs={expectedRevision:5,document:'MEMORY',markdown:'REVOKED_MEMORY'};
  const revoked=await call('documents.update','revoked-doc',revokedArgs);assert.equal(await decide(revoked),200);
  services.store.setGrant({botId:actor.id,tool:'dexter.harness.documents.update',destination:HARNESS_OPERATION_DESTINATION,policy:'deny'});
  assert.ok(!surface.listTools(token).some(view=>view.name==='dexter.harness.documents.update'));
  await assert.rejects(call('documents.update','revoked-doc',revokedArgs),refused);
  assert.equal(services.botDocumentsHttp.read(actor.id).memory,'OWN_APPROVED_MEMORY');
  assert.deepEqual(services.botDocumentsHttp.read(other.id),peerBefore);
  assert.equal(services.store.getBot(other.id).revision,0);
  assert.ok(!JSON.stringify((await call('status','self-status')).result).includes(other.id));

  // Edits did not rewrite the native context captured before this running turn's actions.
  assert.equal(quotedDocument(observed[0],'SOUL'),'');assert.equal(quotedDocument(observed[0],'USER'),'');assert.equal(quotedDocument(observed[0],'MEMORY'),'');
  const initialProfileLine=observed[0].split('\n').find(line=>line.startsWith('Bot profile (quoted data): '));
  assert.ok(initialProfileLine);assert.deepEqual(JSON.parse(initialProfileLine.slice('Bot profile (quoted data): '.length)),
   {id:actor.id,name:'Settings actor',roleDescription:'',avatarEmoji:null,revision:0});
  release.resolve();assert.equal((await services.runtime.waitForTurn(turn.id,5000)).state,'completed');
  await assert.rejects(call('documents.read','closed-turn'),refused);
  // Exercise actual HostServices turn composition, not a manually assembled prompt.
  const next=services.runtime.startTurn(thread.id,{clientRequestId:'settings-next-turn',content:'Synthetic next-turn settings verification'}).turn;
  assert.equal((await services.runtime.waitForTurn(next.id,5000)).state,'completed');
  // Direct surface calls do not emulate MCP receipt delivery; recovered results can create host turns.
  // Check the explicitly requested next turn rather than assuming only two engine invocations.
  assert.equal(observedTurnIds.filter(id=>id===turn.id).length,1);
  assert.equal(observedTurnIds.filter(id=>id===next.id).length,1);
  const nextInput=observed[observedTurnIds.indexOf(next.id)];
  assert.ok(nextInput.includes('BEGIN DEXTER BUILT-IN HARNESS GUIDE'));
  assert.ok(nextInput.includes('dexter.harness.configuration'));
  const profileLine=nextInput.split('\n').find(line=>line.startsWith('Bot profile (quoted data): '));
  assert.ok(profileLine);
  assert.deepEqual(JSON.parse(profileLine.slice('Bot profile (quoted data): '.length)),{id:actor.id,name:'Configured synthetic bot',
   roleDescription:'Own configured synthetic role',avatarEmoji:null,revision:4});
  assert.equal(quotedDocument(nextInput,'SOUL'),'OWN_SYNTHETIC_SOUL');
  assert.equal(quotedDocument(nextInput,'USER'),'');
  assert.equal(quotedDocument(nextInput,'MEMORY'),'OWN_APPROVED_MEMORY');
  assert.ok(observed.every(input=>!input.includes('OTHER_PRIVATE_')));
 }finally{
  release.resolve();
  for(const extra of extraSurfaces)await extra.close();
  await surface?.close();
  for(const turn of turns)if(services?.store.getTurn(turn.id).state==='running')services.store.finishTurn(turn.id,'completed',null);
  await services?.shutdown();rmSync(root,{recursive:true,force:true});
 }
});
