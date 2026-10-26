import type { HostStore } from '@dexter/hub';
import { ContextError } from './types.js';
import { MemoryLearningStore } from './memory-learning.js';
import { MemoryLearningWorker, type SemanticMemoryExtractor } from './memory-semantic-extractor.js';
/** Root owns the host lifecycle/timers and authentic driver discovery. This bridge never provisions a backend. */
export class MemoryLearningCoordinator {
 readonly worker:MemoryLearningWorker;private active:Promise<void>|null=null;private stopped=false;
 constructor(readonly host:HostStore,readonly store:MemoryLearningStore,extractor:SemanticMemoryExtractor|undefined,private readonly lastChatAt:()=>number){this.worker=new MemoryLearningWorker(store,extractor,()=>host.listTurnsByState('running').length===0&&host.listTurnsByState('queued').length===0,lastChatAt);}
 tick():Promise<void>{if(this.stopped)return Promise.resolve();return this.active??=(async()=>{for(const intent of this.host.memoryCaptureIntents(20)){if(this.stopped)break;try{const result=this.store.ingest(intent);this.host.consumeMemoryCaptureIntent(intent.id,result.state);}catch(e){if(e instanceof ContextError&&['forbidden','conflict','invalid_input'].includes(e.code))this.host.consumeMemoryCaptureIntent(intent.id,'withdrawn');else throw e;}}
  for(const bot of this.host.listBots())if(!this.stopped)this.store.scheduleDream(bot.id,this.lastChatAt());if(!this.stopped)await this.worker.tick();})().finally(()=>{this.active=null;});}
 chatStarted():void{this.worker.interruptForChat();}
 stopAdmission():void{this.stopped=true;this.worker.stopAdmission();}
 async close():Promise<void>{this.stopAdmission();await this.active;await this.worker.close();}
}
