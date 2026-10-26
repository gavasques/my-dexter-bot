import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { HostStore, HostError } from '../packages/hub/dist/index.js';
import { createHostApp, createAuthorizedHostRouter } from '../packages/hub/dist/http.js';
import { nativeMcpHttpPort } from '../packages/cli/dist/native-mcp-services.js';
import { McpConnectorError } from '../packages/connectors/dist/index.js';
import { mcpSetupDiagnostic } from '../packages/contracts/dist/index.js';

// Inject only synthetic exceptions. No runtime, OAuth metadata request, custody, account or browser exists here.
function fixture(t){
 const root=realpathSync(mkdtempSync('/private/tmp/dexter-mcp-private-diagnostics-')),store=new HostStore({dataDir:join(root,'host')});let error,calls=0;
 const fail=()=>{calls++;throw error;},admin={startOAuth:async()=>fail(),unlockCredentials:async()=>fail(),lockCredentials:async()=>fail(),disconnectCredentials:async()=>fail(),
  credentialStatus:()=>fail(),discover:async()=>fail(),listServers:()=>fail()};
 const app=createHostApp(store,{mcp:nativeMcpHttpPort(()=>admin)});
 app.get('/synthetic-public-failure',()=>{throw new HostError('conflict','Fixed synthetic failure.',mcpSetupDiagnostic('authentication','oauth_metadata_invalid'));});
 const request=(path,body={})=>app.request(`http://127.0.0.1${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 return{store,app,request,get calls(){return calls;},setError:value=>{error=value;}};
}
const sentinel='synthetic-secret-sentinel-never-display';
const assertSafe=value=>assert.ok(!JSON.stringify(value).includes(sentinel));

test('Private OAuth/credential failures expose only validated fixed authentication diagnostics, preserving HTTP conflict and safe messages',async t=>{
 const f=fixture(t);
 for(const [code,recovery,path] of [
  ['oauth_metadata_invalid','owner_check_oauth_metadata','/v1/mcp/servers/synthetic/oauth/start'],
  ['oauth_client_required','owner_supply_registered_oauth_client','/v1/mcp/servers/synthetic/oauth/start'],
  ['custody_unavailable','owner_configure_private_custody','/v1/mcp/servers/synthetic/credentials/unlock']
 ]){
  f.setError(new McpConnectorError(code,sentinel));const response=await f.request(path);assert.equal(response.status,409);
  assert.equal(response.headers.get('cache-control'),'no-store');const body=await response.json();assertSafe(body);
  assert.deepEqual(body,{error:'conflict',message:`Native MCP credential unavailable: ${code}.`,diagnostic:{stage:'authentication',code,recovery}});
 }
 const before=f.calls;assert.equal((await createAuthorizedHostRouter(f.store).request('http://127.0.0.1/v1/mcp/servers/synthetic/oauth/start',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,403);
 assert.equal(f.calls,before);
 const hostile=await f.app.request('http://127.0.0.1/v1/mcp/servers/synthetic/oauth/start',{method:'POST',headers:{'content-type':'application/json',origin:'https://foreign.example'},body:'{}'});
 assert.equal(hostile.status,403);assert.equal(f.calls,before);
});

test('CAS conflicts and unknown outcomes remain distinct; no diagnosis is fabricated or exposed outside private auth routes',async t=>{
 const f=fixture(t),path='/v1/mcp/servers/synthetic/oauth/start';
 f.setError(new McpConnectorError('store_conflict',sentinel));let response=await f.request(path),body=await response.json();assert.equal(response.status,409);assertSafe(body);
 assert.deepEqual(body,{error:'conflict',message:'Native MCP request conflicts: store_conflict.'});
 f.setError(new Error(sentinel));response=await f.request(path);body=await response.json();assert.equal(response.status,409);assertSafe(body);
 assert.deepEqual(body,{error:'conflict',message:'Native MCP operation failed.'});
 f.setError(new HostError('outcome_unknown','Fixed unknown outcome.',mcpSetupDiagnostic('authentication','oauth_metadata_invalid')));
 response=await f.request(path);body=await response.json();assert.equal(response.status,409);assert.deepEqual(body,{error:'outcome_unknown',message:'Fixed unknown outcome.'});
 f.setError(new McpConnectorError('oauth_metadata_invalid',sentinel));response=await f.request('/v1/mcp/servers/synthetic/discover');body=await response.json();assert.equal(response.status,409);assertSafe(body);assert.ok(!Object.hasOwn(body,'diagnostic'));
 response=await f.app.request('http://127.0.0.1/synthetic-public-failure');body=await response.json();assert.equal(response.status,409);assert.ok(!Object.hasOwn(body,'diagnostic'));
 f.setError(new HostError('conflict','Fixed synthetic failure.',{stage:'authentication',code:'oauth_metadata_invalid',recovery:sentinel}));
 response=await f.request(path);body=await response.json();assert.equal(response.status,409);assertSafe(body);assert.ok(!Object.hasOwn(body,'diagnostic'));
 f.setError(new HostError('conflict','Fixed synthetic failure.',mcpSetupDiagnostic('registration','oauth_metadata_invalid')));
 response=await f.request(path);body=await response.json();assert.equal(response.status,409);assert.ok(!Object.hasOwn(body,'diagnostic'));
});
