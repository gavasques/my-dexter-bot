import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,realpathSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {isAbsolute,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync,backup} from 'node:sqlite';
import {deflateSync} from 'node:zlib';

const packageRoot=process.env.DEXTER_AVATAR_PACKAGE_ROOT;
if(packageRoot!==undefined&&!isAbsolute(packageRoot))throw new Error('Avatar package root must be absolute.');
const moduleRoot=packageRoot??resolve('.');
const load=relative=>import(pathToFileURL(join(moduleRoot,packageRoot===undefined?relative:
  relative.replace(/^packages\/([^/]+)\//,'node_modules/@dexter/$1/'))).href);
const [{HostStore,HostError},{createHostApp,createAuthorizedHostRouter},{ContextHost,FixtureMemoryAdapter},
  {checkHubExact,EXACT_SCHEMAS},{checkFullSchema},{validateContext}]=await Promise.all([
  load('packages/hub/dist/index.js'),load('packages/hub/dist/http.js'),load('packages/context/dist/index.js'),
  load('packages/operations/dist/exact.js'),load('packages/operations/dist/full-schemas.js'),load('packages/operations/dist/validate.js'),
]);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const CRC=new Uint32Array(256);
for(let i=0;i<256;i++){let n=i;for(let j=0;j<8;j++)n=(n&1)?0xedb88320^(n>>>1):n>>>1;CRC[i]=n>>>0;}
const crc=bytes=>{let n=0xffffffff;for(const byte of bytes)n=CRC[(n^byte)&255]^(n>>>8);return(n^0xffffffff)>>>0;};
const chunk=(name,bytes)=>{const body=Buffer.concat([Buffer.from(name),bytes]),head=Buffer.alloc(4),tail=Buffer.alloc(4);
  head.writeUInt32BE(bytes.length);tail.writeUInt32BE(crc(body));return Buffer.concat([head,body,tail]);};
const png=(red,width=1,height=1)=>{const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
  const row=Buffer.alloc(width*4+1);for(let x=0;x<width;x++){row[1+x*4]=red;row[4+x*4]=255;}
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),
    chunk('IDAT',deflateSync(Buffer.concat(Array.from({length:height},()=>row)))),chunk('IEND',Buffer.alloc(0))]);};
const refused=code=>error=>error?.code===code;
const request=(app,path,body,method='POST')=>app.request(`http://127.0.0.1${path}`,{method,
  headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});

test('Owner avatar upload, host isolation, bot/team CAS, and canonical backup preserve actual media',async()=>{
  const parent=process.env.DEXTER_AVATAR_TEST_ROOT;
  if(parent!==undefined&&!isAbsolute(parent))throw new Error('Avatar test root must be absolute.');
  const lab=realpathSync(mkdtempSync(join(parent??tmpdir(),'dexter-avatar-functional-')));
  const data=join(lab,'host');mkdirSync(data,{mode:0o700});
  let store,context,foreign,read,contextRead;
  try{
    // Seed the accepted historical exact v9 catalog, then exercise the real existing-installation migration.
    const identity={installationId:'synthetic-avatar-installation',ownerId:'synthetic-avatar-owner'};
    const seed=new DatabaseSync(join(data,'dexter.sqlite'));
    try{
      seed.exec(EXACT_SCHEMAS.hub9.sql);seed.exec('PRAGMA user_version=9;PRAGMA journal_mode=WAL;');
      for(const[key,value]of[['host_id',identity.installationId],['owner_id',identity.ownerId]])seed.prepare('INSERT INTO meta VALUES(?,?)').run(key,value);
      seed.prepare(`INSERT INTO host_authority(id,installation_id,owner_id,epoch,state,directory,directory_ino,provenance,updated_at)
        VALUES(1,?,?,1,'active',?,?,'genesis',1)`).run(identity.installationId,identity.ownerId,data,statSync(data,{bigint:true}).ino.toString());
      seed.prepare('INSERT INTO profiles VALUES(?,?,1)').run('synthetic-profile',identity.ownerId);
      seed.prepare(`INSERT INTO bots(id,owner_id,profile_id,name,engine,created_at,default_selection) VALUES(?,?,?,'Legacy avatar bot','claude',1,?)`)
        .run('bot_syntheticLegacy',identity.ownerId,'synthetic-profile',JSON.stringify({engine:'claude',model:null,reasoningEffort:null,speed:null}));
      assert.deepEqual(checkHubExact(seed),identity);
    }finally{seed.close();}
    store=new HostStore({dataDir:data,existingInstallation:identity});
    assert.equal(store.summary().schemaVersion,11);
    assert.equal(store.getBot('bot_syntheticLegacy').avatarImage,null);
    context=new ContextHost(store,new FixtureMemoryAdapter([]));
    // Match HostServices' Context-to-Host fixed-code boundary; never forward imported exception text.
    const own=operation=>{try{return operation();}catch(error){throw new HostError(error.code==='tampered'?'conflict':error.code,'Synthetic team operation refused.');}};
    const teams={list:()=>own(()=>context.listTeamWorkspaces()),get:id=>own(()=>context.getTeamWorkspace(id)),
      create:input=>own(()=>context.createTeamWorkspace(input)),update:(id,input)=>own(()=>context.updateTeamWorkspace(id,input))};
    const app=createHostApp(store,{teams});
    const first=png(20),second=png(210);
    const payload={expectedHostID:store.hostId,clientRequestId:randomUUID(),mediaType:'image/png',dataBase64:first.toString('base64')};
    const uploaded=await request(app,'/v1/avatars',payload);assert.equal(uploaded.status,201);
    const image=await uploaded.json();assert.equal(image.sha256,sha(first));assert.equal(image.bytes,first.length);
    assert.deepEqual(await(await request(app,'/v1/avatars',payload)).json(),image);
    assert.deepEqual(await(await request(app,'/v1/avatars',{...payload,clientRequestId:randomUUID()})).json(),image);
    assert.equal((await request(app,'/v1/avatars',{...payload,dataBase64:second.toString('base64')})).status,409);
    assert.equal((await request(app,'/v1/avatars',{...payload,expectedHostID:'host_foreign',clientRequestId:randomUUID()})).status,409);
    const corrupt=Buffer.from(first);corrupt[corrupt.length-1]^=1;
    assert.equal((await request(app,'/v1/avatars',{...payload,clientRequestId:randomUUID(),dataBase64:corrupt.toString('base64')})).status,400);
    assert.equal((await request(app,'/v1/avatars',{...payload,clientRequestId:randomUUID(),dataBase64:png(20,1025).toString('base64')})).status,400);
    assert.equal((await request(app,'/v1/avatars',{...payload,clientRequestId:randomUUID(),mediaType:'image/svg+xml',dataBase64:Buffer.from('<svg/>').toString('base64')})).status,400);
    const response=await app.request(`http://127.0.0.1/v1/avatars/${image.id}?expectedHostID=${store.hostId}`);
    assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
    const downloaded=await response.json();assert.deepEqual(downloaded.avatarImage,image);assert.deepEqual(Buffer.from(downloaded.dataBase64,'base64'),first);
    assert.equal((await app.request(`http://127.0.0.1/v1/avatars/${image.id}?expectedHostID=host_foreign`)).status,409);

    const bot=store.createBot({name:'Synthetic image bot',profileId:'synthetic-profile',engine:'claude',avatarImageId:image.id});
    assert.deepEqual(bot.avatarImage,image);
    const teamInput={expectedHostID:store.hostId,clientRequestId:randomUUID(),name:'Casa',coordinatorBotId:bot.id,botIds:[bot.id],avatarImageId:image.id};
    const team=await(await request(app,'/v1/teams',teamInput)).json();assert.deepEqual(team.avatarImage,image);
    assert.deepEqual(await(await request(app,'/v1/teams',teamInput)).json(),team);
    const nextImage=store.uploadAvatarImage({...payload,clientRequestId:randomUUID(),dataBase64:second.toString('base64')});
    const changed=store.patchBot(bot.id,{expectedRevision:bot.revision,avatarImageId:nextImage.id});
    assert.deepEqual(changed.avatarImage,nextImage);assert.equal(store.getBot('bot_syntheticLegacy').avatarImage,null);
    assert.throws(()=>store.patchBot(bot.id,{expectedRevision:bot.revision,avatarImageId:null}),refused('conflict'));
    const cleared=await(await request(app,`/v1/teams/${team.id}`,{expectedHostID:store.hostId,expectedRevision:team.revision,avatarImageId:null},'PATCH')).json();
    assert.equal(cleared.avatarImage,null);assert.equal(cleared.revision,team.revision+1);
    assert.deepEqual(store.getBot(bot.id).avatarImage,nextImage);
    assert.equal((await request(app,`/v1/teams/${team.id}`,{expectedHostID:store.hostId,expectedRevision:team.revision,avatarImageId:image.id},'PATCH')).status,409);
    assert.equal(store.patchBot(bot.id,{expectedRevision:changed.revision,avatarImageId:null}).avatarImage,null);
    // The creation receipt and historical bytes survive clearing; clearing never erases replay authority.
    assert.deepEqual(context.createTeamWorkspace(teamInput).avatarImage,image);
    assert.deepEqual(store.readAvatarImage(image.id).data,first);

    foreign=new HostStore({dataDir:join(lab,'foreign'),ownerId:'synthetic-foreign-owner'});
    assert.throws(()=>foreign.createBot({name:'Foreign',profileId:'foreign-profile',engine:'claude',avatarImageId:image.id}),refused('not_found'));
    assert.equal(foreign.listBots().length,0);
    // The paired router has no media administration surface, even with a valid synthetic session authority.
    const remote=createAuthorizedHostRouter(store);
    const authority={principal:'paired-client',installationId:store.hostId,ownerId:store.ownerId,deviceId:'synthetic-client',
      role:'client-mac',scopes:['chat.read','chat.write'],pinGeneration:1,bindingRevision:1,assertCurrent(){},noteSelfRevoke(){}};
    const remoteResponse=await remote.request(`http://paired.test/v1/avatars/${image.id}?expectedHostID=${store.hostId}`,{}, {authority});
    assert.equal(remoteResponse.status,404);

    // SQLite backup captures the avatar BLOB and durable receipts alongside the Hub; exact restore gates validate them.
    read=new DatabaseSync(store.databasePath,{readOnly:true});contextRead=new DatabaseSync(context.databasePath,{readOnly:true});
    assert.deepEqual(checkFullSchema(read,'hub'),identity);assert.deepEqual(checkFullSchema(contextRead,'context'),identity);
    validateContext(contextRead,read,{blobSha256(){throw new Error('No synthetic context document exists.');}});
    assert.equal(read.prepare('SELECT COUNT(*) AS n FROM avatar_images').get().n,2);
    assert.equal(read.prepare('SELECT COUNT(*) AS n FROM avatar_upload_receipts').get().n,3);
    const metadata=JSON.stringify(read.prepare('SELECT * FROM events').all());
    assert(!metadata.includes(payload.dataBase64));assert(!metadata.includes('dataBase64'));
    const copied=join(lab,'canonical-backup.sqlite');await backup(read,copied);
    const copy=new DatabaseSync(copied,{readOnly:true});
    try{assert.deepEqual(checkHubExact(copy),identity);assert.deepEqual(Buffer.from(copy.prepare('SELECT data FROM avatar_images WHERE id=?').get(image.id).data),first);}
    finally{copy.close();}
  }finally{contextRead?.close();read?.close();foreign?.close();context?.close();store?.close();rmSync(lab,{recursive:true,force:true});}
});
