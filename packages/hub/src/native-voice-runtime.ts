import { createHash, randomUUID } from 'node:crypto';
import { StartNativeVoiceSchema,StopNativeVoiceSchema,PatchNativeVoicePreferenceSchema,NativeVoiceEventSchema,type NativeVoicePreference,type NativeVoicePreferenceReceipt,type NativeVoiceBackend,type NativeVoiceCode,type NativeVoiceConnection,type NativeVoiceEvent,type NativeVoiceJournal,type NativeVoiceProviderEvent,type NativeVoiceReceipt,type NativeVoiceSession,type NativeVoiceStatus } from '@dexter/contracts';
import type { HostStore } from './store.js';
import { canonicalJson } from './store.js';
import type { ConversationRuntime } from './runtime.js';
import { HostError } from './errors.js';

const terminal=(s:NativeVoiceSession)=>['closed','failed','unknown'].includes(s.state);
const hash=(v:unknown)=>createHash('sha256').update(canonicalJson(v as Parameters<typeof canonicalJson>[0])).digest('hex');
interface Live {
  connection?:NativeVoiceConnection;opening?:Promise<void>;closing?:Promise<void>;answer?:{sdpAnswer:string;expiresAt:number};
  events:NativeVoiceEvent[];cursor:number;timer:ReturnType<typeof setInterval>;turns:Set<string>;handoffs:Map<string,string>;
  started:boolean;admission:boolean;tasks:Set<Promise<void>>;
}
/** Owner-local call control. Realtime is a media frontend; all actions execute on canonical Host turns. */
export class NativeVoiceRuntime {
  private journal:NativeVoiceJournal;
  private live=new Map<string,Live>();
  private admission=true;
  private closing:Promise<void>|undefined;
  private unsubscribe:()=>void;
  constructor(private readonly store:HostStore,private readonly runtime:ConversationRuntime,private readonly backend:NativeVoiceBackend,private readonly now=()=>Date.now(),private readonly isPrivateScope:(threadId:string)=>boolean=()=>true) {
    this.journal=store.nativeVoice.read();
    let changed=false;
    for(const s of this.journal.sessions)if(!terminal(s)){s.state='unknown';s.code='host_stopping';s.revision++;s.updatedAt=this.now();s.endedAt=this.now();changed=true;}
    if(changed)this.persist();
    this.unsubscribe=runtime.subscribe(notice=>{
      for(const [id,l] of this.live)if(l.turns.has(notice.turnId)&&this.admitted(id)) {
        this.event(id,{kind:'turn',turnId:notice.turnId,state:notice.state});
        if(notice.state==='completed') {
          const t=store.getTurn(notice.turnId);
          if(t.outputMessageId) {
            const content=store.nativeVoiceTurnOutput(t.id,t.threadId);
            if(content&&content.length<=8192)this.task(id,async()=>{await l.opening;if(this.admitted(id))await l.connection?.speech(content);});
          }
        }
      }
    });
  }
  private persist():void {this.store.nativeVoice.save(this.journal);}
  private session(id:string):NativeVoiceSession {this.store.assertActiveWriter();const s=this.journal.sessions.find(s=>s.id===id);if(!s)throw new HostError('not_found','Native voice session not found.');return s;}
  private pins(threadId:string):{botId:string;botRevision:number;selectionRevision:number;selection:NativeVoiceSession['selection']} {
    const t=this.store.getThread(threadId),b=this.store.getBot(t.botId),sel=this.store.getThreadEngineSelection(threadId);
    if(!this.isPrivateScope(threadId)||t.audience==='group'||t.groupId||t.teamId||threadId.startsWith('thr_team_')||threadId.startsWith('thr_group_'))throw new HostError('forbidden','Native voice requires a private conversation.');
    if(sel.selection.engine!=='codex')throw new HostError('forbidden','native_voice_unsupported');
    return {botId:b.id,botRevision:b.revision,selectionRevision:sel.revision,selection:{...sel.selection,engine:'codex'}};
  }
  private scopeCurrent(s:NativeVoiceSession):boolean {
    try {const p=this.pins(s.threadId);return this.admission&&p.botId===s.botId&&p.botRevision===s.botRevision&&p.selectionRevision===s.selectionRevision&&hash(p.selection)===hash(s.selection)&&s.expiresAt>this.now();}catch{return false;}
  }
  private admitted(id:string):boolean {
    const s=this.session(id),l=this.live.get(id);
    if(!l?.admission||terminal(s))return false;
    if(!this.scopeCurrent(s)){this.fail(id,'scope_changed');return false;}
    return true;
  }
  private set(id:string,state:NativeVoiceSession['state'],code:NativeVoiceCode|null=null):void {
    const s=this.session(id);s.state=state;s.code=code;if(terminal(s))s.endedAt??=this.now();s.revision++;s.updatedAt=this.now();this.persist();
  }
  private event(id:string,event:Omit<NativeVoiceEvent,'cursor'|'sessionId'|'generation'>):void {
    const l=this.live.get(id);if(!l)return;
    if(l.events.length>=512){this.fail(id,'protocol_error');return;}
    l.events.push(NativeVoiceEventSchema.parse({cursor:++l.cursor,sessionId:id,generation:this.session(id).generation,...event}));
  }
  private task(id:string,fn:()=>Promise<void>):void {
    const l=this.live.get(id);if(!l)return;
    const task=Promise.resolve().then(fn).catch(()=>{if(l.admission)this.fail(id,'provider_failed');}).finally(()=>l.tasks.delete(task));l.tasks.add(task);
  }
  private closeOwned(id:string):Promise<void> {
    const l=this.live.get(id);if(!l)return Promise.resolve();
    l.admission=false;delete l.answer;clearInterval(l.timer);
    for(const turnId of l.turns){const t=this.store.getTurn(turnId);if(['queued','running'].includes(t.state))this.runtime.cancelTurn(turnId);}
    return l.closing??=(async()=>{await l.opening?.catch(()=>{});try{await l.connection?.stop();}finally{await l.connection?.close();}await Promise.all([...l.tasks]);})();
  }
  private fail(id:string,code:NativeVoiceCode):void {
    const s=this.session(id),l=this.live.get(id);if(terminal(s))return;
    if(l){l.admission=false;delete l.answer;clearInterval(l.timer);}
    this.set(id,'failed',code);this.event(id,{kind:'failed',code});
    void this.closeOwned(id).catch(()=>{this.set(id,'unknown',code);});
  }
  async status(threadId:string):Promise<NativeVoiceStatus> {
    const t=this.store.getThread(threadId),b=this.store.getBot(t.botId),sel=this.store.getThreadEngineSelection(threadId);
    let valid=true;try{this.pins(threadId);}catch{valid=false;}
    const capabilities=valid&&this.admission?await this.backend.capabilities():{supported:false,voices:[],cliVersion:null};
    return {hostId:this.store.hostId,botId:b.id,threadId,botRevision:b.revision,selectionRevision:sel.revision,
      supported:capabilities.supported,code:capabilities.supported?null:this.admission?'native_voice_unsupported':'host_stopping',authentication:'unknown',billing:'subscription_cli',protocol:'v3',transport:'webrtc',voices:capabilities.voices,cliVersion:capabilities.cliVersion,
      activeSessionId:this.journal.sessions.find(s=>s.threadId===threadId&&!terminal(s))?.id??null};
  }
  get(id:string):NativeVoiceSession {const s=this.session(id);if(!terminal(s)&&!this.scopeCurrent(s))this.fail(id,'scope_changed');return structuredClone(this.session(id));}
  receipt(threadId:string,clientRequestId:string):{receipt:NativeVoiceReceipt;session:NativeVoiceSession} {
    this.store.getThread(threadId);const r=this.journal.receipts.find(r=>r.threadId===threadId&&r.clientRequestId===clientRequestId);
    if(!r)throw new HostError('not_found','Native voice receipt not found.');return {receipt:{...r},session:this.get(r.sessionId)};
  }
  async start(threadId:string,input:unknown):Promise<{receipt:NativeVoiceReceipt;session:NativeVoiceSession}> {
    const data=StartNativeVoiceSchema.parse(input),requestHash=hash({threadId,...data});
    const prior=this.journal.receipts.find(r=>r.threadId===threadId&&r.clientRequestId===data.clientRequestId);
    if(prior){if(prior.requestHash!==requestHash||prior.operation!=='start')throw new HostError('conflict','Native voice request differs.');return this.receipt(threadId,data.clientRequestId);}
    if(!this.admission)throw new HostError('host_locked','host_stopping');
    const pins=this.pins(threadId);
    if(data.expectedHostId!==this.store.hostId||data.expectedBotId!==pins.botId)throw new HostError('forbidden','scope_changed');
    if(data.expectedBotRevision!==pins.botRevision||data.expectedSelectionRevision!==pins.selectionRevision)throw new HostError('conflict','scope_changed');
    if(this.journal.sessions.some(s=>s.id===data.sessionId||!terminal(s)))throw new HostError('conflict','Native voice already active.');
    if(this.journal.sessions.length>=256||this.journal.receipts.length>=1024)throw new HostError('conflict','receipt_capacity');
    const effectiveVoice=data.voice??this.preference(pins.botId).voice??undefined;
    const s:NativeVoiceSession={cursor:(this.journal.sessions.at(-1)?.cursor??0)+1,startedAt:null,endedAt:null,turnIds:[],id:data.sessionId,hostId:this.store.hostId,threadId,generation:data.generation,...pins,voice:effectiveVoice??null,state:'starting',revision:1,code:null,createdAt:this.now(),updatedAt:this.now(),expiresAt:this.now()+30*60_000};
    const r:NativeVoiceReceipt={id:randomUUID(),operation:'start',clientRequestId:data.clientRequestId,threadId,sessionId:s.id,generation:s.generation,hostId:s.hostId,requestHash,createdAt:this.now()};
    this.journal.sessions.push(s);this.journal.receipts.push(r);this.persist();
    const l:Live={events:[],cursor:0,turns:new Set(),handoffs:new Map(),started:false,admission:true,tasks:new Set(),timer:setInterval(()=>{if(!terminal(s)&&!this.scopeCurrent(s))this.fail(s.id,'scope_changed');else if(s.state==='starting'&&this.now()-s.createdAt>=15000)this.fail(s.id,'timeout');},1000)};
    l.timer.unref();this.live.set(s.id,l);
    l.opening=(async()=>{
      const caps=await this.backend.capabilities();if(!this.admitted(s.id))return;
      if(!caps.supported){this.fail(s.id,'native_voice_unsupported');return;}
      if(!data.sdpOffer||Buffer.byteLength(data.sdpOffer)>65536||!data.sdpOffer.startsWith('v=0')){this.fail(s.id,'audio_client_missing');return;}
      if(effectiveVoice&&!caps.voices.includes(effectiveVoice)){this.fail(s.id,'model_unsupported');return;}
      const initialItems=this.store.liveVoiceHistory(threadId).filter((m):m is {role:'user'|'assistant';text:string}=>['user','assistant'].includes(m.role)&&m.text.length<=8192).slice(-8);
      while(initialItems.reduce((n,m)=>n+m.text.length,0)>24000)initialItems.shift();
      l.connection=await this.backend.start({threadId,selection:s.selection,sdpOffer:data.sdpOffer,assertCurrent:()=>{if(!this.admitted(s.id))throw new HostError('forbidden','scope_changed');},...(effectiveVoice?{voice:effectiveVoice}:{}),initialItems},e=>this.provider(s.id,e));
      if(!this.admitted(s.id)){await l.connection.close();return;}
    })().catch(error=>{const code=error instanceof Error&&'code' in error?String(error.code):'';this.fail(s.id,code==='authentication_required'?'auth_needed':code==='unsupported'?'native_voice_unsupported':code==='timeout'?'timeout':'provider_failed');});
    await l.opening;return this.receipt(threadId,data.clientRequestId);
  }
  private provider(id:string,e:NativeVoiceProviderEvent):void {
    if(!this.admitted(id))return;const l=this.live.get(id)!;
    if(e.kind==='sdp') {
      if(!e.sdp||Buffer.byteLength(e.sdp)>65536||!e.sdp.startsWith('v=0')){this.fail(id,'protocol_error');return;}
      l.answer={sdpAnswer:e.sdp,expiresAt:Math.min(this.session(id).expiresAt,this.now()+60_000)};
      if(l.started)this.set(id,'active');
    }else if(e.kind==='started'){l.started=true;this.session(id).startedAt??=this.now();this.persist();if(l.answer)this.set(id,'active');this.event(id,{kind:'started'});}
    else if(e.kind==='transcript') {
      if(!e.role||!e.text||e.text.length>8192||/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(e.text))return;
      this.event(id,{kind:'transcript',role:e.role,text:e.text});
    }else if(e.kind==='handoff') {
      if(!e.handoffId||!/^[A-Za-z0-9_-]{1,128}$/.test(e.handoffId)){this.fail(id,'protocol_error');return;}
      if(!e.text||e.text.length>8192||/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(e.text)){this.fail(id,'handoff_missing_transcript');return;}
      const prior=l.handoffs.get(e.handoffId);if(prior){if(prior!==hash(e.text))this.fail(id,'protocol_error');return;}
      if(l.handoffs.size>=64){this.fail(id,'protocol_error');return;}
      l.handoffs.set(e.handoffId,hash(e.text));
      const s=this.session(id);
      try{const result=this.runtime.startTurn(s.threadId,{clientRequestId:`nv_${hash({id,handoffId:e.handoffId}).slice(0,60)}`,content:e.text});l.turns.add(result.turn.id);s.turnIds.push(result.turn.id);this.persist();this.event(id,{kind:'turn',turnId:result.turn.id,state:result.turn.state});}
      catch{this.fail(id,'scope_changed');}
    }else if(e.kind==='failed')this.fail(id,e.code??'provider_failed');
    else if(e.kind==='closed'){this.set(id,'closed');this.event(id,{kind:'closed'});void this.closeOwned(id).catch(()=>this.set(id,'unknown','provider_failed'));}
  }
  events(id:string,after=0,limit=50):{items:NativeVoiceEvent[];nextCursor:number|null} {
    this.get(id);if(!Number.isSafeInteger(after)||after<0||!Number.isInteger(limit)||limit<1||limit>50)throw new HostError('invalid_input','Invalid native voice page.');
    const all=(this.live.get(id)?.events??[]).filter(e=>e.cursor>after),items=all.slice(0,limit);return {items:structuredClone(items),nextCursor:all.length>limit?items.at(-1)!.cursor:null};
  }
  exchange(id:string,expectedHostId:string,generation:string):{sessionId:string;generation:string;sdpAnswer:string;expiresAt:number} {
    const s=this.get(id);if(s.hostId!==expectedHostId||s.generation!==generation)throw new HostError('forbidden','scope_changed');
    const answer=this.live.get(id)?.answer;if(!answer||answer.expiresAt<=this.now()||terminal(s))throw new HostError('not_found','Native voice exchange expired or unavailable.');
    return {sessionId:id,generation,...answer};
  }
  async stop(id:string,input:unknown):Promise<{receipt:NativeVoiceReceipt;session:NativeVoiceSession}> {
    const data=StopNativeVoiceSchema.parse(input),s=this.session(id),requestHash=hash({sessionId:id,...data});
    const prior=this.journal.receipts.find(r=>r.threadId===s.threadId&&r.clientRequestId===data.clientRequestId);
    if(prior){if(prior.requestHash!==requestHash||prior.operation!=='stop')throw new HostError('conflict','Native voice request differs.');return this.receipt(s.threadId,data.clientRequestId);}
    if(data.expectedHostId!==s.hostId||data.expectedBotId!==s.botId||data.generation!==s.generation)throw new HostError('forbidden','scope_changed');
    if(data.expectedRevision!==s.revision)throw new HostError('conflict','Native voice revision changed.');
    if(this.journal.receipts.length>=1024)throw new HostError('conflict','receipt_capacity');
    this.journal.receipts.push({id:randomUUID(),operation:'stop',clientRequestId:data.clientRequestId,threadId:s.threadId,sessionId:id,generation:s.generation,hostId:s.hostId,requestHash,createdAt:this.now()});
    if(!terminal(s)){this.set(id,'stopping');try{await this.closeOwned(id);this.set(id,'closed');this.event(id,{kind:'closed'});}catch{this.set(id,'unknown','provider_failed');}}
    else this.persist();
    return this.receipt(s.threadId,data.clientRequestId);
  }
  preference(botId:string):NativeVoicePreference {
    this.store.getBot(botId);return structuredClone(this.journal.preferences.find(p=>p.botId===botId)??{hostId:this.store.hostId,botId,revision:0,voice:null,updatedAt:0});
  }
  async preferenceStatus(botId:string) {const preference=this.preference(botId),cap=await this.backend.capabilities();return {preference,...cap};}
  preferenceReceipt(botId:string,clientRequestId:string):NativeVoicePreferenceReceipt {
    this.store.getBot(botId);const r=this.journal.preferenceReceipts.find(r=>r.botId===botId&&r.clientRequestId===clientRequestId);
    if(!r)throw new HostError('not_found','Native voice preference receipt not found.');return structuredClone(r);
  }
  async patchPreference(botId:string,input:unknown):Promise<NativeVoicePreferenceReceipt> {
    const data=PatchNativeVoicePreferenceSchema.parse(input),requestHash=hash({botId,...data}),previous=this.preference(botId),bot=this.store.getBot(botId);
    const prior=this.journal.preferenceReceipts.find(r=>r.botId===botId&&r.clientRequestId===data.clientRequestId);
    if(prior){if(prior.requestHash!==requestHash)throw new HostError('conflict','Native voice preference request differs.');return structuredClone(prior);}
    if(!this.admission)throw new HostError('host_locked','host_stopping');
    if(data.expectedHostId!==this.store.hostId||data.expectedBotId!==botId)throw new HostError('forbidden','scope_changed');
    if(data.expectedRevision!==previous.revision||data.expectedBotRevision!==bot.revision)throw new HostError('conflict','Native voice preference revision changed.');
    const cap=await this.backend.capabilities();
    if(data.voice!==null&&(!cap.supported||!cap.voices.includes(data.voice)))throw new HostError('invalid_input','native_voice_unsupported');
    const latest=this.preference(botId),currentBot=this.store.getBot(botId);this.store.assertActiveWriter();
    if(!this.admission||latest.revision!==previous.revision||currentBot.revision!==data.expectedBotRevision)throw new HostError('conflict','Native voice preference changed during admission.');
    if(this.journal.preferenceReceipts.length>=1024||(!this.journal.preferences.some(p=>p.botId===botId)&&this.journal.preferences.length>=256))throw new HostError('conflict','receipt_capacity');
    const preference={hostId:this.store.hostId,botId,revision:previous.revision+1,voice:data.voice,updatedAt:this.now()};
    const receipt={id:randomUUID(),hostId:this.store.hostId,botId,clientRequestId:data.clientRequestId,requestHash,previousRevision:previous.revision,preference,createdAt:this.now()};
    this.journal.preferences=this.journal.preferences.filter(p=>p.botId!==botId);this.journal.preferences.push(preference);this.journal.preferenceReceipts.push(receipt);this.persist();return structuredClone(receipt);
  }
  history(threadId:string,after=0,limit=50) {
    this.store.getThread(threadId);if(!Number.isSafeInteger(after)||after<0||!Number.isInteger(limit)||limit<1||limit>50)throw new HostError('invalid_input','Invalid native voice history page.');
    const found=this.journal.sessions.filter(s=>s.threadId===threadId&&s.cursor>after).slice(0,limit+1);
    const items=found.slice(0,limit).map(saved=>{const session=this.get(saved.id);return {session,durationMs:session.startedAt===null?0:Math.max(0,(session.endedAt??this.now())-session.startedAt),transcriptRefs:session.turnIds.map(id=>{const t=this.store.getTurn(id);return {turnId:t.id,inputMessageId:t.inputMessageId,outputMessageId:t.outputMessageId,state:t.state};})};});
    return {items,nextCursor:found.length>limit?items.at(-1)!.session.cursor:null};
  }
  stopAdmission():void {if(!this.admission)return;this.admission=false;for(const [id] of this.live)if(!terminal(this.session(id)))this.fail(id,'host_stopping');}
  close():Promise<void> {return this.closing??=(async()=>{this.stopAdmission();await Promise.all([...this.live.keys()].map(id=>this.closeOwned(id)));this.unsubscribe();})();}
}
