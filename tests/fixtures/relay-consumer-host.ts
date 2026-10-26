// LAB ONLY adapter for the explicitly recorded PRIVATE canonical source-receipt staging patch.
import assert from "node:assert/strict";
import { ConversationRuntime, HostStore, type StartedTurn } from "@dexter/hub";
import { ConsumerError, type HostPort } from "../../packages/relay-consumer/src/index.js";
interface StagedStore extends HostStore { relaySourceHash(turnId:string):string }
interface StagedRuntime extends ConversationRuntime { startTurn(threadId:string,input:unknown,sourceHash?:string):StartedTurn }
export function canonicalHost(store:HostStore,runtime:ConversationRuntime):HostPort {
  assert.equal(typeof (store as StagedStore).relaySourceHash,'function','this laboratory requires the explicit private source-receipt staging patch; current root Hub is not credited');
  const binding=()=>{if(!ConversationRuntime.prototype.isBoundTo.call(runtime,store))throw new Error('foreign canonical runtime');};
  return {hostId:store.hostId,ownerId:store.ownerId,
    withWriterLease:work=>store.withWriterLease(()=>{binding();return work();}),
    checkThread:threadId=>store.withWriterLease(()=>{binding();const thread=store.getThread(threadId);const bot=store.getBot(thread.botId);assert.equal(bot.ownerId,store.ownerId);const status=runtime.status();if(status.state!=="running"||!status.engines.includes(bot.engine))throw new ConsumerError("unavailable");}),
    findTurn:(threadId,requestId)=>store.findTurn(threadId,requestId),turnInput:turnId=>store.turnInput(turnId),sourceHash:turnId=>(store as StagedStore).relaySourceHash(turnId),
    startTurn:(threadId,input,sourceHash)=>{binding();return (runtime as StagedRuntime).startTurn(threadId,input,sourceHash).turn;},
  };
}
