import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {join,resolve,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';

// Only scoped synthetic Hub/HTTP/harness execution; no engine, account, UI, socket, credential or shell job.
const packageRoot=process.env.DEXTER_HARNESS_PACKAGE_ROOT;
if(packageRoot!==undefined&&!isAbsolute(packageRoot))throw new Error('Package root must be absolute.');
const moduleRoot=packageRoot??resolve('.');
const load=relative=>import(pathToFileURL(join(moduleRoot,packageRoot===undefined?relative:
  relative.replace(/^packages\/([^/]+)\//,'node_modules/@dexter/$1/'))).href);
const [{HostStore,HostError},{CapabilityGateway},{HarnessOperationSurface},{createHostApp,createAuthorizedHostRouter},contracts]=await Promise.all([
  load('packages/hub/dist/index.js'),load('packages/gateway/dist/index.js'),load('packages/cli/dist/harness-operation-surface.js'),
  load('packages/hub/dist/http.js'),load('packages/contracts/dist/index.js'),
]);
const {BOT_COMMUNICATION_TOOL:TOOL,BOT_COMMUNICATION_DESTINATION:DESTINATION,parseBotCommunicationConfirmation:parseIntent}=contracts;
const refused=error=>['invalid_input','forbidden','conflict','unauthorized','unavailable'].includes(error.code);

/** Also reusable by the own-GUI laboratory: real capability and proposal without inference. Store remains borrowed. */
export function communicationSurface(store){
  const gateway=new CapabilityGateway({store,broker:{acquire:()=>null},adapter:{execute:async()=>{throw new Error('No upstream in this lab.');}}});
  const surface=new HarnessOperationSurface({store,base:gateway,catalog:async()=>[],runtime:()=>{throw new Error('No inference runtime.');},
    skills:()=>({}),effectiveSkills:()=>[]});
  let sequence=0;
  const live=(bot,thread=store.createThread(bot.id))=>{
    const turn=store.createTurn(thread.id,{clientRequestId:`communication-lab-${++sequence}`,content:'Synthetic communication setup.'}).turn;
    assert.equal(store.claimNextTurn(thread.id).id,turn.id);
    const {token}=surface.issueCapability({turnId:turn.id});return{bot,thread,turn,token};
  };
  const call=(scope,args,callId=`proposal-${++sequence}`)=>surface.call(scope.token,{connectionId:DESTINATION,tool:TOOL,callId,arguments:args});
  const propose=async({bot,thread,changes,finish=true,callId})=>{
    const scope=live(bot,thread),pending=await call(scope,{expectedRevision:store.getBot(bot.id).revision,...changes},callId);
    const action=store.getAction(pending.actionId);
    if(finish)store.finishTurn(scope.turn.id,'completed',null);
    return{scope,pending,action};
  };
  return{gateway,surface,live,call,propose,async close(){await surface.close();gateway.close();}};
}

export async function runCommunicationFunctional(){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'dexter-communication-128-')));
  let now=Date.now(),store=new HostStore({dataDir:join(root,'host'),clock:()=>now}),composition=communicationSurface(store);
  const app=createHostApp(store),results=[];
  const request=async(method,path,body,router=app,authority)=>{
    const input={method,headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})};
    const response=authority?await router.fetch(new Request(`https://paired.invalid${path}`,input),{authority}):await router.request(`http://127.0.0.1${path}`,input);
    return{status:response.status,body:await response.json()};
  };
  const confirm=(proposal,text='yes',clientRequestId=`confirm-${proposal.action.id}`,extra={})=>request('POST',`/v1/threads/${proposal.scope.thread.id}/communication-confirmations`,
    {actionId:proposal.action.id,requestHash:proposal.action.requestHash,clientRequestId,text,...extra});
  const decide=(proposal,decision='allow',hash=proposal.action.requestHash)=>request('POST',`/v1/actions/${proposal.action.id}/decisions`,{decision,requestHash:hash});
  const record=async(name,body)=>{await body();results.push({name,status:'passed'});};
  let durable;
  try{
    const actor=store.createBot({name:'Synthetic Inbox Master',profileId:'synthetic',engine:'codex'});
    const peer=store.createBot({name:'Synthetic Specialist',profileId:'synthetic',engine:'codex'}),peerBefore=store.getBot(peer.id);
    await record('disabled flags admit own exact proposal; foreign/master/empty/type inputs refuse',async()=>{
      const scope=composition.live(actor),tool=composition.surface.listTools(scope.token).find(item=>item.name===TOOL);
      assert.ok(tool);assert.equal(tool.requiresApproval,true);assert.equal(store.getBot(actor.id).canSeeBots,false);
      for(const args of [{expectedRevision:0},{expectedRevision:0,canSeeBots:'true'},{expectedRevision:0,canSeeBots:true,botId:peer.id},
        {expectedRevision:0,canSendActions:true,isMaster:true}])await assert.rejects(composition.call(scope,args),refused);
      const args={expectedRevision:0,canSeeBots:true,canSendActions:true,canReceiveOrders:true};
      const first=await composition.call(scope,args,'exact-proposal'),again=await composition.call(scope,args,'exact-proposal');
      assert.equal(first.status,'awaiting_approval');assert.deepEqual(again,first);
      await assert.rejects(composition.call(scope,{...args,canReceiveOrders:false},'exact-proposal'),refused);
      const action=store.getAction(first.actionId);assert.equal(action.request.botId,actor.id);assert.equal(action.request.threadId,scope.thread.id);
      assert.deepEqual(action.request.arguments.input,args);assert.equal(action.grantRevision,store.getGrant(actor.id,TOOL,DESTINATION).revision);
      assert.equal(store.getGrant(actor.id,TOOL,DESTINATION).policy,'ask');assert.deepEqual(store.getBot(peer.id),peerBefore);
      durable={scope,pending:first,action};store.finishTurn(scope.turn.id,'completed',null);
      const master=store.createBot({name:'Synthetic Master invariant',profileId:'synthetic',engine:'codex'});
      store.patchBot(master.id,{expectedRevision:0,isMaster:true});
      const masterScope=composition.live(master);
      await assert.rejects(composition.call(masterScope,{expectedRevision:1,canSeeBots:false}),refused);
      store.finishTurn(masterScope.turn.id,'completed',null);
    });
    await record('literal approval after terminal turn applies once, records exact canonical text and durable receipt',async()=>{
      const beforeMessages=store.listMessages(durable.scope.thread.id).length,body=await confirm(durable,'  YES!  ','durable-128');
      assert.equal(body.status,200);const result=body.body;
      assert.equal(result.action.state,'succeeded');assert.equal(result.receipt.applied,true);assert.equal(result.receipt.clientRequestId,'durable-128');
      assert.deepEqual(result.receipt.changes,{canSeeBots:true,canSendActions:true,canReceiveOrders:true});
      assert.equal(result.bot.revision,1);assert.equal(result.bot.isMaster,false);assert.equal(result.messages[0].content,'  YES!  ');
      assert.equal(result.messages[0].role,'user');assert.equal(result.messages[1].role,'assistant');
      assert.equal(store.listMessages(durable.scope.thread.id).length,beforeMessages+2);
      const replay=await confirm(durable,'  YES!  ','durable-128');assert.equal(replay.status,200);assert.deepEqual(replay.body,result);
      assert.equal(store.getBot(actor.id).revision,1);assert.equal(store.listMessages(durable.scope.thread.id).length,beforeMessages+2);
      assert.equal((await confirm(durable,'yes','durable-128')).status,409);assert.equal((await confirm(durable,'yes','different-id')).status,409);
      assert.equal((await decide(durable,'deny')).status,409);assert.deepEqual(store.getBot(peer.id),peerBefore);
      await assert.rejects(composition.call(durable.scope,{expectedRevision:0,canSeeBots:true},'new-ended-call'),refused);
    });
    await record('whole-phrase denial and Permitir/Negar buttons finish atomically without model replay',async()=>{
      for(const text of ['sim','YES!',' pode fazer. ','Pode aplicar.','autorizo!!!'])assert.equal(parseIntent(text),'allow');
      for(const text of ['não','NAO.','no!','não pode','nao pode.'])assert.equal(parseIntent(text),'deny');
      for(const text of ['Pode aplicar?','yes?','nao pode?','yes, mas não envie','não, sim','sim para outro bot','não autorizo','talvez','yes\nsim','"yes"'])assert.equal(parseIntent(text),null);
      const denied=await composition.propose({bot:actor,changes:{canSendActions:false}}),revision=store.getBot(actor.id).revision;
      assert.equal((await confirm(denied,'não pode.')).body.action.state,'denied');assert.equal(store.getBot(actor.id).revision,revision);
      const button=await composition.propose({bot:actor,changes:{canReceiveOrders:false}});
      assert.equal((await decide(button)).body.state,'succeeded');assert.equal(store.getBot(actor.id).revision,revision+1);
      const messageCount=store.listMessages(button.scope.thread.id).length;assert.equal((await decide(button)).body.state,'succeeded');
      assert.equal(store.listMessages(button.scope.thread.id).length,messageCount);
      const buttonDenied=await composition.propose({bot:actor,changes:{canSendActions:false}});
      assert.equal((await decide(buttonDenied,'deny')).body.state,'denied');assert.equal(store.getBot(actor.id).canSendActions,true);
    });
    await record('hash, conversation, attachments, malformed text, duplicate proposals and client collisions refuse',async()=>{
      const p=await composition.propose({bot:actor,changes:{canSendActions:false}}),currentRevision=store.getBot(actor.id).revision;
      for(const text of ['Pode aplicar?','yes and send now','yes\nsim','não, pode fazer'])assert.equal((await confirm(p,text)).status,400);
      assert.equal((await confirm(p,'yes',undefined,{requestHash:'0'.repeat(64)})).status,409);
      assert.equal((await confirm(p,'yes',undefined,{attachmentIds:[]})).status,400);
      const wrongThread=store.createThread(peer.id);
      assert.equal((await request('POST',`/v1/threads/${wrongThread.id}/communication-confirmations`,
        {actionId:p.action.id,requestHash:p.action.requestHash,clientRequestId:'wrong-thread',text:'yes'})).status,403);
      const scope=composition.live(actor,p.scope.thread),second=await composition.call(scope,{expectedRevision:currentRevision,canSeeBots:false},'competing');
      store.finishTurn(scope.turn.id,'completed',null);assert.equal((await confirm(p)).status,409);
      assert.equal(store.getBot(actor.id).revision,currentRevision);assert.equal((await decide(p)).body.state,'succeeded');
      assert.equal((await request('POST',`/v1/actions/${second.actionId}/decisions`,{decision:'allow',requestHash:second.requestHash})).status,409);
      assert.equal(store.getAction(second.actionId).state,'blocked');
      const q=await composition.propose({bot:actor,thread:durable.scope.thread,changes:{canSendActions:true}});
      assert.equal((await confirm(q,'yes','durable-128')).status,409);assert.equal(store.getAction(q.action.id).state,'awaiting_approval');
      await decide(q,'deny');
    });
    await record('expired approvals, changed grants, stale revisions and wrong paired authority cannot apply',async()=>{
      const expired=await composition.propose({bot:actor,changes:{canSeeBots:false}});now+=11*60_000;
      assert.equal((await confirm(expired)).status,409);assert.equal(store.getAction(expired.action.id).reason,'approval_expired');
      const changed=await composition.propose({bot:actor,changes:{canSeeBots:false}});
      store.setGrant({botId:actor.id,tool:TOOL,destination:DESTINATION,policy:'ask'});
      // setGrant already revokes pending admissions. The confirmation sees a terminal action (409), not a live
      // action failing the in-transaction grant check (403). Both refuse; canonical state proves the boundary.
      assert.equal(store.getAction(changed.action.id).state,'blocked');assert.equal(store.getAction(changed.action.id).reason,'permission_changed');
      assert.equal((await confirm(changed)).status,409);
      const stale=await composition.propose({bot:actor,changes:{canSeeBots:false}}),before=store.getBot(actor.id);
      store.patchBot(actor.id,{expectedRevision:before.revision,roleDescription:'Synthetic newer revision.'});
      assert.equal((await confirm(stale)).status,409);assert.equal(store.getAction(stale.action.id).state,'blocked');
      const authorized=await composition.propose({bot:actor,changes:{canSeeBots:false}}),router=createAuthorizedHostRouter(store);
      const authority={principal:'paired-client',installationId:store.hostId,ownerId:store.ownerId,deviceId:'dev_synthetic_client',role:'client-mac',
        scopes:['chat.write'],pinGeneration:1,bindingRevision:1,assertCurrent(){},noteSelfRevoke(){}};
      const body={actionId:authorized.action.id,requestHash:authorized.action.requestHash,clientRequestId:'paired-decision',text:'yes'};
      assert.equal((await request('POST',`/v1/threads/${authorized.scope.thread.id}/communication-confirmations`,body,router,authority)).status,403);
      authority.scopes=['approvals.decide'];let checks=0;authority.assertCurrent=()=>{if(++checks>=2)throw new HostError('forbidden','Revoked synthetic binding.');};
      assert.equal((await request('POST',`/v1/threads/${authorized.scope.thread.id}/communication-confirmations`,body,router,authority)).status,403);
      assert.equal(store.getAction(authorized.action.id).state,'awaiting_approval');
      await decide(authorized,'deny');assert.deepEqual(store.getBot(peer.id),peerBefore);
    });
    await record('receipt reopens durably and restart replay does not reapply or add messages',async()=>{
      const revision=store.getBot(actor.id).revision,count=store.listMessages(durable.scope.thread.id).length;
      await composition.close();store.close();store=new HostStore({dataDir:join(root,'host'),clock:()=>now});composition=communicationSurface(store);
      const response=store.confirmBotCommunication(durable.scope.thread.id,{actionId:durable.action.id,requestHash:durable.action.requestHash,clientRequestId:'durable-128',text:'  YES!  '});
      assert.equal(response.action.state,'succeeded');assert.equal(response.receipt.revision,1);assert.equal(store.getBot(actor.id).revision,revision);
      assert.equal(store.listMessages(durable.scope.thread.id).length,count);assert.deepEqual(store.getBot(peer.id),peerBefore);
    });
    return{status:'passed',cases:results,realEngineExecuted:false,accountsOrSecretsUsed:false};
  }finally{await composition.close();store.close();rmSync(root,{recursive:true,force:true});}
}
if(import.meta.url===pathToFileURL(process.argv[1]??'').href){
  try{process.stdout.write(JSON.stringify(await runCommunicationFunctional())+'\n');}
  catch(error){process.stdout.write(JSON.stringify({status:'failed',errorClass:error?.name??'Error',message:error?.message??'Unknown fixture failure'})+'\n');process.exitCode=1;}
}
