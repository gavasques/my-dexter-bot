import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { CreateGroupSchema,UpdateGroupSchema,CreateGroupConversationSchema,SendGroupMessageSchema,GroupDispatchMutationSchema,GroupPostSchema,JsonSchema } from '@dexter/contracts';
import { canonicalJson } from './canonical.js';
import { fail } from './errors.js';
const all=(db:DatabaseSync,sql:string,...args:(string|number)[])=>db.prepare(sql).all(...args) as Record<string,any>[];
const one=(db:DatabaseSync,sql:string,...args:(string|number)[])=>db.prepare(sql).get(...args) as Record<string,any>|undefined;
const count=(db:DatabaseSync,sql:string)=>Number(one(db,sql)?.n);
const canonical=(v:unknown)=>canonicalJson(JsonSchema.parse(v));
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
const broken=(message:string):never=>fail('reference_broken','Groups: '+message);
const natural=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const positive=(v:unknown)=>natural(v)&&Number(v)>0;
const id=(v:unknown)=>typeof v==='string'&&v.length>0&&v.length<=128;
const json=(v:unknown):any=>{try{return JSON.parse(String(v));}catch{return broken('invalid JSON');}};
export const GROUP_COUNT_TABLES=Object.freeze({groups:'conversation_groups',groupMembers:'group_members',groupConversations:'group_conversations',groupLanes:'group_lanes',groupThreadAudiences:'group_thread_audiences',groupMessages:'group_messages',groupDispatches:'group_dispatches',groupRecipients:'group_recipients',groupReceipts:'group_receipts'});
export const APPROVAL_COUNT_TABLES=Object.freeze({threadApprovalPolicies:'thread_approval_policies',approvalPreferenceReceipts:'approval_preference_receipts',approvalContexts:'action_approval_contexts',approvalTypePreferences:'approval_type_preferences'});
export function groupCounts(db:DatabaseSync):Record<keyof typeof GROUP_COUNT_TABLES,number>{return Object.fromEntries(Object.entries(GROUP_COUNT_TABLES).map(([k,t])=>[k,count(db,`SELECT COUNT(*) n FROM ${t}`)])) as Record<keyof typeof GROUP_COUNT_TABLES,number>;}
/** Whole-catalog validation is separate. This checks persisted semantics, authentic input hashes and references. */
export function validateGroups(db:DatabaseSync,hostId:string):void {
  const has=(table:string,key:string,value:unknown)=>one(db,`SELECT * FROM ${table} WHERE ${key}=?`,String(value));
  if(all(db,'PRAGMA foreign_key_check').length)broken('foreign keys');
  for(const g of all(db,'SELECT * FROM conversation_groups')){
    if(!id(g.id)||typeof g.name!=='string'||!g.name.trim()||g.name.length>120||!positive(g.revision)||!natural(g.created_at)||!natural(g.updated_at)||Number(g.updated_at)<Number(g.created_at))broken('group metadata');
    const members=all(db,'SELECT * FROM group_members WHERE group_id=?',String(g.id));
    if(![0,1].includes(Number(g.archived))||g.archived===1&&members.some(m=>m.active===1)||g.archived===0&&(members.filter(m=>m.active===1).length<1||members.filter(m=>m.active===1).length>8))broken('active roster size');
    for(const m of members)if(!has('bots','id',m.bot_id)||![0,1].includes(Number(m.active))||!positive(m.joined_revision)||Number(m.joined_revision)>Number(g.revision)||!natural(m.visible_after)||!['all','from_join'].includes(String(m.history))||m.history==='all'&&m.visible_after!==0)broken('membership');
  }
  for(const c of all(db,'SELECT * FROM group_conversations'))if(!id(c.id)||!has('conversation_groups','id',c.group_id)||!natural(c.created_at))broken('conversation');
  for(const l of all(db,'SELECT * FROM group_lanes')){
    const t=has('threads','id',l.thread_id),c=has('group_conversations','id',l.conversation_id),r=has('group_recipients','id',l.recipient_id);
    if(!t||!c||!r||r.thread_id!==l.thread_id||r.bot_id!==l.bot_id||!String(l.thread_id).startsWith('thr_group_')||t.bot_id!==l.bot_id||!positive(l.joined_revision))broken('lane');
  }
  for(const a of all(db,'SELECT * FROM group_thread_audiences')){const t=has('threads','id',a.thread_id),d=has('group_dispatches','id',a.dispatch_id),r=has('group_recipients','id',a.recipient_id);if(!t||!d||!r||r.dispatch_id!==d.id||a.group_id!==d.group_id||a.conversation_id!==d.conversation_id)broken('thread audience');if(a.thread_id!==r!.thread_id){const del=one(db,'SELECT * FROM bot_delegations WHERE target_thread_id=?',String(a.thread_id)),parent=del?has('group_thread_audiences','thread_id',del.source_thread_id):null;if(!del||!parent||parent.recipient_id!==a.recipient_id||parent.dispatch_id!==a.dispatch_id||parent.group_id!==a.group_id||parent.conversation_id!==a.conversation_id)broken('unowned audience descendant');}}
  for(const m of all(db,'SELECT * FROM group_messages')){
    const c=has('group_conversations','id',m.conversation_id),g=has('conversation_groups','id',m.group_id);
    if(!c||!g||c.group_id!==g.id||!id(m.id)||!positive(m.cursor)||!positive(m.membership_revision)||Number(m.membership_revision)>Number(g.revision)||!natural(m.created_at)||typeof m.content!=='string'||digest(m.content)!==m.content_hash)broken('message/hash');
    if(m.origin==='human'?(m.author_bot_id!==null||m.turn_id!==null||m.recipient_id!==null):m.origin!=='bot'||!has('bots','id',m.author_bot_id))broken('message author');
    if(m.turn_id!==null){const t=has('turns','id',m.turn_id);if(!t||t.bot_id!==m.author_bot_id)broken('turn author');}
    if(m.dispatch_id!==null){const d=has('group_dispatches','id',m.dispatch_id);if(!d||d.group_id!==m.group_id||d.conversation_id!==m.conversation_id)broken('message dispatch');}
    if(m.recipient_id!==null){const r=has('group_recipients','id',m.recipient_id);if(!r||r.response_message_id!==m.id||r.bot_id!==m.author_bot_id||r.dispatch_id!==m.dispatch_id||r.state!=='completed'||has('turns','id',m.turn_id)?.state!=='completed')broken('message recipient');}
  }
  for(const d of all(db,'SELECT * FROM group_dispatches')){
    const c=has('group_conversations','id',d.conversation_id),m=has('group_messages','id',d.input_message_id),g=has('conversation_groups','id',d.group_id);
    const parsed=SendGroupMessageSchema.safeParse(json(d.input_json)),snapshot=json(d.snapshot_json),ids=json(d.recipient_ids_json);
    if(!parsed.success||parsed.data.expectedHostId!==hostId||parsed.data.clientRequestId!==d.client_request_id||parsed.data.expectedRevision!==d.membership_revision||digest(canonical(parsed.data))!==d.input_hash||!c||!g||c.group_id!==g.id||!m||m.origin!=='human'||m.content!==parsed.data.content||m.dispatch_id!==d.id||m.conversation_id!==c.id||!positive(d.revision)||!natural(d.deadline_at)||Number(d.deadline_at)<=Number(d.created_at)||Number(d.deadline_at)>Number(d.created_at)+285000||!natural(d.created_at)||!natural(d.updated_at))broken('dispatch/input');
    if(!Array.isArray(snapshot)||snapshot.length<1||snapshot.length>8||new Set(snapshot.map(x=>x.botId)).size!==snapshot.length||!Array.isArray(ids)||ids.length<1||ids.length>8||new Set(ids).size!==ids.length)broken('dispatch roster');
    for(const x of snapshot)if(Object.keys(x).sort().join(',')!=='active,botId,history,joinedRevision,visibleAfter'||x.active!==true||!has('bots','id',x.botId)||!positive(x.joinedRevision)||x.joinedRevision>Number(d.membership_revision)||!natural(x.visibleAfter)||!['all','from_join'].includes(x.history)||x.history==='all'&&x.visibleAfter!==0)broken('snapshot member');
    const send=parsed.data!;
    const selected=send.recipients.kind==='all'?snapshot.map((x:any)=>x.botId):send.recipients.kind==='one'?[send.recipients.botId]:send.recipients.botIds;
    if(canonical(selected)!==canonical(ids))broken('exact recipients');
    const rows=all(db,'SELECT * FROM group_recipients WHERE dispatch_id=?',String(d.id));
    if(rows.length!==ids.length||rows.some(r=>!ids.includes(r.bot_id)))broken('recipient set');
    if(d.state==='held'&&rows.some(r=>r.state!=='queued'||r.turn_id!==null||r.thread_id!==null))broken('held has effects');
    for(const r of rows){const member=snapshot.find((x:any)=>x.botId===r.bot_id);if(!member||r.joined_revision!==member.joinedRevision||r.visible_after!==member.visibleAfter)broken('recipient generation');
      const observed=json(r.observed_turn_ids_json);if(!Array.isArray(observed)||observed.length>17||new Set(observed).size!==observed.length||observed.some(x=>!id(x)||!has('turns','id',x)))broken('observed chain');
      if(r.thread_id!==null){const l=has('group_lanes','thread_id',r.thread_id);if(!l||l.bot_id!==r.bot_id||l.conversation_id!==d.conversation_id||l.joined_revision!==r.joined_revision||has('group_thread_audiences','thread_id',r.thread_id)?.recipient_id!==r.id)broken('recipient lane');}
      if(r.turn_id!==null){const t=has('turns','id',r.turn_id);if(!t||t.thread_id!==r.thread_id||t.bot_id!==r.bot_id||t.client_request_id!==r.id||r.prompt===null||has('messages','id',t.input_message_id)?.content!==has('group_messages','id',d.input_message_id)?.content)broken('recipient turn');if(observed.length&&observed[0]!==r.turn_id)broken('chain root');
        for(let i=1;i<observed.length;i++){const t2=has('turns','id',observed[i]);if(t2?.thread_id!==r.thread_id||!one(db,'SELECT 1 x FROM tool_action_continuations WHERE origin_turn_id=? AND continuation_turn_id=?',observed[i-1],observed[i]))broken('continuation ownership');}
      }else if(['running','awaiting_approval','completed'].includes(String(r.state))||observed.length)broken('recipient missing turn');
      if(r.response_message_id!==null&&!has('group_messages','id',r.response_message_id))broken('missing reply');
    }
  }
  for(const r of all(db,'SELECT * FROM group_receipts')){
    const input=json(r.input_json),result=json(r.result_json),op=String(r.operation);
    let valid=false;
    if(op==='create')valid=CreateGroupSchema.safeParse(input).success&&input.expectedHostId===hostId&&r.scope_id===hostId&&r.previous_revision===0&&r.revision===1&&has('conversation_groups','id',result.id)!==undefined;
    if(op==='update')valid=UpdateGroupSchema.safeParse(input).success&&input.expectedHostId===hostId&&result.id===r.scope_id&&has('conversation_groups','id',result.id)!==undefined&&r.previous_revision===input.expectedRevision&&r.revision===Number(r.previous_revision)+1;
    if(op==='delete')valid=GroupDispatchMutationSchema.safeParse(input).success&&input.expectedHostId===hostId&&result.id===r.scope_id&&has('conversation_groups','id',result.id)?.archived===1&&result.archived===true&&r.previous_revision===input.expectedRevision&&r.revision===Number(r.previous_revision)+1;
    if(op==='conversation')valid=CreateGroupConversationSchema.safeParse(input).success&&input.expectedHostId===hostId&&result.groupId===r.scope_id&&has('group_conversations','id',result.id)!==undefined&&r.revision===r.previous_revision&&r.previous_revision===input.expectedRevision;
    if(op==='stop'||op==='resume')valid=GroupDispatchMutationSchema.safeParse(input).success&&input.expectedHostId===hostId&&result.id===r.scope_id&&has('group_dispatches','id',result.id)!==undefined&&r.previous_revision===input.expectedRevision&&r.revision===Number(r.previous_revision)+1;
    if(op==='post'){const {clientRequestId,...post}=input;valid=GroupPostSchema.safeParse(post).success&&result.groupId===r.scope_id&&has('group_messages','id',result.id)!==undefined&&result.origin==='bot'&&r.previous_revision===input.expectedRevision&&r.revision===r.previous_revision;}
    if(!valid||!id(r.id)||!id(input.clientRequestId)||input.clientRequestId!==r.client_request_id||digest(canonical(input))!==r.input_hash||!positive(r.revision)||!natural(r.previous_revision)||!natural(r.created_at))broken('receipt/input');
    if(op==='create'||op==='update'){if(result.hostId!==hostId||result.name!==input.name||result.revision!==r.revision||!Array.isArray(result.members))broken('configuration receipt');const ids=result.members.filter((m:any)=>m.active).map((m:any)=>m.botId).sort();if(canonical(ids)!==canonical([...input.botIds].sort()))broken('receipt roster');}
  }
}
