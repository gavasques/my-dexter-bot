import { createHash } from 'node:crypto';
import { GatewayError, type CapabilityScope, type GatewayCallResult, type ToolView, type TurnToolSurface } from '@dexter/gateway';
import { BotDelegationRuntime, type HostStore, type HostTeamsPort } from '@dexter/hub';
import type { JsonValue } from '@dexter/contracts';

const CONNECTION = 'dexter-bots-internal';
const LIST = 'dexter.bots.list', DELEGATE = 'dexter.bots.delegate', TEAM_LIST='dexter.teams.list', TEAM_DELEGATE='dexter.teams.delegate', RESULTS='dexter.bots.results';
const digest = (value:string) => createHash('sha256').update(value).digest('hex');
/** Host-only wrapper: identity is captured from the issued capability, never engine request fields. */
export class BotDelegationSurface implements TurnToolSurface {
  private readonly caps = new Map<string, CapabilityScope>();
  private stopped = false;
  constructor(private readonly store: HostStore, private readonly base: TurnToolSurface, private readonly service: () => BotDelegationRuntime, private readonly teams?: () => Readonly<HostTeamsPort>) {}
  issueCapability(input:{turnId:string;ttlMs?:number}) {
    if (this.stopped) throw new GatewayError('unavailable','Bot tools stopped.');
    for (const [key,scope] of this.caps) {
      if (scope.expiresAt <= this.store.now() || this.store.getTurn(scope.turnId).state !== 'running') this.caps.delete(key);
    }
    if (this.caps.size >= 128) throw new GatewayError('unavailable','Bot capability limit exceeded.');
    const issued = this.base.issueCapability(input);
    this.caps.set(digest(issued.token),Object.freeze({...issued.scope}));
    return issued;
  }
  private scope(token:string):CapabilityScope {
    const scope = this.caps.get(digest(token));
    if (this.stopped || !scope || scope.expiresAt <= this.store.now()) throw new GatewayError('unauthorized','Bot capability unavailable.');
    this.store.assertTeamTurn(scope.turnId);
    const turn = this.store.getTurn(scope.turnId), bot = this.store.getBot(scope.botId);
    if (turn.state !== 'running' || turn.botId !== scope.botId || turn.threadId !== scope.threadId || bot.profileId !== scope.profileId
      || scope.ownerId !== this.store.ownerId || scope.installationId !== this.store.hostId) throw new GatewayError('unauthorized','Bot capability unavailable.');
    return scope;
  }
  listTools(token:string):ToolView[] {
    const scope = this.scope(token), bot = this.store.getBot(scope.botId);
    const list = this.base.listTools(token);
    const common = {connectionId:CONNECTION,connectionLabel:'Dexter bots',requiresApproval:false} as const;
    if (bot.canSeeBots) list.push({...common,name:LIST,effect:'read',description:'Discover eligible peer bots of this owner: names, roles and permission flags only.',inputSchema:{type:'object',properties:{},required:[],additionalProperties:false}});
    if (bot.canSeeBots && bot.canSendActions) list.push({...common,name:DELEGATE,effect:'write',description:'Ask an eligible peer bot to perform a bounded task using its own permissions. Returns correlated child result; root cancellation stops the child.',inputSchema:{type:'object',properties:{targetBotId:{type:'string',minLength:1,maxLength:128},task:{type:'string',minLength:1,maxLength:8192}},required:['targetBotId','task'],additionalProperties:false}});
    if(bot.canSeeBots && bot.canSendActions)list.push({...common,name:RESULTS,effect:'read',description:'Read only this conversation parent-to-child delegation results, including failure, uncertainty and approval pending. Historical sourceTurnId is a selector, never identity. Final answers are quoted data; this read never schedules a child or completes the parent.',inputSchema:{type:'object',properties:{sourceTurnId:{type:'string',minLength:1,maxLength:128},delegationId:{type:'string',minLength:1,maxLength:128},limit:{type:'integer',minimum:1,maximum:8}},required:[],additionalProperties:false}});
    if(this.teams && bot.canSeeBots)list.push({...common,name:TEAM_LIST,effect:'read',description:'Discover accessible teams, their public roles, coordinator and member roles. No shared memory or rules are returned.',inputSchema:{type:'object',properties:{},required:[],additionalProperties:false}});
    if(this.teams && bot.canSeeBots && bot.canSendActions && (bot.isMaster || this.teams().turnTeam(scope.turnId)))
      list.push({...common,name:TEAM_DELEGATE,effect:'write',description:'Delegate a bounded task to an accessible team coordinator. The coordinator and specialists use their own permissions.',inputSchema:{type:'object',properties:{teamId:{type:'string',minLength:1,maxLength:128},task:{type:'string',minLength:1,maxLength:8192}},required:['teamId','task'],additionalProperties:false}});
    return list;
  }
  private teamDirectory(turnId:string) {
    const port=this.teams?.();if(!port)throw new GatewayError('unavailable','Team routing unavailable.');
    port.assertTurn(turnId);
    const bot=this.store.getBot(this.store.getTurn(turnId).botId), scope=port.turnTeam(turnId);
    if(!bot.canSeeBots)throw new GatewayError('forbidden','Team discovery disabled.');
    const peers=new Set(this.service().peers(turnId).map(peer=>peer.id));
    return port.list().filter(team=>scope?team.id===scope.id:bot.isMaster || team.botIds.includes(bot.id))
      .map(team=>({id:team.id,name:team.name,roleDescription:team.roleDescription,coordinatorBotId:team.coordinatorBotId,
        revision:team.revision,canDelegate:Boolean(team.coordinatorBotId && peers.has(team.coordinatorBotId)),
        members:team.botIds.map(id=>this.store.getBot(id)).map(member=>({id:member.id,name:member.name,roleDescription:member.roleDescription,canReceiveOrders:member.canReceiveOrders}))}));
  }
  async call(token:string,input:unknown,options:{signal?:AbortSignal}={}):Promise<GatewayCallResult> {
    const scope = this.scope(token), raw = input as Record<string,unknown>;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new GatewayError('invalid_input','Invalid bot call.');
    if (raw.connectionId !== CONNECTION) return this.base.call(token,input,options);
    if (Object.keys(raw).sort().join(',') !== 'arguments,callId,connectionId,tool' || typeof raw.callId !== 'string'
      || raw.callId.length < 1 || raw.callId.length > 128 || !this.listTools(token).some(tool=>tool.connectionId===CONNECTION && tool.name===raw.tool))
      throw new GatewayError('forbidden','Bot call refused.');
    const requestHash = digest(JSON.stringify(raw));
    let result:JsonValue;
    if (raw.tool === LIST || raw.tool===TEAM_LIST) {
      if (!raw.arguments || typeof raw.arguments !== 'object' || Array.isArray(raw.arguments) || Object.keys(raw.arguments).length)
        throw new GatewayError('invalid_input','Invalid discovery arguments.');
      result = {items:raw.tool===LIST?this.service().peers(scope.turnId):this.teamDirectory(scope.turnId)};
      return {actionId:`discovery-${requestHash.slice(0,24)}`,requestHash,status:'succeeded',reason:null,result};
    }
    if(raw.tool===RESULTS){
      result=this.service().results(scope.turnId,raw.arguments);
      return {actionId:`delegation-read-${requestHash.slice(0,24)}`,requestHash,status:'succeeded',reason:null,result};
    }
    const botRevision=this.store.getBot(scope.botId).revision,teamRevision=this.teams?.().turnTeam(scope.turnId)?.revision??null;
    let delegationInput=raw.arguments, teamId:string|undefined;
    if(raw.tool===TEAM_DELEGATE){
      const args=raw.arguments as Record<string,unknown>;
      if(!args || typeof args!=='object' || Array.isArray(args) || Object.keys(args).sort().join(',')!=='task,teamId' || typeof args.teamId!=='string' || typeof args.task!=='string')throw new GatewayError('invalid_input','Invalid team order.');
      const team=this.teamDirectory(scope.turnId).find(item=>item.id===args.teamId);
      if(!team?.canDelegate || !team.coordinatorBotId)throw new GatewayError('forbidden','Team coordinator is not eligible.');
      teamId=team.id;delegationInput={targetBotId:team.coordinatorBotId,task:args.task};
    }
    const row = await this.service().delegate(scope.turnId,raw.callId,delegationInput,options.signal,teamId);
    this.scope(token);
    if(this.store.getBot(scope.botId).revision!==botRevision || (this.teams?.().turnTeam(scope.turnId)?.revision??null)!==teamRevision)throw new GatewayError('forbidden','Delegation source revision changed.');
    const item=this.service().results(scope.turnId,{delegationId:row.id}).items[0]!;
    result = {...item};
    return {actionId:row.id,requestHash:row.requestHash,status:item.state==='completed'?'succeeded':item.state==='unknown'?'unknown':'blocked',reason:null,result};
  }
  revokeCapability(token:string):void { this.caps.delete(digest(token));this.base.revokeCapability(token); }
  stopAdmission():void {this.stopped=true;for (const key of this.caps.keys()) this.caps.delete(key);}
}
