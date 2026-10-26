import assert from 'node:assert/strict';
import {test} from 'node:test';
import {serviceLab,hostLab,type HostLab,type ServiceLab} from './fixtures/connections-lab.js';
async function connected(host:HostLab,svc:ServiceLab){
  const bot=host.store.createBot({name:'Journal fixture',profileId:'default',engine:'claude'}),catalog=await host.runtime.admin.catalog();
  const started=await host.runtime.admin.startAuthorization({expectedHostID:host.store.hostId,clientRequestId:'auth-journal',serviceId:'gmail',catalogPin:catalog.pin,profileId:null,label:null,replacesAccountId:null});
  const ref=[...svc.composio.accounts.keys()][0]!;svc.composio.complete(ref,'Synthetic');
  const done=await host.runtime.admin.authorization(started.authorization.clientRequestId),account=host.runtime.admin.accounts().items.find(a=>a.id===done.accountId)!;
  return {bot,account};
}
test('Hub commit before extension receipt: GET after restart settles once without reapplying any grant',async t=>{
  const svc=await serviceLab(t),host=await hostLab(t,svc),{bot,account}=await connected(host,svc);
  const input={expectedHostID:host.store.hostId,clientRequestId:'grant-after-commit',expectedRevision:account.revision,botId:bot.id,enabled:true};
  const original=host.store.applyGrantBatch.bind(host.store);let writes=0;
  host.store.applyGrantBatch=(plan)=>{writes++;original(plan);throw new Error('synthetic post-commit crash');};
  assert.throws(()=>host.runtime.admin.setAccess(account.id,input),(e:{code?:string})=>e.code==='outcome_unknown');assert.equal(writes,1);
  const grants=account.tools.map(tool=>host.store.getGrant(bot.id,tool.name,account.gatewayConnectionIds[0]!)!);
  assert.deepEqual(account.tools.map(tool=>host.store.getGrant(bot.id,tool.name,account.gatewayConnectionIds[0]!)),grants);
  await host.reopen();const receipt=host.runtime.admin.receipt(input.clientRequestId);assert.ok(receipt);assert.equal(receipt.revision,account.revision+1);
  assert.deepEqual(host.runtime.admin.setAccess(account.id,input),receipt);
  assert.deepEqual(account.tools.map(tool=>host.store.getGrant(bot.id,tool.name,account.gatewayConnectionIds[0]!)),grants);
});
test('prepared without Hub receipt resolves not_applied; replay never reexecutes and a new owner request works',async t=>{
  const svc=await serviceLab(t),host=await hostLab(t,svc),{bot,account}=await connected(host,svc);
  const input={expectedHostID:host.store.hostId,clientRequestId:'grant-before-commit',expectedRevision:account.revision,botId:bot.id,enabled:true};let writes=0;
  host.store.applyGrantBatch=()=>{writes++;throw new Error('synthetic before commit');};
  assert.throws(()=>host.runtime.admin.setAccess(account.id,input),(e:{code?:string})=>e.code==='outcome_unknown');
  const receipt=host.runtime.admin.receipt(input.clientRequestId);assert.equal(receipt?.accessOutcome,'not_applied');assert.equal(receipt?.revision,account.revision);
  assert.deepEqual(host.runtime.admin.setAccess(account.id,input),receipt);assert.equal(writes,1);
  await host.reopen();assert.deepEqual(host.runtime.admin.receipt(input.clientRequestId),receipt);
  assert.deepEqual(host.runtime.admin.setAccess(account.id,input),receipt);
  assert.ok(account.tools.every(tool=>host.store.getGrant(bot.id,tool.name,account.gatewayConnectionIds[0]!)===null));
  const next=host.runtime.admin.setAccess(account.id,{...input,clientRequestId:'new-reviewed-request'});assert.equal(next.revision,account.revision+1);
  assert.ok(account.tools.every(tool=>host.store.getGrant(bot.id,tool.name,account.gatewayConnectionIds[0]!)?.policy==='ask'));
});
test('committed batch followed by account rename resolves superseded without rollback or permanent lock',async t=>{
  const svc=await serviceLab(t),host=await hostLab(t,svc),{bot,account}=await connected(host,svc);
  const input={expectedHostID:host.store.hostId,clientRequestId:'commit-then-rename',expectedRevision:account.revision,botId:bot.id,enabled:true};
  const original=host.store.applyGrantBatch.bind(host.store);let writes=0;
  host.store.applyGrantBatch=plan=>{writes++;original(plan);throw new Error('synthetic post-commit interruption');};
  assert.throws(()=>host.runtime.admin.setAccess(account.id,input),(e:{code?:string})=>e.code==='outcome_unknown');
  const label=host.runtime.admin.setLabel(account.id,{expectedHostID:host.store.hostId,clientRequestId:'rename-after-commit',expectedRevision:account.revision,label:'New label'});
  const grants=account.tools.map(tool=>host.store.getGrant(bot.id,tool.name,account.gatewayConnectionIds[0]!));
  const receipt=host.runtime.admin.receipt(input.clientRequestId);assert.equal(receipt?.accessOutcome,'superseded');assert.equal(receipt?.revision,label.revision);assert.equal(writes,1);
  assert.deepEqual(host.runtime.admin.setAccess(account.id,input),receipt);assert.equal(writes,1);
  assert.deepEqual(account.tools.map(tool=>host.store.getGrant(bot.id,tool.name,account.gatewayConnectionIds[0]!)),grants);
  host.store.applyGrantBatch=original;
  const next=host.runtime.admin.setAccess(account.id,{...input,clientRequestId:'next-after-rename',expectedRevision:label.revision,enabled:false});
  assert.equal(next.revision,label.revision+1);assert.ok(account.tools.every(tool=>host.store.getGrant(bot.id,tool.name,account.gatewayConnectionIds[0]!)?.policy==='deny'));
});
test('a pre-commit failure followed by rename retains the failed request revision and never reports applied',async t=>{
  const svc=await serviceLab(t),host=await hostLab(t,svc),{bot,account}=await connected(host,svc);
  const input={expectedHostID:host.store.hostId,clientRequestId:'not-applied-before-rename',expectedRevision:account.revision,botId:bot.id,enabled:true};
  host.store.applyGrantBatch=()=>{throw new Error('synthetic no commit');};
  assert.throws(()=>host.runtime.admin.setAccess(account.id,input),(e:{code?:string})=>e.code==='outcome_unknown');
  host.runtime.admin.setLabel(account.id,{expectedHostID:host.store.hostId,clientRequestId:'rename-failed-request',expectedRevision:account.revision,label:'After failure'});
  const receipt=host.runtime.admin.receipt(input.clientRequestId);assert.equal(receipt?.accessOutcome,'not_applied');assert.equal(receipt?.revision,input.expectedRevision);assert.equal(receipt?.access?.tools,0);
  assert.deepEqual(host.runtime.admin.setAccess(account.id,input),receipt);
  assert.ok(account.tools.every(tool=>host.store.getGrant(bot.id,tool.name,account.gatewayConnectionIds[0]!)===null));
});
