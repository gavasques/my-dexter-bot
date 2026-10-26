import {HostServices} from '../../packages/cli/dist/host-services.js';
import {randomUUID} from 'node:crypto';
const dataDir=process.argv[2];
const backend={async capabilities(){return {supported:true,voices:['cove'],cliVersion:'synthetic'};},async start(_,emit){emit({kind:'sdp',sdp:'v=0\nSYNTHETIC_EPHEMERAL'});emit({kind:'started'});return {async speech(){},async text(){},async stop(){},async close(){}};}};
const s=new HostServices({dataDir,enableEngines:true,nativeVoiceBackend:backend,makeDriver:id=>({id,capabilities:{resume:false},async status(){return {engine:id,installed:true,version:'synthetic',authentication:'unknown',billing:'subscription'};},async open(threadId){return {threadId,nativeCursor:'synthetic'};},async *turn(){},async respondToTool(){},async interrupt(){},async close(){}})});
const bot=s.store.createBot({name:'Crash fixture',profileId:'synthetic',engine:'codex'}),thread=s.store.createThread(bot.id),sessionId=randomUUID(),generation=randomUUID();
await s.nativeVoice.start(thread.id,{expectedHostId:s.store.hostId,expectedBotId:bot.id,expectedBotRevision:bot.revision,expectedSelectionRevision:0,expectedRevision:0,clientRequestId:'crash-start',sessionId,generation,sdpOffer:'v=0\nSYNTHETIC_EPHEMERAL'});
process.stdout.write(JSON.stringify({threadId:thread.id,botId:bot.id,sessionId,generation})+'\n');
setInterval(()=>{},1000);
