import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {HostStore,canonicalJson} from '@dexter/hub';
import {createHostApp,createAuthorizedHostRouter} from '@dexter/hub/http';
import {operationFor} from '@dexter/devices';
import {createHash} from 'node:crypto';
import {DeviceTurnSurface} from '../packages/cli/dist/device-turn-surface.js';
import {localDeviceRoutePort} from '../packages/cli/dist/local-device-route-port.js';
import {checkFullSchema,deviceSurfaceSchemaLabel} from '../packages/operations/dist/full-schemas.js';
import {EXACT_SCHEMAS,checkExactSchema} from '../packages/operations/dist/exact.js';
import {preservedDigest} from '../packages/operations/dist/devices.js';

const proofRoot=resolve('../proof-runs');mkdirSync(proofRoot,{recursive:true,mode:0o700});
function fixture(t){
  const dir=mkdtempSync(join(proofRoot,'route-receipts-'));
  const store=new HostStore({dataDir:dir});
  const bot=store.createBot({name:'QA owner routes',profileId:'qa',engine:'claude'});
  const device=store.registerDevice({name:'QA Mac',platform:'macos',capabilities:['mac.file.read']});
  let pin={installationId:store.hostId,ownerId:store.ownerId,deviceId:device.id,fingerprint:'a'.repeat(64),generation:1,revision:1,status:'active'};
  let operation=operationFor('mac.file.read');
  const port={installationId:store.hostId,ownerId:store.ownerId,snapshot:()=>pin,authenticatedPresence:()=> 'stale',operation:()=>operation,
    dispatchBound:()=>{throw Error('owner route must never dispatch');}};
  let surface=new DeviceTurnSurface(store,port),admitted=true;
  const http=localDeviceRoutePort(store,()=>{if(!admitted)throw Error('stopped');return surface.admin;});
  const app=createHostApp(store,{deviceRoutes:http});
  const input=(id='publish',revision=null,status='active')=>({expectedHostId:store.hostId,clientRequestId:id,botId:bot.id,deviceId:device.id,tool:'mac.file.read',expectedRevision:revision,status});
  const patch=body=>app.request('/v1/device-routes',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  t.after(async()=>{await surface.close();store.close();rmSync(dir,{recursive:true,force:true});});
  return {dir,store,bot,device,http,app,input,patch,get surface(){return surface;},async reopen(){await surface.close();surface=new DeviceTurnSurface(store,port);},stop(){admitted=false;},
    rotate(){pin={...pin,fingerprint:'b'.repeat(64),generation:2,revision:2};},changeSchema(){const op={...operation,version:'qa-next'};delete op.schemaHash;operation={...op,schemaHash:createHash('sha256').update(canonicalJson({version:op.version,tool:op.tool,effect:op.effect,description:op.description,inputSchema:op.inputSchema})).digest('hex')};}};
}
test('owner HTTP publishes without implicit grant; canonical CAS receipt and original GET survive lost ACK, later changes and restart',async t=>{
  const f=fixture(t),request=f.input();
  assert.equal((await f.app.request(`/v1/device-routes?botId=${f.bot.id}`)).status,200);
  const response=await f.patch(request);assert.equal(response.status,200);const original=await response.json();
  assert.equal(original.requestHash,createHash('sha256').update(canonicalJson(request)).digest('hex'));
  assert.equal(original.route.revision,1);assert.equal(original.route.needsFreshGrant,true);assert.equal(f.store.getGrant(f.bot.id,request.tool,f.device.id),null);
  assert.deepEqual(await (await f.patch(request)).json(),original);
  assert.equal((await f.patch({...request,clientRequestId:'stale-cas'})).status,409);
  assert.equal((await f.patch({...request,status:'suspended'})).status,409);
  assert.equal((await f.patch(f.input('suspend',1,'suspended'))).status,200);
  await f.reopen();
  assert.deepEqual(await (await f.app.request('/v1/device-routes/receipts/publish')).json(),original);
  assert.deepEqual(await (await f.patch(request)).json(),original);
  const page=await (await f.app.request(`/v1/device-routes?botId=${f.bot.id}`)).json();assert.equal(page.routes[0].revision,2);assert.equal(page.routes[0].status,'suspended');
  assert.equal((await f.app.request('/v1/device-routes/receipts/missing')).status,404);
});
test('owner boundary refuses wrong host, extras, malformed CAS and accessor/proxy without executing hooks',async t=>{
  const f=fixture(t);let ran=false;
  for(const body of [{...f.input(),expectedHostId:'foreign'}, {...f.input(),expectedRevision:0},{...f.input(),other:1}])assert.notEqual((await f.patch(body)).status,200);
  assert.throws(()=>f.http.patch(new Proxy(f.input(),{get(){ran=true;return ''}})));assert.equal(ran,false);
  const input=f.input();Object.defineProperty(input,'tool',{get(){ran=true;return 'mac.file.read'}});assert.throws(()=>f.http.patch(input));assert.equal(ran,false);
  assert.equal((await f.app.request(`/v1/device-routes?botId=${f.bot.id}&botId=${f.bot.id}`)).status,400);
  assert.equal((await f.app.request('/v1/device-routes')).status,400);
});
test('suspend is reversible, revocation terminal, stale pin/schema needs a strictly newer grant',async t=>{
  const f=fixture(t);await f.patch(f.input());
  const grant=()=>f.store.setGrant({botId:f.bot.id,tool:'mac.file.read',destination:f.device.id,policy:'ask'});
  grant();f.rotate();const rebound=await (await f.patch(f.input('pin',1))).json();assert.equal(rebound.route.needsFreshGrant,true);assert.equal(rebound.route.minimumGrantRevision,2);
  grant();assert.equal(f.surface.admin.listRoutes()[0].needsFreshGrant,false);
  f.changeSchema();const schema=await (await f.patch(f.input('schema',2))).json();assert.equal(schema.route.minimumGrantRevision,3);assert.equal(schema.route.needsFreshGrant,true);
  await f.patch(f.input('suspend',3,'suspended'));assert.equal((await f.patch(f.input('resume',4))).status,200);
  assert.equal((await f.patch(f.input('revoke',5,'revoked'))).status,200);assert.equal((await f.patch(f.input('restore',6))).status,403);
});
test('route + receipt commit together; failed receipt insert rolls route back',async t=>{
  const f=fixture(t);const db=new DatabaseSync(f.surface.databasePath);
  db.exec("CREATE TRIGGER qa_fail_receipt BEFORE INSERT ON device_route_receipts BEGIN SELECT RAISE(ABORT,'qa failure'); END;");
  assert.equal((await f.patch(f.input())).status,503);
  assert.equal(db.prepare('SELECT count(*) n FROM device_routes').get().n,0);assert.equal(db.prepare('SELECT count(*) n FROM device_route_receipts').get().n,0);
  db.exec('DROP TRIGGER qa_fail_receipt');db.close();assert.equal((await f.patch(f.input())).status,200);
});
test('schema 2 migration preserves routes, schema 3 exact validation includes immutable receipts and old 2 remains supported',async t=>{
  const f=fixture(t);await f.patch(f.input());
  let db=new DatabaseSync(f.surface.databasePath);assert.equal(deviceSurfaceSchemaLabel(db),'device-surface-v3');checkFullSchema(db,'deviceSurface');
  assert.throws(()=>db.prepare('UPDATE device_route_receipts SET request_hash=?').run('b'.repeat(64)));
  db.exec('DROP TABLE device_route_receipts');db.prepare("UPDATE meta SET value='2' WHERE key='schema'").run();checkFullSchema(db,'deviceSurface');assert.equal(deviceSurfaceSchemaLabel(db),'device-surface-v2');db.close();
  await f.reopen();db=new DatabaseSync(f.surface.databasePath);assert.equal(deviceSurfaceSchemaLabel(db),'device-surface-v3');assert.equal(db.prepare('SELECT count(*) n FROM device_routes').get().n,1);
  const before=preservedDigest(db,'deviceSurface');db.exec("CREATE TABLE unexpected (x TEXT)");assert.throws(()=>checkFullSchema(db,'deviceSurface'));db.exec('DROP TABLE unexpected');assert.equal(preservedDigest(db,'deviceSurface'),before);db.close();
  const old=new DatabaseSync(':memory:');old.exec(EXACT_SCHEMAS.deviceSurface2.sql);for(const [k,v]of[['schema','2'],['installation',f.store.hostId],['owner',f.store.ownerId]])old.prepare('INSERT INTO meta VALUES (?,?)').run(k,v);checkExactSchema(old,'deviceSurface');old.close();
});
test('paired-client router cannot configure routes; retained owner port refuses after shutdown and missing opt-in is 503',async t=>{
  const f=fixture(t);const remote=createAuthorizedHostRouter(f.store,{authority:()=>{throw Error('not invoked for absent owner routes')}});
  assert.equal((await remote.request('/v1/device-routes',{method:'PATCH',body:JSON.stringify(f.input())})).status,404);
  assert.equal((await createHostApp(f.store).request(`/v1/device-routes?botId=${f.bot.id}`)).status,503);
  f.stop();assert.equal((await f.patch(f.input())).status,503);
});
