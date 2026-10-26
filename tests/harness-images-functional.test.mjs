import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,createSecretKey,generateKeyPairSync,randomBytes,randomUUID,sign} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {isAbsolute,join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import {deflateSync} from 'node:zlib';

const packageRoot=process.env.DEXTER_PACKAGED_HOST_DIR;
if(packageRoot!==undefined&&!isAbsolute(packageRoot))throw new Error('DEXTER_PACKAGED_HOST_DIR must be absolute.');
const load=relative=>import(pathToFileURL(join(packageRoot??resolve('.'),packageRoot===undefined?relative:
 relative.replace(/^packages\/([^/]+)\//,'node_modules/@dexter/$1/'))).href);
const [{HostServices},{HostStore,ConversationRuntime},{createHostApp,createAuthorizedHostRouter},engines,operations]=await Promise.all([
 load('packages/cli/dist/host-services.js'),load('packages/hub/dist/index.js'),load('packages/hub/dist/http.js'),
 load('packages/engines/dist/index.js'),load('packages/operations/dist/index.js'),
]);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const CRC=new Uint32Array(256);for(let i=0;i<256;i++){let n=i;for(let j=0;j<8;j++)n=(n&1)?0xedb88320^(n>>>1):n>>>1;CRC[i]=n>>>0;}
const crc=data=>{let n=0xffffffff;for(const byte of data)n=CRC[(n^byte)&255]^(n>>>8);return(n^0xffffffff)>>>0;};
const chunk=(type,data)=>{const body=Buffer.concat([Buffer.from(type),data]),head=Buffer.alloc(4),tail=Buffer.alloc(4);head.writeUInt32BE(data.length);tail.writeUInt32BE(crc(body));return Buffer.concat([head,body,tail]);};
const png=red=>{const header=Buffer.alloc(13);header.writeUInt32BE(1,0);header.writeUInt32BE(1,4);header[8]=8;header[9]=6;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from([0,red,21,34,255]))),chunk('IEND',Buffer.alloc(0))]);};
async function until(predicate){const deadline=Date.now()+10_000;while(!predicate()){if(Date.now()>=deadline)throw new Error('Synthetic image flow did not drain.');await new Promise(done=>setTimeout(done,10));}}
const headers={'content-type':'application/json'};
const request=(app,path,body,extra={})=>app.request(`http://127.0.0.1${path}`,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)});
const queryVersion=path=>{const db=new DatabaseSync(path,{readOnly:true});try{return db.prepare('PRAGMA user_version').get().user_version;}finally{db.close();}};

function seedSeven(dataDir,sql){
 mkdirSync(dataDir,{mode:0o700});const db=new DatabaseSync(join(dataDir,'dexter.sqlite'));
 const identity={installationId:'synthetic-images-installation',ownerId:'synthetic-images-owner'};
 const selection=JSON.stringify({engine:'claude',model:null,reasoningEffort:null,speed:null});
 try{
  db.exec(sql);db.exec('PRAGMA user_version=7;PRAGMA journal_mode=WAL;');
  for(const [key,value]of[['host_id',identity.installationId],['owner_id',identity.ownerId]])db.prepare('INSERT INTO meta(key,value)VALUES(?,?)').run(key,value);
  db.prepare(`INSERT INTO host_authority(id,installation_id,owner_id,epoch,state,directory,directory_ino,provenance,updated_at)
   VALUES(1,?,?,1,'active',?,?,'genesis',1)`).run(identity.installationId,identity.ownerId,dataDir,statSync(dataDir,{bigint:true}).ino.toString());
  db.prepare('INSERT INTO profiles VALUES(?,?,1)').run('synthetic-profile',identity.ownerId);
  db.prepare(`INSERT INTO bots(id,owner_id,profile_id,name,engine,created_at,default_selection)VALUES(?,?,?,'Legacy synthetic','claude',1,?)`)
   .run('bot_syntheticLegacy',identity.ownerId,'synthetic-profile',selection);
  db.prepare('INSERT INTO threads VALUES(?,?,1)').run('thread_syntheticLegacy','bot_syntheticLegacy');
  db.prepare('INSERT INTO thread_engine_selections(thread_id,selection)VALUES(?,?)').run('thread_syntheticLegacy',selection);
  db.prepare("INSERT INTO thread_sessions(thread_id,engine,created_at,updated_at)VALUES(?,'claude',1,1)").run('thread_syntheticLegacy');
  db.prepare("INSERT INTO messages(id,thread_id,client_message_id,role,content,created_at)VALUES(?,?,?,'user',?,1)")
   .run('synthetic-legacy-message','thread_syntheticLegacy','turn-in:synthetic-legacy-turn','Legacy exact text');
  db.prepare(`INSERT INTO turns(id,thread_id,bot_id,engine,client_request_id,input_hash,input_message_id,state,created_at,started_at,updated_at,finished_at,selection)
   VALUES(?,?,?,'claude',?,?,?,'completed',1,1,1,1,?)`).run('synthetic-legacy-turn','thread_syntheticLegacy','bot_syntheticLegacy','legacy-replay',sha('Legacy exact text'),'synthetic-legacy-message',selection);
  // A historical ordinary turn still carries its exact queued acceptance receipt (data=NULL).
  // Seed the canonical lifecycle rather than weakening the production replay/source fence.
  const event=db.prepare('INSERT INTO turn_events(turn_id,thread_id,kind,text,data,created_at)VALUES(?,?,?,NULL,?,1)');
  for(const [kind,data]of[['turn.queued',null],['turn.started',null],['turn.completed',JSON.stringify({code:null,outputMessageId:null})]])
   event.run('synthetic-legacy-turn','thread_syntheticLegacy',kind,data);
 }finally{db.close();}
 return identity;
}

// This CLI is only a private synthetic subprocess. It never opens an account, provider, native config or personal file.
const fixtureSource=String.raw`
import {createInterface} from 'node:readline';
import {createHash} from 'node:crypto';
import {readFileSync,statSync} from 'node:fs';
import {relative} from 'node:path';
const argv=process.argv.slice(2),sha=data=>createHash('sha256').update(data).digest('hex'),send=value=>console.log(JSON.stringify(value));
if(argv.includes('--version')){console.log('synthetic images CLI 1.0.0');process.exit(0);}
if(argv.includes('auth')){send({loggedIn:true,authMethod:'claude.ai'});process.exit(0);}
const codex=argv.includes('app-server'),nativeThread='synthetic-image-thread',nativeTurn='synthetic-image-turn';
const lines=createInterface({input:process.stdin});
lines.on('line',line=>{
 const msg=JSON.parse(line),reply=result=>send({id:msg.id,result});
 if(!codex){
  if(msg.type!=='user')throw new Error('fixture expects user input');
  const content=msg.message.content;if(!Array.isArray(content))throw new Error('fixture expects image content');
  const texts=content.filter(item=>item.type==='text').map(item=>item.text).join('\n');
  const images=content.filter(item=>item.type==='image').map(item=>{
   if(item.source.type!=='base64'||item.source.media_type!=='image/png')throw new Error('fixture expects PNG base64');
   const data=Buffer.from(item.source.data,'base64');if(data.toString('base64')!==item.source.data)throw new Error('fixture expects canonical base64');
   if(texts.includes(item.source.data))throw new Error('fixture refuses image-as-text');return{sha256:sha(data),bytes:data.length};
  });
  const sid=argv[argv.indexOf(argv.includes('--resume')?'--resume':'--session-id')+1];
  send({type:'system',subtype:'init',session_id:sid});
  send({type:'result',subtype:'success',is_error:false,result:JSON.stringify({provider:'claude',wire:'base64-image',images,wrappedContext:texts.includes('BEGIN OWNER-AUTHORED BOT DOCUMENTS')}),usage:{input_tokens:1,output_tokens:1}});return;
 }
 if(msg.method==='initialize'){reply({});return;}
 if(msg.method==='account/read'){reply({account:{type:'chatgpt'}});return;}
 if(msg.method==='config/read'){reply({config:{mcp_servers:{},developer_instructions:''}});return;}
 if(msg.method==='thread/start'||msg.method==='thread/resume'){reply({thread:{id:nativeThread},instructionSources:[]});return;}
 if(msg.method==='turn/start'){
  const text=msg.params.input.filter(item=>item.type==='text').map(item=>item.text).join('\n');
  const images=msg.params.input.filter(item=>item.type==='localImage').map(item=>{
   const stat=statSync(item.path);const rel=relative(process.cwd(),item.path);if(rel.startsWith('..')||!rel.includes('.dexter-images-')||!stat.isFile()||(stat.mode&0o777)!==0o600)throw new Error('fixture expects owned PNG');
   const data=readFileSync(item.path);if(text.includes(data.toString('base64')))throw new Error('fixture refuses image-as-text');return{sha256:sha(data),bytes:data.length};
  });
  reply({turn:{id:nativeTurn}});
  send({method:'item/agentMessage/delta',params:{threadId:nativeThread,turnId:nativeTurn,delta:JSON.stringify({provider:'codex',wire:'localImage',images,wrappedContext:text.includes('BEGIN OWNER-AUTHORED BOT DOCUMENTS')})}});
  send({method:'turn/completed',params:{threadId:nativeThread,turn:{id:nativeTurn,status:'completed'}}});return;
 }
 if(msg.method==='turn/interrupt'){reply({});send({method:'turn/completed',params:{threadId:nativeThread,turn:{id:nativeTurn,status:'interrupted'}}});return;}
 if(msg.id!==undefined)reply({});
});
`;

// One focal delivery case: real schema migration/API/WorkspaceDriver/native protocols/checkpoint with synthetic images.
test('pasted PNG attachments persist, bind to their own turn, reach both native image protocols and survive schema8 transfer',{timeout:45_000},async(t)=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'dexter-harness-images-'))),dataDir=join(root,'host'),fixture=join(root,'image-cli.mjs');
 const first=png(17),second=png(29),identity=seedSeven(dataDir,operations.EXACT_SCHEMAS.hub7.sql);
 writeFileSync(fixture,fixtureSource,{mode:0o600});let store,services,coordinator,destinationStore,unsupportedRuntime;const observedPaths=[];
 try{
  assert.throws(()=>new HostStore({dataDir,existingInstallation:{...identity,ownerId:'wrong-synthetic-owner'}}),error=>error.code==='forbidden');
  assert.equal(queryVersion(join(dataDir,'dexter.sqlite')),7,'identity refusal changes no historical schema');
  store=new HostStore({dataDir,existingInstallation:identity});assert.equal(queryVersion(store.databasePath),8);
  assert.equal(store.createTurn('thread_syntheticLegacy',{clientRequestId:'legacy-replay',content:'Legacy exact text'}).created,false);
  assert.deepEqual(store.listMessages('thread_syntheticLegacy')[0].attachments,[]);
  const firstId=randomUUID(),attachment=store.uploadImageAttachment('thread_syntheticLegacy',{clientAttachmentId:firstId,mediaType:'image/png',dataBase64:first.toString('base64')});
  assert.equal(attachment.id,firstId);assert.equal(attachment.sha256,sha(first));assert.equal(attachment.bytes,first.length);
  const own=store.createTurn('thread_syntheticLegacy',{clientRequestId:'image-only-queued',content:'',attachmentIds:[firstId]});
  assert.equal(own.turn.state,'queued');assert.equal(store.createTurn('thread_syntheticLegacy',{clientRequestId:'image-only-queued',content:'',attachmentIds:[firstId]}).created,false);
  assert.throws(()=>store.createTurn('thread_syntheticLegacy',{clientRequestId:'image-only-queued',content:'changed',attachmentIds:[firstId]}),error=>error.code==='conflict');
  store.cancelQueuedTurn(own.turn.id);store.close();store=undefined;

  const makeDriver=(engine,options)=>{
   const Driver=engine==='claude'?engines.ClaudeCliDriver:engines.CodexAppServerDriver;
   const driver=new Driver({...options,command:process.execPath,prefixArgs:[fixture],requestTimeoutMs:2000,turnTimeoutMs:4000,killGraceMs:20});
   const nativeTurn=driver.turn.bind(driver);
   driver.turn=(session,turnId,input,signal,selection,images)=>{
    assert.ok(images.length>0);for(const image of images){assert.equal(sha(image.data),image.sha256);assert.equal(sha(readFileSync(image.localPath)),image.sha256);observedPaths.push(image.localPath);}
    return nativeTurn(session,turnId,input,signal,selection,images);
   };return driver;
  };
  services=new HostServices({dataDir,existingInstallation:identity,enableEngines:true,enableMcp:false,makeDriver,
   engineCommands:{claude:'/usr/bin/false',codex:'/usr/bin/false'},engineCatalog:()=>[]});
  const app=createHostApp(services.store,{runtime:services.runtime}),storeNow=services.store;
  const actor=storeNow.getBot('bot_syntheticLegacy'),thread=storeNow.getThread('thread_syntheticLegacy');
  const documents=services.context.compareAndSetBotDocuments(actor.id,{expectedRevision:0,
   soul:'Synthetic image analyst.',user:'Synthetic image fixture only.',memory:'Do not read external files.'});
  assert.deepEqual(Buffer.from(storeNow.getImageAttachment(thread.id,firstId).data),first,'reopen retains exact PNG');
  const uploadBody={clientAttachmentId:firstId,mediaType:'image/png',dataBase64:first.toString('base64')};
  const replay=await request(app,`/v1/threads/${thread.id}/attachments`,uploadBody);assert.equal(replay.status,201);assert.deepEqual(await replay.json(),attachment);
  assert.equal((await request(app,`/v1/threads/${thread.id}/attachments`,{...uploadBody,dataBase64:second.toString('base64')})).status,409);
  const secondId=randomUUID(),secondResponse=await request(app,`/v1/threads/${thread.id}/attachments`,{...uploadBody,clientAttachmentId:secondId,dataBase64:second.toString('base64')});
  assert.equal(secondResponse.status,201);assert.equal((await secondResponse.json()).sha256,sha(second));
  const foreign=storeNow.createThread(actor.id);
  assert.equal((await request(app,`/v1/threads/${foreign.id}/attachments`,uploadBody)).status,409);
  assert.equal((await app.request(`http://127.0.0.1/v1/threads/${foreign.id}/attachments/${firstId}`)).status,404);
  const download=await app.request(`http://127.0.0.1/v1/threads/${thread.id}/attachments/${firstId}`);
  assert.equal(download.headers.get('content-type'),'image/png');assert.equal(download.headers.get('cache-control'),'no-store');assert.equal(download.headers.get('x-content-type-options'),'nosniff');
  assert.deepEqual(Buffer.from(await download.arrayBuffer()),first);
  assert.equal((await request(app,`/v1/threads/${thread.id}/attachments`,uploadBody,{origin:'https://synthetic.invalid'})).status,403);
  assert.equal((await request(app,`/v1/threads/${thread.id}/attachments`,{...uploadBody,clientAttachmentId:randomUUID(),dataBase64:' '+uploadBody.dataBase64})).status,400);
  const corrupt=Buffer.from(first);corrupt[corrupt.length-1]^=1;
  assert.equal((await request(app,`/v1/threads/${thread.id}/attachments`,{...uploadBody,clientAttachmentId:randomUUID(),dataBase64:corrupt.toString('base64')})).status,400);
  assert.equal((await request(app,`/v1/threads/${thread.id}/attachments`,{...uploadBody,clientAttachmentId:randomUUID(),dataBase64:Buffer.alloc(2*1024*1024+1).toString('base64')})).status,400);
  const invalidCount={clientRequestId:'too-many-images',content:'',attachmentIds:Array.from({length:5},()=>randomUUID())};
  assert.equal((await request(app,`/v1/threads/${thread.id}/turns`,invalidCount)).status,400);
  const before=storeNow.listMessages(foreign.id).length;
  assert.equal((await request(app,`/v1/threads/${foreign.id}/turns`,{clientRequestId:'foreign-ref',content:'',attachmentIds:[firstId]})).status,404);
  assert.equal(storeNow.listMessages(foreign.id).length,before,'cross-thread failure appends no message/turn');
  assert.equal((await request(app,`/v1/threads/${thread.id}/messages`,{clientMessageId:'blank',content:''})).status,400);
  const append={clientMessageId:'synthetic-image-message',content:'',attachmentIds:[firstId]};
  assert.equal((await request(app,`/v1/threads/${thread.id}/messages`,append)).status,201);
  assert.equal((await request(app,`/v1/threads/${thread.id}/messages`,{...append,attachmentIds:[secondId]})).status,409);
  assert.deepEqual(storeNow.listMessages(thread.id).find(message=>message.clientMessageId===append.clientMessageId).attachments.map(image=>image.id),[firstId]);

  // A paired router retains its 64KiB limit and refuses both attachment channels and attachment fields.
  const authority={principal:'paired-client',installationId:identity.installationId,ownerId:identity.ownerId,deviceId:'synthetic-paired-device',role:'client-mac',
   scopes:['chat.read','chat.write'],pinGeneration:1,bindingRevision:1,assertCurrent(){},noteSelfRevoke(){}};
  const remote=createAuthorizedHostRouter(storeNow,{runtime:services.runtime});
  const remotePost=(path,body)=>remote.fetch(new Request(`https://synthetic.test${path}`,{method:'POST',headers,body:JSON.stringify(body)}),{authority});
  assert.equal((await remotePost(`/v1/threads/${thread.id}/attachments`,uploadBody)).status,403);
  assert.equal((await remotePost(`/v1/threads/${thread.id}/turns`,{clientRequestId:'paired-image',content:'synthetic',attachmentIds:[firstId]})).status,403);
  assert.equal((await remotePost(`/v1/threads/${thread.id}/messages`,append)).status,403);
  assert.equal((await remote.fetch(new Request(`https://synthetic.test/v1/threads/${thread.id}/attachments/${firstId}`),{authority})).status,403);
  assert.equal((await remotePost(`/v1/threads/${thread.id}/attachments`,{...uploadBody,dataBase64:'A'.repeat(70_000)})).status,413);
  assert.equal((await request(app,`/v1/threads/${thread.id}/messages`,{clientMessageId:'huge-envelope',content:'A'.repeat(300_000)})).status,413);

  const unsupported={id:'claude',open:async threadId=>({threadId,nativeCursor:'synthetic'}),async *turn(){throw new Error('Unsupported image engine must not run');},respondToTool:async()=>{},interrupt:async()=>{},close:async()=>{}};
  unsupportedRuntime=new ConversationRuntime({store:storeNow,drivers:[unsupported]});
  assert.throws(()=>unsupportedRuntime.startTurn(foreign.id,{clientRequestId:'unsupported-image',content:'',attachmentIds:[]}),error=>error.code==='invalid_input');
  const unsupportedImage=storeNow.uploadImageAttachment(foreign.id,{clientAttachmentId:randomUUID(),mediaType:'image/png',dataBase64:first.toString('base64')});
  assert.throws(()=>unsupportedRuntime.startTurn(foreign.id,{clientRequestId:'unsupported-image',content:'',attachmentIds:[unsupportedImage.id]}),error=>error.code==='invalid_input');
  assert.equal(storeNow.findTurn(foreign.id,'unsupported-image'),null);
  await unsupportedRuntime.shutdown({closeStore:false});unsupportedRuntime=undefined;

  const imageTurn={clientRequestId:'claude-image-native',content:'Compare the synthetic pixels.',attachmentIds:[firstId,secondId]};
  const start=await request(app,`/v1/threads/${thread.id}/turns`,imageTurn);assert.equal(start.status,201);const turn=await start.json();
  await until(()=>['completed','failed','unknown','interrupted'].includes(storeNow.getTurn(turn.id).state)&&services.runtime.status().pending.sessions===0&&services.runtime.status().pending.turns===0);
  assert.equal(storeNow.getTurn(turn.id).state,'completed',`Synthetic Claude turn code: ${storeNow.getTurn(turn.id).code}`);
  assert.equal((await request(app,`/v1/threads/${thread.id}/turns`,imageTurn)).status,200);
  assert.equal((await request(app,`/v1/threads/${thread.id}/turns`,{...imageTurn,attachmentIds:[secondId,firstId]})).status,409,'ordered image refs participate in replay hash');
  const claudeAck=JSON.parse(storeNow.turnOutput(turn.id));assert.deepEqual(claudeAck.images,[{sha256:sha(first),bytes:first.length},{sha256:sha(second),bytes:second.length}]);
  assert.equal(claudeAck.wire,'base64-image');assert.equal(claudeAck.wrappedContext,true);
  const codexBot=storeNow.createBot({name:'Codex image synthetic',profileId:'synthetic-profile',engine:'codex'}),codexThread=storeNow.createThread(codexBot.id);
  const codexAttachment=storeNow.uploadImageAttachment(codexThread.id,{clientAttachmentId:randomUUID(),mediaType:'image/png',dataBase64:first.toString('base64')});
  const codexStart=await request(app,`/v1/threads/${codexThread.id}/turns`,{clientRequestId:'codex-image-native',content:'',attachmentIds:[codexAttachment.id]});assert.equal(codexStart.status,201);const codexTurn=await codexStart.json();
  await until(()=>['completed','failed','unknown','interrupted'].includes(storeNow.getTurn(codexTurn.id).state)&&services.runtime.status().pending.sessions===0&&services.runtime.status().pending.turns===0);
  assert.equal(storeNow.getTurn(codexTurn.id).state,'completed',`Synthetic Codex turn code: ${storeNow.getTurn(codexTurn.id).code}`);
  const codexAck=JSON.parse(storeNow.turnOutput(codexTurn.id));assert.deepEqual(codexAck.images,[{sha256:sha(first),bytes:first.length}]);assert.equal(codexAck.wire,'localImage');assert.equal(codexAck.wrappedContext,true);
  assert.ok(observedPaths.length===3&&observedPaths.every(path=>!existsSync(path)),'owned native image files removed only after native close/drain');
  assert.ok(!JSON.stringify(storeNow.listMessages(thread.id)).includes(first.toString('base64')));
  assert.ok(!JSON.stringify(storeNow.listTurnEvents({turnId:turn.id})).includes(first.toString('base64')));
  const checkDb=new DatabaseSync(storeNow.databasePath,{readOnly:true});try{assert.deepEqual(operations.checkFullSchema(checkDb,'hub'),identity);}finally{checkDb.close();}
  assert.equal(operations.doctor(dataDir).hub.supported,true);
  const catalogDb=new DatabaseSync(':memory:');
  try{
   catalogDb.exec(operations.FULL_SCHEMAS.context.sql);
   for(const [key,value]of[['installation',identity.installationId],['owner',identity.ownerId],['schema','2']])
    catalogDb.prepare('INSERT INTO meta(key,value)VALUES(?,?)').run(key,value);
   assert.deepEqual(operations.checkFullSchema(catalogDb,'context'),identity);
   catalogDb.exec("DROP TABLE bot_document_receipts; DROP TABLE bot_document_revisions; DROP TABLE bot_documents; UPDATE meta SET value='1' WHERE key='schema'");
   assert.deepEqual(operations.checkFullSchema(catalogDb,'context'),identity,'historical exact Context catalog remains supported');
   catalogDb.exec('CREATE INDEX synthetic_unreviewed_index ON memories(locale)');
   assert.throws(()=>operations.checkFullSchema(catalogDb,'context'),error=>error.code==='unsupported_schema');
  }finally{catalogDb.close();}

  // Exact canonical authority capture/decoder/activation carry the durable BLOB in the same SQLite member.
  const {privateKey,publicKey}=generateKeyPairSync('ed25519'),secret=createSecretKey(randomBytes(32));
  const key={keyId:'synthetic-images-checkpoint',use:fn=>fn(secret)},owner={publicKey,sign:bytes=>sign(null,bytes,privateKey)};
  coordinator=operations.AuthorityCoordinator.open(join(root,'coordinator'),{ownerId:identity.ownerId,ownerPublicKey:publicKey});
  const controller=new operations.LocalAuthorityController({coordinator}),hold=await controller.quiesce(services);
  const backupPath=join(root,'images-backup.dxg8');controller.backup(hold,{output:backupPath,key});
  const backup=operations.openCheckpointArtifact(backupPath,key);assert.equal(backup.manifest.schemas.hub,'hub-v8');
  assert.equal(backup.manifest.schemas.context,'context-v2-document-history');
  assert.ok(backup.members.get(operations.CHECKPOINT_MEMBERS.hub).includes(first));
  const next=await controller.quiesce({quiesceForMaintenance:async()=>hold.store}),artifact=join(root,'images-transfer.dxg8'),destination=join(root,'destination');
  const prepared=controller.prepare(next,{output:artifact,key});controller.revokeSource({store:hold.store},prepared.checkpointId,destination);
  const activated=controller.activate({artifact,key,receipt:controller.issueReceipt(owner,prepared.checkpointId)});
  const canonicalDestination=activated.destination;
  assert.ok(existsSync(join(canonicalDestination,'dexter.sqlite')),'activation published its canonical Hub before opening it');
  const publishedDb=new DatabaseSync(join(canonicalDestination,'dexter.sqlite'),{readOnly:true});
  try{
   assert.deepEqual(operations.checkFullSchema(publishedDb,'hub'),identity);
   assert.equal(publishedDb.prepare('PRAGMA journal_mode').get().journal_mode,'delete');
  }finally{publishedDb.close();}
  // Activation publishes a closed DELETE-journal copy. The explicit owner-local first open establishes WAL;
  // subsequent existing-only admission retains its strict initialized-journal and identity requirements.
  destinationStore=new HostStore({dataDir:canonicalDestination,ownerId:identity.ownerId});
  assert.equal(destinationStore.hostId,identity.installationId);assert.equal(destinationStore.ownerId,identity.ownerId);
  destinationStore.close();destinationStore=undefined;
  destinationStore=new HostStore({dataDir:canonicalDestination,existingInstallation:identity});assert.equal(queryVersion(destinationStore.databasePath),8);
  const restoredContext=new DatabaseSync(join(canonicalDestination,'context.sqlite'),{readOnly:true});
  try{
   assert.deepEqual(operations.checkFullSchema(restoredContext,'context'),identity);
   const restoredDocuments=restoredContext.prepare('SELECT revision,soul_pin_json,user_pin_json,memory_pin_json FROM bot_documents WHERE bot_id=?').get(actor.id);
   assert.equal(restoredDocuments.revision,documents.revision);
   for(const name of['SOUL','USER','MEMORY'])assert.ok(restoredDocuments[`${name.toLowerCase()}_pin_json`].includes(`/${name}-r1-`));
  }finally{restoredContext.close();}
  assert.deepEqual(Buffer.from(destinationStore.getImageAttachment(thread.id,firstId).data),first);
  assert.deepEqual(destinationStore.turnAttachments(turn.id).map(image=>image.id),[firstId,secondId]);
  assert.equal(destinationStore.createTurn(thread.id,imageTurn).created,false,'activated turn replay never runs inference again');
  t.diagnostic(JSON.stringify({schemaMigration:'7_to_8',nativeImageProtocols:['claude_base64_image','codex_localImage'],imageBytesPersistedIn:'sqlite_blob',checkpointSchema:'hub-v8',contextCatalog:'context-v2-document-history',realAccountsUsed:false}));
 }finally{
  await unsupportedRuntime?.shutdown({closeStore:false});destinationStore?.close();coordinator?.close();await services?.shutdown();store?.close();rmSync(root,{recursive:true,force:true});
 }
});
