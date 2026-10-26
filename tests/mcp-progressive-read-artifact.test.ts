import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import type {EngineDriver,EngineEvent,EngineSession} from '@dexter/engines';
import {HostServices} from '../packages/cli/src/host-services.js';

test('actual HostServices read-only guide overflow is recoverable through the same bot/thread lease and supports one-control reads',{timeout:30_000},async t=>{
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'dx-guide-spill-')));let failure:unknown,artifactId='';let recovered:any,narrow:any;
  const services=new HostServices({dataDir:dir,enableEngines:true,enableMcp:true,makeDriver:(id,options):EngineDriver=>{
    const client=new Client({name:'synthetic-progressive-guide',version:'1'});
    async function read(name:string,callId:string,input:Record<string,unknown>){
      const found=await client.callTool({name:'dx_catalog_search',arguments:{query:name,limit:20}});
      const target=(found.structuredContent as any).tools.find((tool:any)=>tool.title===name);assert(target);
      const result=await client.callTool({name:'dx_catalog_call',arguments:{alias:target.alias,callId,input}},{timeout:10_000});
      assert.equal(result.isError,false);return result.structuredContent as any;
    }
    return {id,capabilities:{resume:true,interrupt:true,fork:false,steer:false},
      status:async()=>({engine:id,installed:true,version:'synthetic',authentication:'authenticated',billing:'subscription'}),
      async open(threadId):Promise<EngineSession>{assert(options.localMcpServer);await client.connect(new StdioClientTransport({...options.localMcpServer,args:[...options.localMcpServer.args],stderr:'pipe'}));return {threadId,nativeCursor:randomUUID()};},
      async *turn(session,turnId):AsyncIterable<EngineEvent>{
        try{
          const receipt=await read('dexter.harness.configuration','full-guide',{page:'connections'});
          assert.match(receipt.actionId,/^harness-read-/);assert.equal(receipt.status,'succeeded');assert.equal(receipt.result.truncated,'mcp_result_budget');
          artifactId=receipt.result.artifact.artifactId;assert(artifactId);
          let text='',offset=0;
          do{const page=(await read('dexter.harness.results.artifact.read',`page-${offset}`,{artifact_id:artifactId,offset})).result;
            assert.equal(page.artifactId,artifactId);text+=page.content;offset=page.nextOffset;
          }while(offset!==null);
          recovered=JSON.parse(text);assert.equal(recovered.id,'connections');assert(recovered.fields.some((field:any)=>field.id==='connections.inspector.rename.save'));
          narrow=(await read('dexter.harness.configuration','one-control',{page:'mcp-connections',field:'mcp.setup-request.allow'})).result;
          assert.equal(narrow.field.id,'mcp.setup-request.allow');assert(narrow.field.approval);assert(!narrow.truncated);
          yield {type:'turn.completed',threadId:session.threadId,turnId,usage:null};
        }catch(error){failure=error;throw error;}
      },async close(){await client.close();},async interrupt(){await client.close();},async respondToTool(){},
    };
  }});
  t.after(async()=>{await services.shutdown();rmSync(dir,{recursive:true,force:true});});
  const bot=services.store.createBot({name:'Synthetic progressive guide',profileId:'default',engine:'claude'}),thread=services.store.createThread(bot.id);
  const turn=services.runtime!.startTurn(thread.id,{clientRequestId:randomUUID(),content:'Read the MCP setup controls.'}).turn;
  assert.equal((await services.runtime!.waitForTurn(turn.id)).state,'completed',String(failure));
  assert.equal(services.store.listActions().length,0,'static documentation reads create no executable actions');
  assert.throws(()=>services.mcpResultArtifacts.read(bot.id,'another-thread',artifactId));
  assert.throws(()=>services.mcpResultArtifacts.read('another-bot',thread.id,artifactId));
  assert.equal(recovered.version,narrow.version);
});
