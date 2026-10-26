import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { McpOAuthClient } from '../packages/connectors/dist/index.js';

// Synthetic metadata/DCR/token responses only, plus Dexter's local loopback callback.
// No real provider request, dynamic registration, account, browser, secret store or inference.
const issuer='https://synthetic-issuer.example', resource='https://synthetic-resource.example/mcp';
const advertisedScopes=Array.from({length:118},(_,i)=>`synthetic_scope_${String(i).padStart(3,'0')}_${'x'.repeat(i<116?1:0)}`);
assert.equal(advertisedScopes.length,118);assert.equal(advertisedScopes.join(' ').length,2593);
const definition=id=>({id,name:'Synthetic large OAuth catalog',auth:'oauth',runsOn:'owner_mac',transport:{type:'streamable_http',url:resource}});
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const code=expected=>e=>e?.code===expected;
function fixture(t){
 let now=Date.now();const seen=[],saved=[],codes=new Map();let tokenSequence=0;
 const client=new McpOAuthClient({now:()=>now,store:{load:async()=>null,save:async value=>{saved.push(value);},remove:async()=>{}},fetch:async(input,init)=>{
  const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
  const body=init?.body===undefined?'':String(init.body);seen.push({url:url.href,method:init?.method??'GET',body});
  if(url.origin===new URL(resource).origin && url.pathname.startsWith('/.well-known/oauth-protected-resource'))
   return json({resource,authorization_servers:[issuer],scopes_supported:advertisedScopes});
  if(url.origin===issuer && url.pathname.startsWith('/.well-known/oauth-authorization-server'))
   return json({issuer,authorization_endpoint:`${issuer}/authorize`,token_endpoint:`${issuer}/token`,registration_endpoint:`${issuer}/register`,
    response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],token_endpoint_auth_methods_supported:['none'],
    authorization_response_iss_parameter_supported:true,code_challenge_methods_supported:['S256']});
  if(url.href===`${issuer}/register`){assert.equal(init.method,'POST');const registration=JSON.parse(body);return json({...registration,client_id:'synthetic-client'},201);}
  if(url.href===`${issuer}/token`){
   const values=new URLSearchParams(body),grant=values.get('grant_type');
   if(grant==='authorization_code'){
    const authorized=codes.get(values.get('code'));assert.ok(authorized);codes.delete(values.get('code'));
    assert.equal(values.get('client_id'),'synthetic-client');assert.equal(values.get('redirect_uri'),authorized.redirect);
    assert.equal(createHash('sha256').update(values.get('code_verifier')).digest('base64url'),authorized.challenge);
    assert.equal(values.get('resource'),resource);
    return json({access_token:`synthetic-access-${++tokenSequence}`,token_type:'Bearer',expires_in:120,refresh_token:'synthetic-refresh',
     ...(authorized.scope===null?{}:{scope:authorized.scope})});
   }
   assert.equal(grant,'refresh_token');assert.equal(values.get('client_id'),'synthetic-client');assert.equal(values.get('refresh_token'),'synthetic-refresh');
   assert.equal(values.get('resource'),resource);
   return json({access_token:`synthetic-access-${++tokenSequence}`,token_type:'Bearer',expires_in:3600,refresh_token:'synthetic-refresh-rotated',scope:'tools.read notes.read'});
  }
  throw Error('Unapproved network destination in synthetic OAuth fixture');
 }});
 t.after(()=>client.close());
 const consent=async start=>{
  const authorization=new URL(start.authorizationUrl),redirect=authorization.searchParams.get('redirect_uri');
  assert.equal(authorization.origin,issuer);assert.equal(authorization.searchParams.get('response_type'),'code');
  assert.equal(authorization.searchParams.get('code_challenge_method'),'S256');assert.equal(authorization.searchParams.get('resource'),resource);
  assert.match(authorization.searchParams.get('state'),/^[A-Za-z0-9_-]{43}$/);
  const callback=new URL(redirect);assert.equal(callback.hostname,'127.0.0.1');
  const authCode='synthetic-authorization-code';codes.set(authCode,{redirect,challenge:authorization.searchParams.get('code_challenge'),scope:authorization.searchParams.get('scope')});
  callback.searchParams.set('code',authCode);callback.searchParams.set('state',authorization.searchParams.get('state'));callback.searchParams.set('iss',issuer);
  const result=await fetch(callback,{redirect:'manual'});assert.equal(result.status,200);const html=await result.text();
  assert.ok(!html.includes(authCode));assert.ok(!html.includes('synthetic-access'));
 };
 return{client,seen,saved,consent,advance:ms=>{now+=ms;}};
}

test('OAuth: 118 advertised scopes totaling 2593 characters are valid metadata; omitted scope stays absent in DCR and authorization',async t=>{
 const f=fixture(t),d=definition('large-catalog-default'),start=await f.client.begin(d);
 const registration=f.seen.find(item=>item.url===`${issuer}/register`);assert.ok(registration);
 assert.ok(!Object.hasOwn(JSON.parse(registration.body),'scope'));assert.ok(!new URL(start.authorizationUrl).searchParams.has('scope'));
 assert.ok(!start.authorizationUrl.includes(advertisedScopes[0]));assert.equal(f.client.status(d).state,'authorizing');assert.equal(f.saved.length,0);
 await f.consent(start);await f.client.settled(d.id);assert.equal(f.client.status(d).state,'authorized');assert.equal(f.saved.length,1);
 assert.equal(f.saved[0].scope,null);assert.equal(f.client.access(d),'synthetic-access-1');assert.equal(f.client.pendingFlows,0);
});

test('OAuth: explicit bounded owner scope is preserved in DCR and authorization; PKCE callback and refresh keep resource binding',async t=>{
 const f=fixture(t),d=definition('large-catalog-explicit'),scope='tools.read notes.read',start=await f.client.begin(d,{scope});
 const registration=JSON.parse(f.seen.find(item=>item.url===`${issuer}/register`).body);
 assert.equal(registration.scope,scope);assert.equal(new URL(start.authorizationUrl).searchParams.get('scope'),scope);
 assert.notEqual(registration.scope,advertisedScopes.join(' '));await f.consent(start);await f.client.settled(d.id);
 assert.equal(f.saved.length,1);assert.equal(f.saved[0].scope,scope);assert.equal(f.saved[0].resource,resource);assert.equal(f.saved[0].resourceIndicator,resource);assert.equal(f.saved[0].issuer,issuer);
 f.advance(5*60_000);assert.equal(f.client.status(d).state,'expired');await f.client.refresh(d);
 assert.equal(f.saved.length,2);assert.equal(f.saved[1].scope,scope);assert.equal(f.saved[1].resource,resource);assert.equal(f.saved[1].resourceIndicator,resource);
 assert.equal(f.saved[1].issuer,issuer);assert.equal(f.client.access(d),'synthetic-access-2');
});

test('OAuth: invalid or overlong explicit scope is refused before metadata, DCR or listener, preserving an existing valid flow',async t=>{
 const f=fixture(t),d=definition('large-catalog-invalid');
 for(const scope of ['x'.repeat(1025),advertisedScopes.join(' '),'','tools.read  notes.read','tools.read\nnotes.read',123]){
  await assert.rejects(f.client.begin(d,{scope}),code('invalid_request'));assert.equal(f.seen.length,0);assert.equal(f.client.pendingFlows,0);
 }
 const start=await f.client.begin(d,{scope:'tools.read'}),requests=f.seen.length;
 await assert.rejects(f.client.begin(d,{scope:'x'.repeat(1025)}),code('invalid_request'));assert.equal(f.seen.length,requests);assert.equal(f.client.pendingFlows,1);
 assert.equal(f.client.status(d).state,'authorizing');await f.consent(start);await f.client.settled(d.id);assert.equal(f.client.status(d).state,'authorized');
});
