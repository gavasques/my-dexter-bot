import assert from 'node:assert/strict';
import {createSecretKey,randomBytes} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {HostStore} from '@dexter/hub';
import {DevicePairingRegistry,operationFor,DEVICE_OPERATIONS} from '@dexter/devices';
import {DeviceTurnSurface} from '../packages/cli/dist/device-turn-surface.js';
import {captureCheckpointArtifact,openCheckpointArtifact} from '../packages/operations/dist/checkpoint.js';
import {checkFullSchema} from '../packages/operations/dist/full-schemas.js';
import {preservedDigest,resolveCatalog,validateDevices} from '../packages/operations/dist/devices.js';

const catalog=[...DEVICE_OPERATIONS.values()].map(({tool,version,schemaHash})=>({tool,version,schemaHash}));
for(const version of [2,3])test(`full encrypted checkpoint preserves device surface v${version} including exact route receipts`,async t=>{
  mkdirSync(resolve('../proof-runs'),{mode:0o700,recursive:true});const root=mkdtempSync(resolve('../proof-runs/checkpoint-'));
  const dataDir=join(root,'host'),store=new HostStore({dataDir}),registry=new DevicePairingRegistry(store);
  const offer=registry.createOffer({kind:'pair'}),claim=registry.claim({offerId:offer.offerId,code:offer.code,clientFingerprint:'a'.repeat(64),name:'QA Mac',capabilities:['mac.file.read']});const device=registry.approveClaim(claim.claimId);
  const bot=store.createBot({name:'QA routes',profileId:'qa',engine:'claude'});
  const surface=new DeviceTurnSurface(store,{installationId:store.hostId,ownerId:store.ownerId,snapshot:id=>registry.pinBinding(id),operation:operationFor,authenticatedPresence:()=> 'stale',dispatchBound:()=>{throw Error('no execution');}});
  const request={expectedHostId:store.hostId,clientRequestId:'original-lost-ack',botId:bot.id,deviceId:device.deviceId,tool:'mac.file.read',expectedRevision:null,status:'active'};
  const receipt=surface.admin.patchRoute(request);
  await surface.close();registry.close();
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  const db=new DatabaseSync(join(dataDir,'device-tools.sqlite'));
  if(version===2){db.exec('DROP TABLE device_route_receipts');db.prepare("UPDATE meta SET value='2' WHERE key='schema'").run();}
  checkFullSchema(db,'deviceSurface');const digest=preservedDigest(db,'deviceSurface');db.close();
  const checkpoint=store.checkpointForTransfer('ckp_'+String(version).repeat(32));
  const secret=createSecretKey(randomBytes(32)),key={keyId:'qa-checkpoint-key',use:fn=>fn(secret)};
  const result=captureCheckpointArtifact({source:store,checkpoint,key,output:join(root,'checkpoint.dxg8'),operationCatalog:catalog});
  const opened=openCheckpointArtifact(result.path,key);assert.equal(opened.manifest.schemas.deviceSurface,`device-surface-v${version}`);
  const copy=join(root,'surface-copy.sqlite');writeFileSync(copy,opened.members.get('device-surface.sqlite'),{mode:0o600});
  const restored=new DatabaseSync(copy,{readOnly:true});checkFullSchema(restored,'deviceSurface');assert.equal(preservedDigest(restored,'deviceSurface'),digest);
  if(version===3)assert.deepEqual(JSON.parse(restored.prepare('SELECT receipt_json FROM device_route_receipts').get().receipt_json),receipt);
  restored.close();
  // Cross-database validation of the receipted result is part of full capture/open, not a runtime migration.
  assert.equal(result.counts.deviceSurface.routes.active,1);
});
test('full validation refuses a tampered route receipt even with matching exact table/trigger catalog',async t=>{
  mkdirSync(resolve('../proof-runs'),{recursive:true,mode:0o700});const root=mkdtempSync(resolve('../proof-runs/receipt-tamper-'));
  const store=new HostStore({dataDir:root}),registry=new DevicePairingRegistry(store),offer=registry.createOffer({kind:'pair'});
  const device=registry.approveClaim(registry.claim({offerId:offer.offerId,code:offer.code,clientFingerprint:'a'.repeat(64),name:'QA',capabilities:['mac.file.read']}).claimId);
  const bot=store.createBot({name:'QA',profileId:'qa',engine:'claude'}),surface=new DeviceTurnSurface(store,{installationId:store.hostId,ownerId:store.ownerId,snapshot:id=>registry.pinBinding(id),operation:operationFor,authenticatedPresence:()=> 'stale',dispatchBound:()=>{throw Error('no effect');}});
  surface.admin.patchRoute({expectedHostId:store.hostId,clientRequestId:'tamper',botId:bot.id,deviceId:device.deviceId,tool:'mac.file.read',expectedRevision:null,status:'active'});
  const db=new DatabaseSync(surface.databasePath),hub=new DatabaseSync(store.databasePath,{readOnly:true}),reg=new DatabaseSync(join(root,'devices.sqlite'),{readOnly:true});
  const args={hub,registry:reg,surface:db,identity:{installationId:store.hostId,ownerId:store.ownerId},catalog:resolveCatalog(catalog),sanitizedDevices:new Set()};
  validateDevices(args);
  const trigger=db.prepare("SELECT sql FROM sqlite_schema WHERE name='device_route_receipts_immutable_update'").get().sql;
  db.exec('DROP TRIGGER device_route_receipts_immutable_update');db.prepare("UPDATE device_route_receipts SET request_hash=?").run('b'.repeat(64));db.exec(trigger);checkFullSchema(db,'deviceSurface');
  assert.throws(()=>validateDevices(args),error=>error.code==='reference_broken');
  db.close();hub.close();reg.close();await surface.close();registry.close();store.close();rmSync(root,{recursive:true,force:true});
});
