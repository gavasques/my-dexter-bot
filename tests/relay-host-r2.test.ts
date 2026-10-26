import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { HostStore } from '@dexter/hub';
import { AgendaHostConsumer } from '@dexter/agenda';
import { ManagedAppsRuntime } from '@dexter/connectors';
import { RelayHost, RelayAssociations, RelayCleanupIncompleteError, type RelayHostOptions } from '@dexter/relay-host';
import type { HostPort } from '@dexter/relay-consumer';
import { HostServices } from '../packages/cli/src/host-services.js';
import { DeviceServices } from '../packages/cli/src/device-services.js';
import { DeviceTurnSurface } from '../packages/cli/src/device-turn-surface.js';
import { AppClientServices } from '../packages/cli/src/app-client-services.js';
import { memoryCustody, memoryTLS } from './fixtures/relay-host-lab.js';
const locked=(e:unknown)=>!!e&&typeof e==='object'&&'code'in e&&e.code==='host_locked';
const privateRoot=()=>{const p=realpathSync(mkdtempSync(join(tmpdir(),'rh-r2-')));chmodSync(p,0o700);return p;};
for(const rejected of [false,true])test(`memory-only equivalent Surface constructor rollback stops first, original cause retained (${rejected})`,()=>{
 const l=setup(),dir=l.dir,dataDir=l.dataDir,identity=memoryTLS(),sequence:string[]=[];let store:HostStore|undefined,effects=0;
 const bind=ManagedAppsRuntime.prototype.bind,agenda=AgendaHostConsumer.prototype.disposeUnstarted,surface=DeviceTurnSurface.prototype.disposeUnstarted,devices=DeviceServices.prototype.disposeUnstarted,close=HostStore.prototype.close,relay=RelayHost.prototype.disposeUnstarted;
 const original=Error('synthetic_late_bind');const cleanup=Error('synthetic_surface_dispose');
 ManagedAppsRuntime.prototype.bind=function(s){store=s as HostStore;sequence.push('bind');throw original;};
 RelayHost.prototype.disposeUnstarted=function(){sequence.push('relay');relay.call(this);};
 AgendaHostConsumer.prototype.disposeUnstarted=function(){sequence.push('agenda');agenda.call(this);};
 DeviceTurnSurface.prototype.disposeUnstarted=function(){sequence.push('surface');surface.call(this);if(rejected)throw cleanup;};
 DeviceServices.prototype.disposeUnstarted=function(){sequence.push('devices');devices.call(this);};
 HostStore.prototype.close=function(){sequence.push('store');close.call(this);};
 const external=async()=>{effects++;throw Error('unexpected external work');};
 try{assert.throws(()=>new HostServices({dataDir,enableEngines:true,enableMcp:true,enableDeviceTools:true,enableAgenda:true,devices:{identity},appClients:{identity},relay:l.options,managedApps:{provider:{catalog:external,provision:external,lookup:external,account:external},credentialRef:'synthetic',broker:{acquire(){effects++;return null;},secretValues(){return [];}},fetch:external,disposeOwnedBroker:external}}),e=>rejected?e instanceof AggregateError&&e.message===cleanup.message&&e.cause===original&&e.errors[0]===cleanup:e===original);
 assert.deepEqual(sequence,rejected?['bind','relay','agenda','surface']:['bind','relay','agenda','surface','devices','store']);assert.equal(effects,0);assert.equal(l.custody.closes,0);assert.equal(l.transportCloses,0);if(rejected)assert.throws(()=>new HostStore({dataDir}),locked);else{const reopened=new HostStore({dataDir});reopened.close();}
 }finally{ManagedAppsRuntime.prototype.bind=bind;AgendaHostConsumer.prototype.disposeUnstarted=agenda;DeviceTurnSurface.prototype.disposeUnstarted=surface;DeviceServices.prototype.disposeUnstarted=devices;HostStore.prototype.close=close;RelayHost.prototype.disposeUnstarted=relay;
 // Explicit isolated fixture teardown, after assertion. Never offered as a production safe rollback.
 store?.close();rmSync(dir,{recursive:true,force:true});}
});
function setup(){const dir=privateRoot(),dataDir=join(dir,'host'),seed=new HostStore({dataDir}),hostId=seed.hostId,ownerId=seed.ownerId,path=seed.databasePath;seed.close();const custody=memoryCustody({installationId:hostId,ownerId,deviceId:'relay_host',generation:1,keyId:'host_key'});let transportCloses=0;const options:RelayHostOptions={recipient:custody.pin,custody:custody.provider,custodyMode:'laboratory-memory',transport:{async poll(){return {deliveries:[],cursor:0};},async ack(){return {receiptId:'unused'};},async close(){transportCloses++;}},transportOwnership:'owned',deployment:{maximumPendingPerRecipient:131}};
 return {dir,dataDir,path,hostId,ownerId,custody,options,get transportCloses(){return transportCloses;}};}
for(const kind of ['file-tamper','writer-lost'])test(`unassigned RelayHost consumer failure + actual association rollback ${kind} quarantines canonical writer`,()=>{
 const l=setup(),directory=join(l.dataDir,'relay-host'),file=join(directory,'relay-associations.sqlite');mkdirSync(directory,{mode:0o700});writeFileSync(join(directory,'relay-consumer.sqlite'),'synthetic malformed public journal',{mode:0o600});
 const closeAssoc=RelayAssociations.prototype.close,closeHost=HostStore.prototype.close,withLease=HostStore.prototype.withWriterLease,disposeApp=AppClientServices.prototype.disposeUnstarted;let store:HostStore|undefined,closes=0,disposed=0;
 HostStore.prototype.withWriterLease=function<T>(fn:()=>T):T{if(this.databasePath===l.path)store=this;return withLease.call(this,fn) as T;};
 HostStore.prototype.close=function(){if(this.databasePath===l.path)closes++;return closeHost.call(this);};
 AppClientServices.prototype.disposeUnstarted=function(){disposed++;return disposeApp.call(this);};
 RelayAssociations.prototype.close=function(){assert.ok(store);if(kind==='file-tamper')chmodSync(file,0o644);else{const d=new DatabaseSync(l.path);d.prepare('UPDATE host_lease SET token=? WHERE id=1').run('synthetic_lost_constructor_writer');d.close();}return closeAssoc.call(this);};
 try{assert.throws(()=>new HostServices({dataDir:l.dataDir,enableEngines:true,appClients:{identity:memoryTLS()},relay:l.options}),e=>e instanceof RelayCleanupIncompleteError&&e.cause instanceof Error&&e.errors.length===1&&e.errors[0] instanceof Error&&e.message===e.errors[0].message);
 assert.equal(closes,0);assert.equal(disposed,0);assert.equal(l.custody.closes,0);assert.equal(l.transportCloses,0);assert.throws(()=>new HostStore({dataDir:l.dataDir}),locked);
 assert.throws(()=>new RelayAssociations({hostId:l.hostId,ownerId:l.ownerId,withWriterLease:<T>(f:()=>T)=>f()} as HostPort,{binding:()=>null},directory,l.custody.pin));
 }finally{RelayAssociations.prototype.close=closeAssoc;HostStore.prototype.close=closeHost;HostStore.prototype.withWriterLease=withLease;AppClientServices.prototype.disposeUnstarted=disposeApp;}
 // Deliberate quarantine: keep the actual captured store/DB and private evidence until process exit.
 assert.ok(store);
});
test('association constructor native close rejection carries primary conflict and retains writer/OPEN quarantine',async t=>{
 const l=setup(),directory=join(l.dataDir,'relay-host'),seed=new HostStore({dataDir:l.dataDir}),host={hostId:seed.hostId,ownerId:seed.ownerId,withWriterLease:<T>(f:()=>T)=>seed.withWriterLease(f)} as HostPort;const association=new RelayAssociations(host,{binding:()=>null},directory,l.custody.pin);association.close();seed.close();
 const changed=memoryCustody({installationId:l.hostId,ownerId:l.ownerId,deviceId:'relay_host',generation:1,keyId:'different_key'}),closeDb=DatabaseSync.prototype.close,closeHost=HostStore.prototype.close;let closes=0;const cleanup=Error('synthetic_association_native_close_failure');
 DatabaseSync.prototype.close=function(){const files=this.prepare('PRAGMA database_list').all();if(files.some(f=>f.file===join(directory,'relay-associations.sqlite')))throw cleanup;return closeDb.call(this);};
 HostStore.prototype.close=function(){if(this.databasePath===l.path)closes++;return closeHost.call(this);};
 try{assert.throws(()=>new HostServices({dataDir:l.dataDir,enableEngines:true,appClients:{identity:memoryTLS()},relay:{...l.options,recipient:changed.pin,custody:changed.provider}}),e=>e instanceof RelayCleanupIncompleteError&&e.errors[0]===cleanup&&e.message===cleanup.message&&!!e.cause&&typeof e.cause==='object'&&'code'in e.cause&&e.cause.code==='conflict');assert.equal(closes,0);assert.equal(changed.closes,0);assert.throws(()=>new HostStore({dataDir:l.dataDir}),locked);}
 finally{DatabaseSync.prototype.close=closeDb;HostStore.prototype.close=closeHost;}
 const child=fork(new URL('./fixtures/relay-host-child.js',import.meta.url),[],{stdio:['ignore','ignore','ignore','ipc']}),exit=once(child,'exit');t.after(async()=>{if(child.exitCode===null)child.kill('SIGTERM');await exit;});const message=once(child,'message');child.send({op:'probe',dataDir:l.dataDir,associationFile:join(directory,'relay-associations.sqlite')});const [result]=await message;assert.deepEqual(result,{writerLocked:true,associationLocked:true});await exit;
 // Quarantine is not a successful teardown. OS releases unassigned handles only at process exit.
});
