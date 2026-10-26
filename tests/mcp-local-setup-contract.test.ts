import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostStore } from '@dexter/hub';
import { createHostApp,type HostConnectionsPort,type HostConnectionWorkflowsPort } from '@dexter/hub/http';
import { CompleteConnectionWorkflowSchema } from '@dexter/contracts';

test('owner setup accepts a five-account selection over 4 KiB, rejects over 64 KiB before admission, and keeps unrelated writes small',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'dx-setup-body-')),store=new HostStore({dataDir:dir});
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  let effects=0;
  const workflows={complete:(_id:string,input:unknown)=>{effects++;return input;}} as unknown as HostConnectionWorkflowsPort;
  const app=createHostApp(store,{connections:{} as HostConnectionsPort,connectionWorkflows:workflows});
  const input={expectedHostID:store.hostId,clientRequestId:randomUUID(),expectedRevision:1,selections:Array.from({length:5},(_,i)=>({
    connectionId:`con_synthetic_${i}`,expectedRevision:1,tools:Array.from({length:32},(_,j)=>({name:`tool_${j}`,manifestHash:'a'.repeat(64)}))}))};
  assert(Buffer.byteLength(JSON.stringify(input))>4096);
  const post=(path:string,value:unknown)=>app.request('http://127.0.0.1'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});
  assert.equal((await post('/v1/connections/setup-requests/setup_synthetic/complete',input)).status,200);
  assert.equal(effects,1);
  const oversized={...input,selections:input.selections.map(v=>({...v,tools:Array.from({length:256},(_,j)=>({name:`tool_${j}`,manifestHash:'a'.repeat(64)}))}))};
  assert(!CompleteConnectionWorkflowSchema.safeParse(oversized).success);
  assert.equal((await post('/v1/connections/setup-requests/setup_synthetic/complete',oversized)).status,413);assert.equal(effects,1);
  assert.equal((await post('/v1/connections/authorizations',{padding:'x'.repeat(5000)})).status,413);
});
