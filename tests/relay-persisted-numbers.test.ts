// Narrow O2 regression: real non-STRICT persisted SQLite, real checkpoint validator/capture and relay opener.
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { RelayEndpoint } from '@dexter/relay';
import { RelayAssociations } from '@dexter/relay-host';
import { OperationsError, runCli } from '@dexter/operations';
import { ASSOC_TABLES, assocPath, cli, compose, dump, operationsCustody, seedRotatedSource, workspace } from './fixtures/relay-reapproval-lab.js';
const { validateRelayAssociations, relayAssociationCounts } = await import(new URL('../../packages/operations/dist/checkpoint.js', import.meta.url).href) as {
 validateRelayAssociations(db:DatabaseSync):void;relayAssociationCounts(db:DatabaseSync):{hostRevision:number};
};
const broken=(e:unknown)=>e instanceof OperationsError&&e.code==='reference_broken';
const refused=(e:unknown)=>broken(e)||(e instanceof RangeError&&'code' in e&&e.code==='ERR_OUT_OF_RANGE');
const read=(p:string)=>{const url=pathToFileURL(p);url.search='immutable=1';return new DatabaseSync(url,{readOnly:true});};
const fields=[['metadata','host_revision','1=1'],['associations','revision','status=\'revoked\''],['associations','host_revision','status=\'revoked\''],['history','revision','action=\'revoke\''],['history','host_revision','action=\'revoke\''],['pins','generation','generation=1']] as const;
for(const [table,column,where] of fields)test(`persisted ${table}.${column} refuses non-integer storage and impossible counters`,async t=>{
 const s=await seedRotatedSource(t),dir=workspace(t,'g8num-');let n=0;
 const cases=[["'0x2'",'text'],["'invalid'",'text'],['0','integer'],['-1','integer'],['1.5','real'],['1e20','real'],['1e999','real'],['9007199254740992','integer']] as const;
 for(const [value,type] of cases){
  const p=join(dir,`${n++}.sqlite`);copyFileSync(assocPath(s.data),p);
  const writer=new DatabaseSync(p);try{assert.equal(writer.prepare("SELECT strict FROM pragma_table_list WHERE name=?").get(table)!.strict,0);const ids=writer.prepare(`SELECT rowid AS n FROM ${table} WHERE ${where}`).all().map(r=>r.n);assert.ok(ids.length);writer.exec(`UPDATE ${table} SET ${column}=${value} WHERE ${where}`);for(const id of ids)assert.equal(writer.prepare(`SELECT typeof(${column}) AS type FROM ${table} WHERE rowid=?`).get(id!)!.type,type);}finally{writer.close();}
  const bytes=readFileSync(p),entries=readdirSync(dir).sort(),db=read(p);
  try{assert.throws(()=>validateRelayAssociations(db),refused,`${table}.${column} ${value} stored as ${type}`);if(table==='metadata')assert.throws(()=>relayAssociationCounts(db),refused);}finally{db.close();}
  assert.deepEqual(readFileSync(p),bytes);assert.deepEqual(readdirSync(dir).sort(),entries);
 }
 // NULL (including a SQLite-bound NaN) is rejected by the canonical NOT NULL schema itself, without a migration.
 const p=join(dir,'null.sqlite');copyFileSync(assocPath(s.data),p);const db=new DatabaseSync(p);
 try{for(const value of [null,NaN])assert.throws(()=>db.prepare(`UPDATE ${table} SET ${column}=? WHERE ${where}`).run(value),/NOT NULL constraint failed/);}finally{db.close();}
});

test('integer rotations, older tombstones and peer generations beyond host generation remain compatible with the real opener',async t=>{
 const s=await seedRotatedSource(t),before=dump(assocPath(s.data),ASSOC_TABLES),db=read(assocPath(s.data));
 try{validateRelayAssociations(db);assert.equal(relayAssociationCounts(db).hostRevision,2);}finally{db.close();}
 const c=compose(s.data);try{const a=new RelayAssociations(c.host,c.bindings,join(s.data,'relay-host'),s.recipient2);try{assert.equal(a.association(s.revokedPeer)!.hostRevision,1);assert.equal(a.association(s.rotatedPeer)!.hostRevision,1);assert.equal(a.association(s.peer)!.revision,3);}finally{a.close();}}finally{await c.close();}
 assert.deepEqual(dump(assocPath(s.data),ASSOC_TABLES),before);
 // Sender generations are per device, not bounded by metadata.host_revision.
 const dir=workspace(t,'g8num-peer-');mkdirSync(join(dir,'relay-host'),{mode:0o700});const p=assocPath(dir);copyFileSync(assocPath(s.data),p);const w=new DatabaseSync(p);
 try{const publicPin=new RelayEndpoint({installationId:s.hostId,ownerId:s.ownerId,deviceId:s.peer,generation:3,keyId:'synthetic_key_3'}).publicPin;w.prepare('INSERT INTO pins VALUES(?,?,?,?,?,?)').run(s.peer,3,publicPin.keyId,publicPin.signingPublicKey,publicPin.encryptionPublicKey,JSON.stringify(publicPin));validateRelayAssociations(w);}finally{w.close();}
 const c2=compose(s.data);try{const a=new RelayAssociations(c2.host,c2.bindings,join(dir,'relay-host'),s.recipient2);try{assert.equal(a.association(s.peer)!.revision,3);}finally{a.close();}}finally{await c2.close();}
});

test('pin and history numeric relationships require contiguous generations and bounded host metadata',async t=>{
 const s=await seedRotatedSource(t),dir=workspace(t,'g8num-bounds-');let n=0;
 for(const sql of [
  "UPDATE metadata SET recipient_json=json_set(recipient_json,'$.generation','0x2')",
  "UPDATE metadata SET recipient_json=json_set(recipient_json,'$.generation',1)",
  "UPDATE pins SET pin_json=json_set(pin_json,'$.generation','0x1') WHERE generation=1",
  "UPDATE pins SET pin_json=json_set(pin_json,'$.generation',0) WHERE generation=1",
  "UPDATE pins SET pin_json=json_set(pin_json,'$.generation',1.5) WHERE generation=1",
  "UPDATE pins SET pin_json=json_set(pin_json,'$.generation',null) WHERE generation=1",
  "UPDATE pins SET pin_json=json_set(pin_json,'$.generation',9007199254740992) WHERE generation=1",
  "DELETE FROM pins WHERE device_id='relay_host' AND generation=1",
  "UPDATE metadata SET host_revision=3,recipient_json=json_set(recipient_json,'$.generation',3)",
  "UPDATE history SET host_revision=3 WHERE action='revoke'",
  "UPDATE history SET revision=4 WHERE action='revoke'",
 ]){const p=join(dir,`${n++}.sqlite`);copyFileSync(assocPath(s.data),p);const db=new DatabaseSync(p);try{db.exec(sql);assert.throws(()=>validateRelayAssociations(db),broken,sql);}finally{db.close();}}
});

test('real authority checkpoint capture refuses TEXT hex metadata without modifying relay source or publishing artifact/staging',async t=>{
 const s=await seedRotatedSource(t),p=assocPath(s.data),w=new DatabaseSync(p);try{w.exec("UPDATE metadata SET host_revision='0x2'");assert.equal(w.prepare('SELECT typeof(host_revision) AS type FROM metadata').get()!.type,'text');}finally{w.close();}
 const bytes=readFileSync(p),entries=readdirSync(join(s.data,'relay-host')).sort(),custody=operationsCustody(),coord=join(s.root,'coordinator'),output=join(s.root,'bad.dxg8');
 await cli(['coordinator','init','--coordinator',coord,'--owner-id',s.ownerId],custody);
 const lines:string[]=[];const rc=await runCli(['transfer','prepare','--data-dir',s.data,'--coordinator',coord,'--output',output],{custody:custody.provider,write:l=>lines.push(l)});
 assert.equal(rc,1);assert.equal(lines.length,1);const result=JSON.parse(lines[0]!);assert.equal(result.ok,false);assert.equal(result.error,'reference_broken');
 assert.equal(existsSync(output),false);assert.equal(readdirSync(s.root).some(x=>x.startsWith('.bad.dxg8')),false);assert.deepEqual(readFileSync(p),bytes);assert.deepEqual(readdirSync(join(s.data,'relay-host')).sort(),entries);
});
