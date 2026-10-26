import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { NativeVoiceBackend, NativeVoiceConnection, NativeVoiceProviderEvent } from '@dexter/contracts';
import { CodexAppServerDriver } from './codex.js';
import { EngineError, object, probe, type DriverOptions } from './process.js';

/** Official local protocol metadata only. No account/config/login or inference request in capabilities(). */
export class CodexNativeVoiceBackend implements NativeVoiceBackend {
  private snapshot:Promise<{supported:boolean;voices:string[];cliVersion:string|null}>|undefined;
  constructor(private readonly options:DriverOptions,private readonly metadataRoot:string) {
    if(!isAbsolute(metadataRoot))throw new EngineError('protocol_error');
  }
  capabilities() {return this.snapshot??=this.inspect();}
  private async inspect():Promise<{supported:boolean;voices:string[];cliVersion:string|null}> {
    let cliVersion:string|null=null;
    try {
      const version=await probe(this.options,this.options.command??'codex',['--version']);
      if(version.exitCode!==0)throw new Error();cliVersion=version.text.match(/\d+\.\d+\.\d+/)?.[0]??null;
      mkdirSync(this.metadataRoot,{recursive:true,mode:0o700});const out=mkdtempSync(join(this.metadataRoot,'schema-'));
      const generated=await probe(this.options,this.options.command??'codex',['app-server','generate-json-schema','--experimental','--out',out]);
      if(generated.exitCode!==0)throw new Error();
      const read=(name:string)=>{const content=readFileSync(join(out,name),'utf8');if(Buffer.byteLength(content)>4*1024*1024)throw new Error();return JSON.parse(content) as Record<string,unknown>;};
      const requests=readFileSync(join(out,'ClientRequest.json'),'utf8');
      if(!['thread/realtime/start','thread/realtime/stop','thread/realtime/appendText','thread/realtime/appendSpeech'].every(m=>requests.includes(JSON.stringify(m)))||!requests.includes('experimentalApi'))throw new Error();
      const start=read('v2/ThreadRealtimeStartParams.json'),defs=object(start.definitions),props=object(start.properties);
      if(!['threadId','clientManagedHandoffs','transport','initialItems','voice'].every(k=>Object.hasOwn(props,k))||!Array.isArray(object(defs.RealtimeConversationVersion).enum)||!(object(defs.RealtimeConversationVersion).enum as unknown[]).includes('v3')||!JSON.stringify(defs.ThreadRealtimeStartTransport).includes('webrtc'))throw new Error();
      const enumValue=object(defs.RealtimeVoice).enum;
      if(!Array.isArray(enumValue)||enumValue.length>64||!enumValue.every(v=>typeof v==='string'&&/^[a-z][a-z0-9_-]{0,63}$/.test(v)))throw new Error();
      for(const name of ['ThreadRealtimeSdpNotification','ThreadRealtimeStartedNotification','ThreadRealtimeTranscriptDoneNotification','ThreadRealtimeItemAddedNotification','ThreadRealtimeClosedNotification'])read('v2/'+name+'.json');
      return {supported:true,voices:[...enumValue] as string[],cliVersion};
    }catch{return {supported:false,voices:[],cliVersion};}
  }
  async start(input:Parameters<NativeVoiceBackend['start']>[0],emit:(event:NativeVoiceProviderEvent)=>void):Promise<NativeVoiceConnection> {
    const capabilities=await this.capabilities();if(!capabilities.supported)throw new EngineError('unsupported');
    input.assertCurrent?.();
    const driver=new CodexAppServerDriver({...this.options,experimentalApi:true});
    // Fresh cursorless media thread. No inherited native session or MCP capability is reused.
    const session=await driver.open(input.threadId,undefined,{selection:input.selection});
    try {input.assertCurrent?.();await driver.startRealtime(session,input,emit);}
    catch(error){await driver.close(session);throw error;}
    let closed=false;
    return {
      speech:async text=>{if(closed)throw new EngineError('session_closed');await driver.appendRealtime(session,text,true);},
      text:async text=>{if(closed)throw new EngineError('session_closed');await driver.appendRealtime(session,text,false);},
      stop:async()=>{if(closed)return;await driver.stopRealtime(session);},
      close:async()=>{if(closed)return;closed=true;await driver.close(session);},
    };
  }
}
