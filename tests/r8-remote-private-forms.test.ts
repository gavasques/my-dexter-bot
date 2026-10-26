import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {MCP_PRIVATE_INPUT_WIRE_LIMITS,mcpPrivateInputCanonicalBytes} from '@dexter/contracts';
import {validateMcpPrivateInputResponses} from '@dexter/connectors';
import {call} from './app-client-lab.js';
import {privateInputRemoteLab} from './r8-private-input-lab.js';

const journal=(path:string)=>{const db=new DatabaseSync(path,{readOnly:true});try{return db.prepare("SELECT key,value FROM meta WHERE key GLOB 'mcp_private*' ORDER BY key").all();}finally{db.close();}};
test('R8 real paired mTLS: 300 terminal rows cannot poison active discovery, max legitimate form hydrates and correctable answer commits once',{timeout:60_000},async t=>{
 const f=await privateInputRemoteLab();t.after(()=>f.close());
 assert.equal(mcpPrivateInputCanonicalBytes(f.maximum),624_353);
 const sizeDb=new DatabaseSync(f.store.databasePath,{readOnly:true});
 const historyBytes=Number(sizeDb.prepare("SELECT SUM(length(CAST(value AS BLOB))) AS n FROM meta WHERE key GLOB 'mcp_private_input_v1:mcpform_history_*'").get()!.n);sizeDb.close();
 assert.ok(historyBytes>262_144,'the 300 ordinary terminal forms alone exceed the old paired response cap');
 const reader=f.identity('reader'),manager=f.identity('manager'),denied=f.identity('denied');
 await f.pair(reader,['mcp.read']);await f.pair(manager,['mcp.manage','mcp.read']);await f.pair(denied,['chat.read']);
 const before=journal(f.store.databasePath);
 for(const path of ['/v1/mcp/input-requests',`/v1/mcp/input-requests/${f.input.id}`]){
  const refusal=await call(f.trust,denied,'GET',path);assert.equal(refusal.status,403);assert.ok(!JSON.stringify(refusal.json).includes('requestedSchema'));
 }
 const active=await call(f.trust,reader,'GET','/v1/mcp/input-requests');
 assert.equal(active.status,200);assert.equal(active.json.version,2);assert.equal(active.json.activeRequestCount,2);assert.equal((active.json.summaries as unknown[]).length,2);
 assert.ok(!JSON.stringify(active.json).includes('requestedSchema'));assert.ok(!JSON.stringify(active.json).includes('requests"'));
 let after:string|undefined,total=0;const ids=new Set<string>();
 do{
  const page=await call(f.trust,reader,'GET','/v1/mcp/input-requests?view=history&limit=100'+(after?'&after='+after:''));assert.equal(page.status,200);
  assert.ok(mcpPrivateInputCanonicalBytes(page.json)<=262_144);assert.equal(page.json.retainedRequestCount,302);
  const summaries=page.json.summaries as {id:string;detailState:string}[];
  summaries.forEach(row=>{assert.ok(!ids.has(row.id));ids.add(row.id);assert.equal(row.detailState,'not_loaded');});total+=summaries.length;after=page.json.nextCursor as string|undefined;
 }while(after);
 assert.equal(total,302);assert.deepEqual(journal(f.store.databasePath),before,'all GETs preserve canonical evidence and UUID reservations');
 const detail=await call(f.trust,reader,'GET',`/v1/mcp/input-requests/${f.input.id}`);assert.equal(detail.status,200);assert.ok(mcpPrivateInputCanonicalBytes(detail.json)>262_144);assert.deepEqual(detail.json.requests,f.maximum);
 t.diagnostic(JSON.stringify({ordinaryHistoryRows:300,ordinaryHistoryBytes:historyBytes,maximumRequestsBytes:mcpPrivateInputCanonicalBytes(f.maximum),maximumGetBytes:mcpPrivateInputCanonicalBytes(detail.json),activeSummaryBytes:mcpPrivateInputCanonicalBytes(active.json)}));
 const ownerList=await f.owner.request('http://127.0.0.1/v1/mcp/input-requests?view=history');assert.equal(ownerList.status,200);assert.equal((await ownerList.json()).version,2);
 const ownerDetail=await f.owner.request(`http://127.0.0.1/v1/mcp/input-requests/${f.input.id}`);assert.equal(ownerDetail.status,200);assert.deepEqual((await ownerDetail.json()).requests,f.maximum);
 const responses=Object.fromEntries(Object.entries(f.maximum).map(([key,request])=>[key,{action:'accept',content:Object.fromEntries(Object.keys((request as {params:{requestedSchema:{properties:object}}}).params.requestedSchema.properties).map(name=>[name,'']))}]));
 const body={expectedHostID:f.store.hostId,clientRequestId:randomUUID(),expectedRevision:1,actionId:f.input.actionId,requestHash:f.input.requestHash,responses,approval:'approve_exact_input'};
 const key=Object.keys(responses)[0]!;
 const invalid={...body,responses:{...responses,[key]:{action:'accept',content:{...responses[key]!.content,v0:true}}}};
 const wrong=await call(f.trust,reader,'POST',`/v1/mcp/input-requests/${f.input.id}/respond`,body);assert.equal(wrong.status,403);assert.equal(f.effects(),0);
 const bad=await call(f.trust,manager,'POST',`/v1/mcp/input-requests/${f.input.id}/respond`,invalid);assert.equal(bad.status,400);assert.equal(f.coordinator.get(f.input.id)!.revision,1);assert.equal(f.effects(),0);assert.deepEqual(journal(f.store.databasePath),before);
 const secret={...body,responses:{...responses,[key]:{action:'accept',content:{...responses[key]!.content,v0:'SYNTHETIC_PRIVATE_SECRET'}}}};
 const blocked=await call(f.trust,manager,'POST',`/v1/mcp/input-requests/${f.input.id}/respond`,secret);assert.equal(blocked.status,400);assert.equal(f.coordinator.get(f.input.id)!.state,'pending');assert.equal(f.effects(),0);
 const receipt=await call(f.trust,manager,'POST',`/v1/mcp/input-requests/${f.input.id}/respond`,body);assert.equal(receipt.status,200);assert.equal(receipt.json.state,'answered');assert.ok(mcpPrivateInputCanonicalBytes(receipt.json)>262_144);
 const done=await f.operation;assert.equal(done.status,'succeeded');assert.equal(f.effects(),1);
 const replay=await call(f.trust,manager,'POST',`/v1/mcp/input-requests/${f.input.id}/respond`,body);assert.deepEqual(replay.json,receipt.json);assert.equal(f.effects(),1);
 assert.equal((await call(f.trust,manager,'POST',`/v1/mcp/input-requests/${f.input.id}/respond`,{...body,responses:{...responses,[key]:{action:'decline'}}})).status,409);
 assert.equal(f.store.mcpPrivateInputResponseOwner(body.clientRequestId),f.input.id);
 assert.equal(MCP_PRIVATE_INPUT_WIRE_LIMITS.answerBytes,528_384);
});

test('R8 page corruption is isolated, payload validity stays explicitly unverified, history is append-only',{timeout:60_000},async t=>{
 const f=await privateInputRemoteLab();t.after(()=>f.close());const db=new DatabaseSync(f.store.databasePath);t.after(()=>db.close());
 db.prepare('INSERT INTO meta(key,value)VALUES(?,?)').run('mcp_private_input_v1:zz_broken','{"requests":');
 const invalid={...f.input,id:'zz_body_unverified',requests:{}};
 db.prepare('INSERT INTO meta(key,value)VALUES(?,?)').run('mcp_private_input_v1:zz_body_unverified',JSON.stringify(invalid));
 const before=journal(f.store.databasePath),page=f.coordinator.page({view:'history',limit:2});
 assert.equal(page.invalidRequestCount,1);assert.equal(page.invalidCountScope,'page_envelopes');assert.equal(page.unverifiedRequestCount,1);assert.equal(page.summaries[0]!.detailState,'not_loaded');assert.equal(page.incomplete,true);assert.ok(page.nextCursor);
 assert.throws(()=>f.coordinator.get('zz_body_unverified'));assert.deepEqual(journal(f.store.databasePath),before);
 for(const query of [{limit:101},{view:'bogus'},{after:'../escape'},{view:'history',extra:'x'}])assert.throws(()=>f.coordinator.page(query as never));
});

test('R8 dedicated answer budget carries legitimately escaped >256KiB answers; generic and lookalike routes keep old limits',{timeout:60_000},async t=>{
 const f=await privateInputRemoteLab();t.after(()=>f.close());const manager=f.identity('large-manager'),reader=f.identity('large-reader');await f.pair(manager,['mcp.manage','mcp.read']);await f.pair(reader,['mcp.read']);
 const responses=Object.fromEntries(Object.entries(f.maximum).map(([key,request])=>[key,{action:'accept',content:{...Object.fromEntries(Object.keys((request as {params:{requestedSchema:{properties:object}}}).params.requestedSchema.properties).map(name=>[name,''])),v0:'\0'.repeat(10_000),v1:'\0'.repeat(850)}}]));
 const body={expectedHostID:f.store.hostId,clientRequestId:randomUUID(),expectedRevision:1,actionId:f.input.actionId,requestHash:f.input.requestHash,responses,approval:'approve_exact_input'};
 assert.ok(mcpPrivateInputCanonicalBytes(body)>262_144);assert.ok(mcpPrivateInputCanonicalBytes(body)<MCP_PRIVATE_INPUT_WIRE_LIMITS.answerBytes);
 t.diagnostic(JSON.stringify({acceptedAnswerBytes:mcpPrivateInputCanonicalBytes(body),privateAnswerCap:MCP_PRIVATE_INPUT_WIRE_LIMITS.answerBytes}));
 const tooLarge=structuredClone(responses);for(const response of Object.values(tooLarge))Object.assign(response.content,{v1:'\0'.repeat(10_000),v2:'\0'.repeat(10_000)});
 assert.ok(mcpPrivateInputCanonicalBytes(tooLarge)>1_048_576);assert.throws(()=>validateMcpPrivateInputResponses(f.maximum,tooLarge),'unchanged native per-content 64KiB validation refuses the 1.44MiB counterexample');
 const headers={'content-type':'application/json','content-length':String(mcpPrivateInputCanonicalBytes(body))};
 assert.equal((await call(f.trust,reader,'POST',`/v1/mcp/input-requests/${f.input.id}/respond`,undefined,{headers})).status,403,'denied scope before private body');
 assert.equal((await call(f.trust,manager,'POST',`/v1/mcp/input-requests/${f.input.id}/respond?extra=1`,undefined,{headers})).status,413,'query cannot select dedicated envelope');
 assert.equal((await call(f.trust,manager,'POST','/v1/mcp/input-requests-lookalike/x/respond',undefined,{headers})).status,413);
 const owner=await f.owner.request(`http://127.0.0.1/v1/mcp/input-requests/${f.input.id}/respond`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.equal(owner.status,200);assert.equal((await owner.json()).state,'answered');
 const answer=await call(f.trust,manager,'POST',`/v1/mcp/input-requests/${f.input.id}/respond`,body);assert.equal(answer.status,200);assert.equal(answer.json.state,'answered');assert.equal((await f.operation).status,'succeeded');assert.equal(f.effects(),1);
 assert.equal(f.store.mcpPrivateInputResponseOwner(body.clientRequestId),f.input.id);
});

test('R8 answer envelope reserve covers maximum origin identities, eight 128-byte request keys and closed wrappers',t=>{
 const responses=Object.fromEntries(Array.from({length:8},(_,n)=>[String(n)+'r'.repeat(127),{action:'accept',content:{}}]));
 const envelope={expectedHostID:'h'.repeat(128),clientRequestId:randomUUID(),expectedRevision:Number.MAX_SAFE_INTEGER,actionId:'a'.repeat(128),requestHash:'f'.repeat(64),responses,approval:'approve_exact_input'};
 const overhead=mcpPrivateInputCanonicalBytes(envelope)-8*mcpPrivateInputCanonicalBytes({});
 assert.ok(overhead<4096);assert.equal(MCP_PRIVATE_INPUT_WIRE_LIMITS.answerBytes,8*65_536+4096);
 t.diagnostic(JSON.stringify({maximumAnswerEnvelopeOverhead:overhead,reservedBytes:4096}));
});
