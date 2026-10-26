import type { BotDelegation } from '@dexter/contracts';
import { HostError } from './errors.js';
import type { HostStore } from './store.js';
import type { HostTeamsPort } from './teams-port.js';

export const DELEGATION_RESULTS_LIMIT = 8;
export const DELEGATION_RESULT_CHARACTERS = 4096;
export const DELEGATION_RESULTS_CHARACTERS = 8192;
export type DelegationResultState = BotDelegation['state'] | 'approval_pending';
export type DelegationResultItem = {
  delegationId:string;requestHash:string;callId:string;sourceTurnId:string;targetBotId:string;targetThreadId:string;targetTurnId:string;
  state:DelegationResultState;turnCode:string|null;approvalPending:boolean;effectsUnknown:boolean;result:string|null;resultTruncated:boolean;
  responseTurnId:string|null;resultTurnId:string|null;
  sourceBotRevision:number;targetBotRevision:number;teamId:string|null;teamRevision:number|null;
};
export type DelegationResults = {sourceTurnId:string;sourceBotId:string;sourceThreadId:string;items:DelegationResultItem[];hasMore:boolean};
export function assertDelegationSource(store:HostStore,turnId:string,teams?:Readonly<HostTeamsPort>):void {
  const turn=store.getTurn(turnId),bot=store.getBot(turn.botId);
  store.assertTeamTurn(turnId);teams?.assertTurn(turnId);
  if(turn.state!=='running' || bot.ownerId!==store.ownerId || !bot.canSeeBots || !bot.canSendActions)
    throw new HostError('forbidden','Delegation source is not authorized.');
}
function selector(value:unknown):string {
  if(typeof value!=='string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value))throw new HostError('invalid_input','Invalid delegation selector.');
  return value;
}
/** Read existing canonical edges only. Selection never supplies bot/thread/owner/team authority. */
export function readDelegationResults(store:HostStore,currentTurnId:string,input:unknown={},teams?:Readonly<HostTeamsPort>):DelegationResults {
  if(!input || typeof input!=='object' || Array.isArray(input))throw new HostError('invalid_input','Invalid results query.');
  const query=input as Record<string,unknown>;
  if(Object.keys(query).some(key=>!['sourceTurnId','delegationId','limit'].includes(key)))throw new HostError('invalid_input','Unexpected results identity.');
  const sourceTurnId=query.sourceTurnId===undefined?currentTurnId:selector(query.sourceTurnId);
  const delegationId=query.delegationId===undefined?undefined:selector(query.delegationId);
  const limit=query.limit===undefined?4:query.limit;
  if(typeof limit!=='number' || !Number.isInteger(limit) || limit<1 || limit>DELEGATION_RESULTS_LIMIT)throw new HostError('invalid_input','Results limit must be1..8.');
  return store.withWriterLease(()=>{
    assertDelegationSource(store,currentTurnId,teams);
    const current=store.getTurn(currentTurnId),source=store.getTurn(sourceTurnId),sourceBot=store.getBot(source.botId);
    if(source.botId!==current.botId || source.threadId!==current.threadId)throw new HostError('forbidden','Results belong to another conversation.');
    store.assertTeamTurn(source.id);teams?.assertTurn(source.id);
    const all=delegationId?[store.getDelegation(delegationId)]:store.delegationChildren(source.id);
    if(all.length>DELEGATION_RESULTS_LIMIT)throw new HostError('forbidden','Canonical delegation budget differs.');
    let budget=DELEGATION_RESULTS_CHARACTERS;
    const items=all.slice(0,limit).map(row=>{
      if(row.sourceTurnId!==source.id)throw new HostError('forbidden','Delegation is not this parent child.');
      const visited=new Set<string>();let effectsUnknown=false;
      const pending=(edge:BotDelegation):boolean=>{
        if(visited.has(edge.id) || visited.size>=DELEGATION_RESULTS_LIMIT)throw new HostError('forbidden','Delegation ancestry differs.');
        visited.add(edge.id);
        const from=store.getTurn(edge.sourceTurnId),child=store.getTurn(edge.targetTurnId);
        const sender=store.getBot(from.botId),target=store.getBot(child.botId);
        if(edge.sourceBotId!==from.botId || edge.sourceThreadId!==from.threadId || edge.targetBotId!==child.botId || edge.targetThreadId!==child.threadId
          || sender.ownerId!==store.ownerId || target.ownerId!==store.ownerId || !sender.canSeeBots || !sender.canSendActions || !target.canReceiveOrders)
          throw new HostError('forbidden','Delegation identity or permissions changed.');
        store.assertTeamTurn(from.id);store.assertTeamTurn(child.id);teams?.assertTurn(from.id);teams?.assertTurn(child.id);teams?.assertDelegation(from.id,target.id);
        const parent=store.delegationForTurn(from.id);
        if(edge.parentId!==(parent?.id??null) || edge.rootId!==(parent?.rootId??from.id) || edge.depth!==(parent?.depth??0)+1)
          throw new HostError('forbidden','Delegation correlation changed.');
        const chain=store.toolContinuationTurns(child.id);
        const children=chain.turnIds.flatMap(id=>store.delegationChildren(id));
        for(const id of chain.turnIds){store.assertTeamTurn(id);teams?.assertTurn(id);}
        let approval=chain.approvalPending;
        effectsUnknown=effectsUnknown || chain.effectsUnknown;
        for(const descendant of children){if(descendant.parentId!==edge.id || descendant.rootId!==edge.rootId)throw new HostError('forbidden','Child ancestry differs.');approval=pending(descendant)||approval;}
        return approval;
      };
      const approvalPending=pending(row),chain=store.toolContinuationTurns(row.targetTurnId),child=store.getTurn(chain.turnIds.at(-1)!),target=store.getBot(row.targetBotId),team=teams?.turnTeam(child.id)??null;
      const completed=row.state==='completed' && child.state==='completed' && !chain.awaitingReceipt;
      const terminalMismatch=row.state==='completed' && !completed && !chain.awaitingReceipt && !['queued','running'].includes(child.state);
      const state:DelegationResultState=terminalMismatch || effectsUnknown || child.state==='unknown'?'unknown'
        :approvalPending && ['pending','running','completed'].includes(row.state)?'approval_pending'
        :row.state==='completed' && !completed?'running':row.state;
      const answer=completed && state==='completed'?(chain.turnIds.length>1?store.turnOutput(child.id):row.result):null,maximum=Math.min(budget,DELEGATION_RESULT_CHARACTERS);
      let result=answer===null?null:answer.slice(0,maximum);
      if(result && /[\uD800-\uDBFF]$/.test(result))result=result.slice(0,-1);
      budget-=result?.length??0;
      return {delegationId:row.id,requestHash:row.requestHash,callId:row.callId,sourceTurnId:row.sourceTurnId,targetBotId:row.targetBotId,
        targetThreadId:row.targetThreadId,targetTurnId:row.targetTurnId,state,turnCode:child.code,approvalPending,effectsUnknown,
        result,resultTruncated:answer!==null && result!==answer,responseTurnId:chain.turnIds.length>1?child.id:null,resultTurnId:answer===null?null:child.id,
        sourceBotRevision:sourceBot.revision,targetBotRevision:target.revision,teamId:team?.id??null,teamRevision:team?.revision??null};
    });
    return {sourceTurnId:source.id,sourceBotId:source.botId,sourceThreadId:source.threadId,items,hasMore:all.length>limit};
  });
}
