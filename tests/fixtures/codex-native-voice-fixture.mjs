import {createInterface} from 'node:readline';
import {writeFileSync,mkdirSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const args=process.argv.slice(2),option=name=>args[args.indexOf(name)+1],mode=option('--fixture-mode')??'normal',record=option('--record');
const log=v=>{if(record)appendFileSync(record,JSON.stringify(v)+'\n');};
if(args.includes('--version')){console.log('codex-cli 0.162.1');process.exit(0);}
if(args.includes('generate-json-schema')) {
  const out=option('--out');mkdirSync(join(out,'v2'),{recursive:true});
  writeFileSync(join(out,'ClientRequest.json'),JSON.stringify({experimentalApi:true,methods:['thread/realtime/start','thread/realtime/stop','thread/realtime/appendText','thread/realtime/appendSpeech']}));
  writeFileSync(join(out,'v2/ThreadRealtimeStartParams.json'),JSON.stringify({properties:Object.fromEntries(['threadId','clientManagedHandoffs','transport','initialItems','voice'].map(n=>[n,{}])),definitions:{RealtimeConversationVersion:{enum:mode==='old'?['v1','v2']:['v1','v2','v3']},RealtimeVoice:{enum:['cove','juniper']},ThreadRealtimeStartTransport:{type:'webrtc'}}}));
  for(const name of ['ThreadRealtimeSdpNotification','ThreadRealtimeStartedNotification','ThreadRealtimeTranscriptDoneNotification','ThreadRealtimeItemAddedNotification','ThreadRealtimeClosedNotification'])writeFileSync(join(out,'v2/'+name+'.json'),'{}');
  log({kind:'metadata'});process.exit(0);
}
const send=v=>process.stdout.write(JSON.stringify(v)+'\n'),reply=(id,result)=>send({id,result}),native='synthetic_native_voice';
const notify=(method,params)=>send({method,params:{threadId:native,...params}});
const config={mcp_servers:{ambient_fixture:{enabled:true}},model_providers:{openai:{}},developer_instructions:''};
createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line),p=r.params??{};
 if(!r.method){log({kind:'native_denial',id:r.id,decision:r.result?.decision??null,success:r.result?.success??null});return;}
 if(r.method==='initialized')return;
 if(r.method==='initialize'){log({kind:'initialize',experimental:p.capabilities?.experimentalApi??false});reply(r.id,{});}
 else if(r.method==='account/read'){log({kind:'account_gate'});reply(r.id,{account:mode==='auth'?null:{type:'chatgpt'}});}
 else if(r.method==='config/read')reply(r.id,{config});
 else if(r.method==='thread/start'){log({kind:'fresh_native_thread',sandbox:p.sandbox,approvalPolicy:p.approvalPolicy,ambientDisabled:p.config?.mcp_servers?.ambient_fixture?.enabled===false});reply(r.id,{thread:{id:native},instructionSources:[]});}
 else if(r.method==='thread/realtime/start') {
   log({kind:'start',version:p.version,output:p.outputModality,managed:p.clientManagedHandoffs,voice:p.voice??null,initialRoles:(p.initialItems??[]).map(i=>i.role)});
   // Notifications can precede the empty native RPC response.
   send({method:'thread/realtime/sdp',params:{threadId:'wrong_thread',sdp:'v=0\nWRONG_SCOPE'}});
   notify('thread/realtime/sdp',{sdp:'v=0\nSYNTHETIC_PRIVATE_ANSWER'});
   notify('thread/realtime/started',{version:'v3'});
   if(mode==='error')notify('thread/realtime/error',{message:'SYNTHETIC_PROVIDER_DETAIL_NEVER_EXPOSE'});
   if(mode==='handoff') {
     notify('thread/realtime/transcript/done',{role:'user',text:'Unrelated previous greeting'});
     notify('thread/realtime/itemAdded',{item:{type:'handoff_request',handoff_id:'handoff_1',input_transcript:'Canonical spoken request'}});
     notify('thread/realtime/itemAdded',{item:{type:'handoff_request',handoff_id:'handoff_1',input_transcript:'Canonical spoken request'}});
     notify('turn/started',{turn:{id:'native_unbound_turn'}});
     send({id:'native_command',method:'item/commandExecution/requestApproval',params:{threadId:native}});
     send({id:'native_dynamic',method:'item/tool/call',params:{threadId:native}});
     notify('thread/realtime/outputAudio/delta',{audio:'SYNTHETIC_AUDIO_NEVER_STORE'});
   }
   reply(r.id,{});
 }else if(r.method==='turn/interrupt'){log({kind:'native_interrupted'});reply(r.id,{});}
 else if(r.method==='thread/realtime/appendSpeech'){log({kind:'speech',textHash:createHash('sha256').update(p.text).digest('hex')});reply(r.id,{});}
 else if(r.method==='thread/realtime/appendText'){log({kind:'text'});reply(r.id,{});}
 else if(r.method==='thread/realtime/stop'){log({kind:'stop'});notify('thread/realtime/closed',{reason:'SYNTHETIC_PROVIDER_DETAIL_NEVER_EXPOSE'});reply(r.id,{});}
 else send({id:r.id,error:{code:-32601,message:'SYNTHETIC_PROVIDER_DETAIL_NEVER_EXPOSE'}});
});
