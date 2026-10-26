import { mcpDirectoryClient } from "./fixtures/mcp-directory-client.mjs";
import { createHostApp } from "../packages/hub/dist/http.js";
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { HostServices } from '../packages/cli/dist/host-services.js';
import { APPROVAL_MODE_EFFECTS, APPROVAL_POLICY_SCOPE_VERSION } from '../packages/contracts/dist/index.js';

// Reuse the repository's existing synthetic protocol fixture, not an official model/account or new engine parser.
const fixtureSource=readFileSync(new URL('./p0-approval-continuation.test.mjs',import.meta.url),'utf8');
const nativeFixture=fixtureSource.match(/const nativeFixture = String.raw`([\s\S]*?)`;/)?.[1];
assert.ok(nativeFixture,'the pinned existing synthetic fixture is required');

test('D03 scripted engine consumes automatic terminal receipt and emits response without extra approval/turn/effect', {timeout:20000},async t=>{
 const root=realpathSync(mkdtempSync('/private/tmp/d03-runtime-')),executable=join(root,'synthetic-claude.mjs');
 writeFileSync(executable,`#!${process.execPath}\n${nativeFixture.replace('MCP_DIRECTORY_CLIENT_FACTORY',mcpDirectoryClient.toString())}`,{mode:0o700});
 const services=new HostServices({dataDir:join(root,'host'),enableMcp:true,enableEngines:true,engineCommands:{claude:executable},
  engineCatalog:()=>[{id:'claude',available:true,models:[{id:'fixture-opus',reasoningEfforts:['high'],speeds:[]}],defaultModel:'fixture-opus',reasoningEfforts:['high'],speeds:[]}]});
 t.after(async()=>{await services.shutdown();rmSync(root,{recursive:true,force:true});});
 const bot=services.store.createBot({name:'D03 synthetic',profileId:'synthetic',engine:'claude',
  defaultSelection:{engine:'claude',model:'fixture-opus',reasoningEffort:'high',speed:null}}),thread=services.store.createThread(bot.id);
 const app=createHostApp(services.store),access=await (await app.request(`/v1/bots/${bot.id}/execution-access`)).json();
 const enabled=await app.request(`/v1/bots/${bot.id}/execution-access`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({expectedHostId:access.hostId,clientRequestId:'human-runtime-enable',expectedBotRevision:access.botRevision,expectedInventoryHash:access.inventoryHash,scopeVersion:'d03.access.v1',operation:'terminal',enabled:true})});
 assert.equal(enabled.status,200);
 // Only full_access covers commands; approve_all intentionally preserves command approval.
 assert.equal(APPROVAL_MODE_EFFECTS.approve_all.commands,false);
 assert.equal(APPROVAL_MODE_EFFECTS.full_access.commands,true);
 services.store.setBotApprovalPolicy(bot.id,{expectedHostId:services.store.hostId,clientRequestId:'human-enabled-mode',expectedRevision:0,
  mode:'full_access',eligibleScopeVersion:APPROVAL_POLICY_SCOPE_VERSION});
 assert.equal(services.store.getEffectiveApprovalPolicy(thread.id).mode,'full_access');
 const {turn}=services.runtime.startTurn(thread.id,{clientRequestId:'synthetic-auto-input',content:'D03_AUTOMATIC_TERMINAL'});
 const completed=await services.runtime.waitForTurn(turn.id,12000).catch(error=>{
  t.diagnostic(JSON.stringify({turn:services.store.getTurn(turn.id),actions:services.store.listActions().map(a=>({id:a.id,tool:a.request.tool,state:a.state,reason:a.reason,authorization:a.authorization})),events:services.store.listTurnEvents({turnId:turn.id})}));throw error;
 });
 assert.equal(completed.state,'completed');
 const actions=services.store.listActions();assert.equal(actions.length,1);const action=actions[0];
 assert.equal(action.state,'succeeded');assert.equal(action.authorization.source,'owner_policy');
 const answer=JSON.parse(services.store.turnOutput(turn.id));
 assert.equal(answer.kind,'same-call');assert.equal(answer.receipt.status,'succeeded');assert.equal(answer.receipt.actionId,action.id);
 assert.equal(readFileSync(join(root,'host','bot-files',bot.id,'proof.txt'),'utf8'),'effect\n');
 assert.equal(services.store.toolActionProgress(action.id).deliveredToEngine,true);
 assert.equal(services.store.toolActionProgress(action.id).consumedByEngine,true);
 assert.equal(services.store.listActions('awaiting_approval').length,0);assert.equal(services.store.listActions('ready').length,0);
 assert.equal(services.store.listTurns(thread.id).length,1);
 assert.equal(services.store.requestAction(action.request).id,action.id);
 assert.equal(readFileSync(join(root,'host','bot-files',bot.id,'proof.txt'),'utf8'),'effect\n');
});
