import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { HostError, HostStore } from "@dexter/hub";
import { createHostApp } from "@dexter/hub/http";
import {
  BROWSER_USE_META_KEY, BrowserUseBotPolicySchema, BrowserUseConfigurationSchema,
  browserUseConfigurationJSON, defaultBrowserUseBotPolicy, defaultBrowserUseConfiguration,
} from "@dexter/contracts";
import { checkExactSchema, EXACT_SCHEMAS } from "../packages/operations/src/exact.js";
import { checkFullSchema } from "../packages/operations/src/full-schemas.js";

const TOOL="dexter.browseruse.run", DESTINATION="browser-use-cloud";
function fixture(t:TestContext) {
  const directory=mkdtempSync(join(realpathSync(tmpdir()),"dexter-browser-config-"));
  const store=new HostStore({dataDir:directory});
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const bot=store.createBot({name:"Synthetic Browser",profileId:"synthetic",engine:"codex"});
  const thread=store.createThread(bot.id);
  return {store,directory,bot,thread};
}
const enabledPolicy=()=>({...defaultBrowserUseBotPolicy(),enabled:true,allowedDomains:["www.example.com","example.com"]});
const code=(expected:string)=>(error:unknown)=>error instanceof HostError&&error.code===expected;

test("Browser Use policy admits exact domains and unique dedicated profiles; defaults grant nothing",t=>{
  const {store,bot}=fixture(t);
  assert.deepEqual(store.getBrowserUseConfiguration(),defaultBrowserUseConfiguration());
  assert.equal(store.getGrant(bot.id,TOOL,DESTINATION),null);
  for(const domain of ["https://example.com","*.example.com","example.com:443","Example.com","127.0.0.1","localhost","x.local","x.internal"])
    assert.equal(BrowserUseBotPolicySchema.safeParse({...enabledPolicy(),allowedDomains:[domain]}).success,false,domain);
  assert.equal(BrowserUseBotPolicySchema.safeParse({...enabledPolicy(),allowedDomains:[]}).success,false);
  assert.equal(BrowserUseBotPolicySchema.safeParse({...enabledPolicy(),allowedDomains:["example.com","example.com"]}).success,false);
  assert.equal(BrowserUseBotPolicySchema.safeParse({...enabledPolicy(),maxSteps:101}).success,false);
  assert.equal(BrowserUseBotPolicySchema.safeParse({...enabledPolicy(),timeoutSeconds:241}).success,false);
  const profileId="00000000-0000-4000-8000-000000000001";
  assert.equal(BrowserUseConfigurationSchema.safeParse({...defaultBrowserUseConfiguration(),bots:{
    bot_a:{...enabledPolicy(),profileId},bot_b:{...enabledPolicy(),profileId},
  }}).success,false);
});

test("Browser Use owner CAS atomically creates ask grants and disabling blocks stale approvals",t=>{
  const {store,bot,thread}=fixture(t);
  const input={expectedHostID:store.hostId,expectedRevision:0,enabled:true,bots:{[bot.id]:enabledPolicy()}};
  const saved=store.patchBrowserUseSettings(input);
  assert.equal(saved.revision,1);
  assert.deepEqual(saved.bots[bot.id]!.allowedDomains,["example.com","www.example.com"]);
  assert.equal(store.getGrant(bot.id,TOOL,DESTINATION)?.policy,"ask");
  const action=store.requestAction({botId:bot.id,threadId:thread.id,tool:TOOL,destination:DESTINATION,
    arguments:{task:"Read a synthetic public page."},idempotencyKey:"synthetic-task"});
  assert.equal(action.state,"awaiting_approval");
  assert.throws(()=>store.setGrant({botId:bot.id,tool:TOOL,destination:DESTINATION,policy:"allow"}),code("invalid_input"));
  assert.throws(()=>store.patchBrowserUseSettings(input),code("conflict"));
  assert.throws(()=>store.patchBrowserUseSettings({...input,expectedRevision:1,expectedHostID:"host_other"}),code("forbidden"));
  assert.equal(store.getBrowserUseSettings().revision,1);
  store.patchBrowserUseSettings({...input,expectedRevision:1,enabled:false});
  assert.equal(store.getGrant(bot.id,TOOL,DESTINATION)?.policy,"deny");
  assert.equal(store.getAction(action.id).state,"blocked");
  assert.throws(()=>store.decideAction(action.id,{decision:"allow",requestHash:action.requestHash}),code("conflict"));
});

test("Browser Use own-bot CAS preserves other policy and refuses foreign references without writes",t=>{
  const {store,bot}=fixture(t);
  const second=store.createBot({name:"Other synthetic bot",profileId:"synthetic",engine:"claude"});
  store.patchBrowserUseSettings({expectedHostID:store.hostId,expectedRevision:0,enabled:true,
    bots:{[bot.id]:enabledPolicy(),[second.id]:{...enabledPolicy(),maxSteps:7}}});
  const saved=store.patchBrowserUseBotPolicy(bot.id,{expectedHostID:store.hostId,expectedRevision:1,
    policy:{...enabledPolicy(),maxSteps:5}});
  assert.equal(saved.revision,2);
  assert.equal(saved.bots[bot.id]!.maxSteps,5);
  assert.equal(saved.bots[second.id]!.maxSteps,7);
  assert.throws(()=>store.patchBrowserUseBotPolicy(bot.id,{expectedHostID:store.hostId,expectedRevision:1,policy:enabledPolicy()}),code("conflict"));
  assert.throws(()=>store.patchBrowserUseSettings({expectedHostID:store.hostId,expectedRevision:2,enabled:true,
    bots:{...saved.bots,bot_foreign:enabledPolicy()}}),code("not_found"));
  assert.deepEqual(store.getBrowserUseSettings(),saved);
});

test("Browser Use optional schema9 metadata is admitted by backup and open-existing, corruption fails closed",t=>{
  const {store,directory,bot}=fixture(t);
  store.patchBrowserUseSettings({expectedHostID:store.hostId,expectedRevision:0,enabled:true,bots:{[bot.id]:enabledPolicy()}});
  const identity={installationId:store.hostId,ownerId:store.ownerId};
  const raw=new DatabaseSync(store.databasePath);let rawOpen=true;
  t.after(()=>{if(rawOpen)raw.close();});
  assert.deepEqual(checkFullSchema(raw,"hub"),identity);
  const config=store.getBrowserUseConfiguration();
  raw.prepare("UPDATE meta SET value=? WHERE key=?").run(JSON.stringify({...config,apiKey:"synthetic-secret"}),BROWSER_USE_META_KEY);
  assert.throws(()=>checkFullSchema(raw,"hub"));
  assert.throws(()=>store.getBrowserUseConfiguration(),code("conflict"));
  store.close();
  assert.throws(()=>new HostStore({dataDir:directory,existingInstallation:identity}));
  raw.prepare("UPDATE meta SET value=? WHERE key=?").run(browserUseConfigurationJSON(config),BROWSER_USE_META_KEY);
  raw.close();rawOpen=false;
  const reopened=new HostStore({dataDir:directory,existingInstallation:identity});
  assert.deepEqual(reopened.getBrowserUseConfiguration(),config);
  reopened.close();
  const historic=new DatabaseSync(":memory:");
  t.after(()=>historic.close());
  historic.exec(EXACT_SCHEMAS.hub8.sql);
  historic.exec("PRAGMA user_version=8");
  historic.prepare("INSERT INTO meta(key,value)VALUES(?,?)").run("host_id",identity.installationId);
  historic.prepare("INSERT INTO meta(key,value)VALUES(?,?)").run("owner_id",identity.ownerId);
  assert.deepEqual(checkExactSchema(historic,"hub8"),identity);
  historic.prepare("INSERT INTO meta(key,value)VALUES(?,?)").run(BROWSER_USE_META_KEY,browserUseConfigurationJSON(defaultBrowserUseConfiguration()));
  assert.throws(()=>checkExactSchema(historic,"hub8"));
});

test("Browser Use owner HTTP exposes nonsecret config and invalidates runs; key and foreign-origin writes refuse",async t=>{
  const {store,bot}=fixture(t);
  let changed=0;
  const app=createHostApp(store,{browserUse:{status:()=>({hostID:store.hostId,credentialPresent:false,authentication:"unknown"}),changed:()=>{changed++;}}});
  const call=(method:string,body?:unknown,origin?:string)=>app.request("http://127.0.0.1/v1/browser-use/config",{
    method,headers:{"content-type":"application/json",...(origin?{origin}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const initial=await call("GET");
  assert.equal(initial.status,200);
  assert.equal(initial.headers.get("cache-control"),"no-store");
  assert.equal((await initial.json() as {enabled:boolean}).enabled,false);
  const input={expectedHostID:store.hostId,expectedRevision:0,enabled:true,bots:{[bot.id]:enabledPolicy()}};
  assert.equal((await call("PATCH",input,"https://foreign.example.com")).status,403);
  assert.equal((await call("PATCH",{...input,apiKey:"synthetic-private-input"})).status,400);
  assert.equal((await call("PATCH",input)).status,200);
  assert.equal(changed,1);
  assert.equal((await call("PATCH",input)).status,409);
  const status=await app.request("http://127.0.0.1/v1/browser-use/status");
  assert.deepEqual(await status.json(),{hostID:store.hostId,credentialPresent:false,authentication:"unknown"});
  assert.equal((await createHostApp(store).request("http://127.0.0.1/v1/browser-use/status")).status,503);
  assert.equal((await app.request("https://foreign.example.com/v1/browser-use/config")).status,403);
});
