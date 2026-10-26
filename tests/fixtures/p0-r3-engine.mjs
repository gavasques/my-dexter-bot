// Synthetic protocol only. No inference, authentication, account or personal configuration.
import {createInterface} from 'node:readline';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
const args=process.argv.slice(2),flag=n=>args.includes(n)?args[args.indexOf(n)+1]:undefined,sid=flag('--session-id')??flag('--resume');
const send=row=>process.stdout.write(JSON.stringify(row)+'\n');
if(args.includes('--version')){send({version:'synthetic'});process.exit(0);}
if(args.includes('auth')){send({loggedIn:true,authMethod:'claude.ai'});process.exit(0);}
let input='';for await(const line of createInterface({input:process.stdin}))input+=line;
const blocks=JSON.parse(input).message.content;
input=typeof blocks==='string'?blocks:blocks.filter(b=>b.type==='text').map(b=>b.text).join('\n');
const config=JSON.parse(flag('--mcp-config')).mcpServers.dexter_gateway;
const child=spawn(config.command,config.args,{env:{PATH:'/usr/bin:/bin'},stdio:['pipe','pipe','ignore']});
let seq=0,buffer='';const pending=new Map();
child.stdout.on('data',chunk=>{buffer+=chunk;while(buffer.includes('\n')){const index=buffer.indexOf('\n'),row=JSON.parse(buffer.slice(0,index));buffer=buffer.slice(index+1);pending.get(row.id)?.(row);pending.delete(row.id);}});
const rpc=(method,params)=>new Promise(resolve=>{const id=++seq;pending.set(id,resolve);child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'R3-synthetic',version:'1'}});
child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
send({type:'system',subtype:'init',session_id:sid,mcp_servers:[{name:'dexter_gateway',status:'connected'}]});
let answer;
if(input.includes('Host tool continuation.')){
  answer={kind:'continuation',receipt:JSON.parse(input.split('Tool receipt: ').at(-1)),imageBlocks:typeof blocks==='string'?[]:blocks.map(b=>b.type),imageHashes:typeof blocks==='string'?[]:blocks.filter(b=>b.type==='image').map(b=>createHash('sha256').update(Buffer.from(b.source.data,'base64')).digest('hex')),model:flag('--model'),effort:flag('--effort')};
}else{
  const mode=JSON.parse(input),catalog=(await rpc('tools/list',{})).result.tools;
  const tool=catalog.find(t=>t.title.startsWith('dexter.harness.terminal.run '));
  const started=rpc('tools/call',{name:tool.name,arguments:{callId:'r3-exact-call',input:mode.operation}});
  if(mode.exit){await new Promise(r=>setTimeout(r,mode.exitDelay??500));process.exit(0);}
  const result=await started;
  if(mode.consume && result.result?.structuredContent?.status!=='pending')send({type:'user',session_id:sid,message:{role:'user',content:[{type:'tool_result',tool_use_id:'r3-use',content:result.result.content}]}});
  answer={kind:mode.consume?'same-call':'abandoned',receipt:result.result?.structuredContent??null,error:result.error??null,usedReceipt:mode.consume===true};
}
send({type:'result',subtype:'success',result:JSON.stringify(answer),usage:{}});
child.stdin.end();await new Promise(r=>child.once('close',r));
