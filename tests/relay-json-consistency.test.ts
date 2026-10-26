// N3: actual non-STRICT storage and both checkpoint/relay openers, without normalizing persisted rows.
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
const {validateRelayAssociations}=await import(new URL('../../packages/operations/dist/checkpoint.js',import.meta.url).href) as {validateRelayAssociations(db:DatabaseSync):void};
const broken=(e:unknown)=>e instanceof OperationsError&&e.code==='reference_broken';
const read=(p:string)=>{const u=pathToFileURL(p);u.search='immutable=1';return new DatabaseSync(u,{readOnly:true});};
const mutate=(db:DatabaseSync,peer:string,column:'binding_json'|'sender_json',field:string,value:unknown)=>{
 for(const table of ['associations','history'])for(const row of db.prepare(`SELECT rowid AS n,${column} AS text FROM ${table} WHERE device_id=?`).all(peer)){
  const x=JSON.parse(row.text as string) as Record<string,unknown>;x[field]=value;db.prepare(`UPDATE ${table} SET ${column}=? WHERE rowid=?`).run(JSON.stringify(x),row.n!);
 }
};
const invalid=[['hex','0x2'],['coercible','2'],['zero',0],['negative',-1],['fraction',1.5],['unsafe',9007199254740992],['null',null],['boolean',true]] as const;
for(const [column,field] of [['binding_json','generation'],['binding_json','revision'],['sender_json','generation']] as const)
for(const [tag,value] of invalid)test(`embedded ${column}.${field} rejects ${tag} in actual persisted JSON`,async t=>{
 const s=await seedRotatedSource(t),dir=workspace(t,'g8json-');mkdirSync(join(dir,'relay-host'),{mode:0o700});const p=assocPath(dir);copyFileSync(assocPath(s.data),p);
 const w=new DatabaseSync(p);try{assert.equal(w.prepare("SELECT strict FROM pragma_table_list WHERE name='history'").get()!.strict,0);mutate(w,s.peer,column,field,value);const r=w.prepare(`SELECT typeof(${column}) AS storage,json_type(${column},'$.${field}') AS valueType FROM associations WHERE device_id=?`).get(s.peer)!;assert.equal(r.storage,'text');assert.equal(r.valueType,typeof value==='string'?'text':value===null?'null':typeof value==='boolean'?'true':Number.isInteger(value)?'integer':'real');}finally{w.close();}
 const bytes=readFileSync(p),names=readdirSync(join(dir,'relay-host')).sort(),db=read(p);try{assert.throws(()=>validateRelayAssociations(db),broken);}finally{db.close();}assert.deepEqual(readFileSync(p),bytes);assert.deepEqual(readdirSync(join(dir,'relay-host')).sort(),names);
 const c=compose(s.data);try{assert.throws(()=>new RelayAssociations(c.host,c.bindings,join(dir,'relay-host'),s.recipient2),e=>e instanceof Error&&'code' in e&&['invalid_input','conflict'].includes(e.code as string));}finally{await c.close();}
});

test('closed binding and pin grammar, host identity, archive references and active revision agree with the real opener',async t=>{
 const s=await seedRotatedSource(t),root=workspace(t,'g8json-refs-');let n=0;
 const changes:((db:DatabaseSync)=>void)[]=[
  d=>mutate(d,s.peer,'binding_json','extra',1),d=>mutate(d,s.peer,'binding_json','role','executor'),d=>mutate(d,s.peer,'binding_json','scopes',['chat.read','chat.read']),d=>mutate(d,s.peer,'binding_json','fingerprint','BAD'),
  d=>mutate(d,s.peer,'binding_json','installationId','other_host'),d=>mutate(d,s.peer,'sender_json','ownerId','other_owner'),d=>mutate(d,s.peer,'sender_json','signingPublicKey','AAAA'),d=>mutate(d,s.peer,'sender_json','extra',1),
  d=>mutate(d,s.peer,'sender_json','generation',3),d=>d.exec("UPDATE associations SET host_revision=1 WHERE status='active'"),
  d=>d.exec("UPDATE pins SET key_id='wrong_key' WHERE device_id='relay_host' AND generation=2"),
  d=>d.exec("UPDATE metadata SET recipient_json=json_set(recipient_json,'$.keyId','wrong_key')"),
 ];
 for(const change of changes){const dir=join(root,String(n++));mkdirSync(join(dir,'relay-host'),{recursive:true,mode:0o700});const p=assocPath(dir);copyFileSync(assocPath(s.data),p);const w=new DatabaseSync(p);try{change(w);}finally{w.close();}
  const bytes=readFileSync(p),db=read(p);try{assert.throws(()=>validateRelayAssociations(db),broken);}finally{db.close();}assert.deepEqual(readFileSync(p),bytes);
  const c=compose(s.data);try{assert.throws(()=>new RelayAssociations(c.host,c.bindings,join(dir,'relay-host'),s.recipient2),e=>e instanceof Error&&'code' in e&&['invalid_input','conflict'].includes(e.code as string));}finally{await c.close();}
 }
});

test('real capture refuses typed binding inconsistency without relay source writes, artifact or destination authority',async t=>{
 const s=await seedRotatedSource(t),p=assocPath(s.data),w=new DatabaseSync(p);try{mutate(w,s.peer,'binding_json','generation','0x2');}finally{w.close();}
 const bytes=readFileSync(p),names=readdirSync(join(s.data,'relay-host')).sort(),custody=operationsCustody(),coord=join(s.root,'coord'),output=join(s.root,'bad.dxg8');await cli(['coordinator','init','--coordinator',coord,'--owner-id',s.ownerId],custody);
 const lines:string[]=[];const rc=await runCli(['transfer','prepare','--data-dir',s.data,'--coordinator',coord,'--output',output],{custody:custody.provider,write:l=>lines.push(l)});assert.equal(rc,1);assert.equal(lines.length,1);assert.equal(JSON.parse(lines[0]!).error,'reference_broken');assert.equal(existsSync(output),false);assert.equal(readdirSync(s.root).some(x=>x.startsWith('.bad.dxg8')),false);assert.deepEqual(readFileSync(p),bytes);assert.deepEqual(readdirSync(join(s.data,'relay-host')).sort(),names);
 const db=read(join(coord,'authority-coordinator.sqlite'));try{assert.equal(db.prepare('SELECT COUNT(*) AS n FROM nonces').get()!.n,0);assert.equal(db.prepare("SELECT COUNT(*) AS n FROM checkpoints WHERE activated_at IS NOT NULL").get()!.n,0);}finally{db.close();}
});

test('rotated host2, retained host1 tombstones and sender generation3 preserve exact rows and open normally',async t=>{
 const s=await seedRotatedSource(t),dir=workspace(t,'g8json-good-');mkdirSync(join(dir,'relay-host'),{mode:0o700});const p=assocPath(dir);copyFileSync(assocPath(s.data),p);
 const pin=new RelayEndpoint({installationId:s.hostId,ownerId:s.ownerId,deviceId:s.peer,generation:3,keyId:'synthetic_sender_3'}).publicPin;
 const w=new DatabaseSync(p);try{w.prepare('INSERT INTO pins VALUES(?,?,?,?,?,?)').run(s.peer,3,pin.keyId,pin.signingPublicKey,pin.encryptionPublicKey,JSON.stringify(pin));for(const table of ['associations','history'])w.prepare(`UPDATE ${table} SET sender_json=? WHERE device_id=?`).run(JSON.stringify(pin),s.peer);}finally{w.close();}
 const before=dump(p,ASSOC_TABLES),db=read(p);try{validateRelayAssociations(db);}finally{db.close();}
 const c=compose(s.data);try{const a=new RelayAssociations(c.host,c.bindings,join(dir,'relay-host'),s.recipient2);try{const check=read(p);try{assert.equal(JSON.parse(check.prepare('SELECT sender_json FROM associations WHERE device_id=?').get(s.peer)!.sender_json as string).generation,3);}finally{check.close();}assert.equal(a.association(s.peer)!.hostRevision,2);assert.equal(a.association(s.peer)!.revision,3);assert.equal(a.association(s.rotatedPeer)!.hostRevision,1);assert.equal(a.association(s.revokedPeer)!.hostRevision,1);}finally{a.close();}}finally{await c.close();}assert.deepEqual(dump(p,ASSOC_TABLES),before);
});
