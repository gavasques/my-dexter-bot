import { MemorySourceSchema, SetBotDocumentsSchema, RestoreBotMemorySchema, AppendBotMemoryNoteSchema } from '@dexter/contracts';
import { canonicalJson } from '@dexter/hub';
import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { TEAM_WORKSPACES_META_KEY, MAX_TEAMS, MAX_TEAM_BOTS, MAX_TEAM_METADATA_BYTES,
  TeamSchema, TeamWorkspacesMetadataSchema, teamWorkspacesCanonicalJSON } from "@dexter/contracts";
import { fail } from "./errors.js";
import type { GitSnapshot } from "./git.js";
import { all, count, one } from "./schemas.js";
import { validateMemoryLedger } from './memory-ledger.js';
import { validateMemoryRoutines } from './memory-routines.js';

/**
 * Read-only checks shared by capture (before sealing) and restore (the gate). They run on staged copies only.
 */

/** Sanitization invariants of a staged Hub copy: no lease, cursor, in-flight work, usable device or grant. */
export function checkHubSanitized(db: DatabaseSync, capturedAt: number, revokedDeviceIds: readonly string[] | null): void {
  if (Number(one(db,"PRAGMA user_version")?.user_version) >= 6
    && count(db,"SELECT COUNT(*) AS n FROM bot_delegations WHERE state IN ('pending','running')") !== 0) fail("corrupt","Inspection contains dispatchable delegations.");
  if (count(db, "SELECT COUNT(*) AS n FROM host_lease") !== 0) fail("corrupt", "inspection copy carries a writer lease");
  if (Number(one(db, "PRAGMA user_version")?.user_version) >= 4
    && count(db, "SELECT COUNT(*) AS n FROM host_authority WHERE state = 'revoked'") !== 1) fail("corrupt", "inspection copy carries host authority");
  if (count(db, "SELECT COUNT(*) AS n FROM thread_sessions WHERE native_cursor IS NOT NULL") !== 0) fail("corrupt", "inspection copy carries native cursors");
  if (count(db, "SELECT COUNT(*) AS n FROM actions WHERE state = 'running'") + count(db, "SELECT COUNT(*) AS n FROM turns WHERE state = 'running'") !== 0) {
    fail("corrupt", "inspection copy carries in-flight work");
  }
  if (count(db, "SELECT COUNT(*) AS n FROM devices WHERE revoked_at IS NULL") !== 0) fail("corrupt", "inspection copy carries usable devices");
  if (count(db, "SELECT COUNT(*) AS n FROM grants WHERE expires_at IS NULL OR expires_at > ?", capturedAt) !== 0) {
    fail("corrupt", "inspection copy carries usable grants");
  }
  if (revokedDeviceIds) {
    for (const id of revokedDeviceIds) {
      if (count(db, "SELECT COUNT(*) AS n FROM devices WHERE id = ? AND revoked_at = ?", id, capturedAt) !== 1) fail("corrupt", "sanitized device report disagrees with the hub");
    }
  }
}

/** Every Context pin, including owner bot documents, resolves to the same bytes in master's history. */
export function validateContext(db: DatabaseSync, hub: DatabaseSync, git: GitSnapshot): void {
  validateContextTeams(db,hub);
  const pin = (row: Record<string, unknown>): void => {
    const path = String(row.path); const commit = String(row.git_commit); const hash = String(row.hash);
    if (!/^(skills|artifacts|memory)\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\.md$/.test(path)) fail("reference_broken", "context pin path is not valid");
    if (git.blobSha256(commit, path) !== hash) fail("reference_broken", "context pin hash does not match its Git blob");
  };
  for (const table of ["revisions", "skills", "memories"]) for (const row of all(db, `SELECT path, git_commit, hash FROM ${table}`)) pin(row);
  for (const artifact of all(db, "SELECT id, bot_id, head, fork_id, fork_revision FROM artifacts")) {
    const revisions = all(db, "SELECT revision, restored_from FROM revisions WHERE artifact_id = ? ORDER BY revision", String(artifact.id));
    if (revisions.length !== Number(artifact.head) || revisions.some((row, index) => Number(row.revision) !== index + 1)) {
      fail("reference_broken", "context artifact history is not contiguous");
    }
    for (const row of revisions) {
      if (row.restored_from !== null && !(Number(row.restored_from) >= 1 && Number(row.restored_from) < Number(row.revision))) {
        fail("reference_broken", "context artifact restore reference is not valid");
      }
    }
    if ((artifact.fork_id === null) !== (artifact.fork_revision === null)) fail("reference_broken", "context fork reference is incomplete");
    if (artifact.fork_id !== null && count(db, "SELECT COUNT(*) AS n FROM revisions WHERE artifact_id = ? AND revision = ?",
      String(artifact.fork_id), Number(artifact.fork_revision)) !== 1) fail("reference_broken", "context fork source is missing");
    if (count(hub, "SELECT COUNT(*) AS n FROM bots WHERE id = ?", String(artifact.bot_id)) !== 1) fail("reference_broken", "context artifact bot is missing from the hub");
  }
  if (count(db, `SELECT COUNT(*) AS n FROM revisions r WHERE NOT EXISTS (SELECT 1 FROM artifacts a WHERE a.id = r.artifact_id)`) !== 0) {
    fail("reference_broken", "context revision has no artifact");
  }
  if (count(db, `SELECT COUNT(*) AS n FROM activations a WHERE NOT EXISTS
      (SELECT 1 FROM skills s WHERE s.id = a.skill_id AND s.version = a.version AND s.hash = a.hash)`) !== 0) {
    fail("reference_broken", "context activation does not match a skill");
  }
  if(one(db,"SELECT name FROM sqlite_schema WHERE type='table' AND name='bot_documents'")){
    const owner=one(db,"SELECT value FROM meta WHERE key='owner'")?.value;
    for(const row of all(db,"SELECT bot_id,revision,soul_pin_json,user_pin_json,memory_pin_json,updated_at FROM bot_documents")){
      const botId=row.bot_id,revision=row.revision;
      if(typeof botId!=="string"||!/^[A-Za-z0-9_-]{1,128}$/.test(botId)
        ||typeof revision!=="number"||!Number.isSafeInteger(revision)||revision<1
        ||typeof row.updated_at!=="number"||!Number.isSafeInteger(row.updated_at)||row.updated_at<0
        ||typeof owner!=="string"||count(hub,"SELECT COUNT(*) AS n FROM bots WHERE id=? AND owner_id=?",botId,owner)!==1)
        fail("reference_broken","context bot document identity or revision is not valid");
      for(const [name,column]of[["SOUL","soul_pin_json"],["USER","user_pin_json"],["MEMORY","memory_pin_json"]]as const){
        const raw=row[column];let value:unknown;
        if(typeof raw!=="string"||raw.length>512)fail("reference_broken","context bot document pin is not valid");
        try{value=JSON.parse(raw);}catch{fail("reference_broken","context bot document pin is not valid");}
        if(typeof value!=="object"||value===null||Array.isArray(value)
          ||Object.keys(value).sort().join(",")!=="commit,path,sha256")fail("reference_broken","context bot document pin is not valid");
        const document=value as Record<string,unknown>,prefix=`memory/${botId}/${name}-r${revision}-`;
        if(typeof document.path!=="string"||!document.path.startsWith(prefix)
          ||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.md$/.test(document.path.slice(prefix.length))
          ||typeof document.sha256!=="string"||!/^[0-9a-f]{64}$/.test(document.sha256)
          ||typeof document.commit!=="string"||!/^[0-9a-f]{40}$/.test(document.commit))
          fail("reference_broken","context bot document pin is not valid");
        pin({path:document.path,git_commit:document.commit,hash:document.sha256});
      }
    }
  }
  if(one(db,"SELECT value FROM meta WHERE key='schema'")?.value==="2"||one(db,"SELECT value FROM meta WHERE key='schema'")?.value==="3"){
    const owner=one(db,"SELECT value FROM meta WHERE key='owner'")!.value;
    const readSource=(raw:unknown,botId:string)=>{
      if(typeof raw!=="string"||raw.length>2048)fail("reference_broken","Document source invalid.");
      let value:unknown;try{value=JSON.parse(raw);}catch{fail("reference_broken","Document source invalid.");}
      const parsed=MemorySourceSchema.safeParse(value);
      if(!parsed.success||canonicalJson(parsed.data as never)!==raw)fail("reference_broken","Document source invalid.");
      const source=parsed.data;
      if(source.kind!=="legacy_unknown"&&source.ownerId!==owner)fail("reference_broken","Document source owner invalid.");
      if(source.kind==="harness_action"){
        if(count(hub,"SELECT COUNT(*) AS n FROM actions WHERE id=? AND bot_id=? AND thread_id=? AND decided_by=?",source.actionId,botId,source.threadId,String(owner))!==1
          ||count(hub,"SELECT COUNT(*) AS n FROM tool_action_continuations WHERE action_id=? AND origin_turn_id=? AND call_id=?",source.actionId,source.turnId,source.callId)!==1)
          fail("reference_broken","Document source action invalid.");
      }
      return source;
    };
    for(const row of all(db,"SELECT * FROM bot_document_revisions")){
      const botId=String(row.bot_id),revision=Number(row.revision),head=one(db,"SELECT * FROM bot_documents WHERE bot_id=?",botId);
      if(!head||!Number.isSafeInteger(revision)||revision<1||revision>Number(head.revision)||!Number.isSafeInteger(row.updated_at)||Number(row.updated_at)<0)fail("reference_broken","Document revision invalid.");
      readSource(row.memory_source_json,botId);
      if(row.restored_from!==null&&(Number(row.restored_from)>=revision||count(db,"SELECT COUNT(*) AS n FROM bot_document_revisions WHERE bot_id=? AND revision=?",botId,Number(row.restored_from))!==1))fail("reference_broken","Document restore source invalid.");
      for(const [name,column]of[["SOUL","soul_pin_json"],["USER","user_pin_json"],["MEMORY","memory_pin_json"]]){
        let value:Record<string,unknown>;try{value=JSON.parse(String(row[column!]));}catch{fail("reference_broken","Document revision pin invalid.");}
        const prefix=`memory/${botId}/${name}-r${revision}-`;
        if(Object.keys(value).sort().join(',')!=="commit,path,sha256"||typeof value.path!=="string"||!value.path.startsWith(prefix)
          ||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.md$/.test(value.path.slice(prefix.length)))fail("reference_broken","Document revision pin invalid.");
        pin({path:value.path,git_commit:value.commit,hash:value.sha256});
        if(revision===head.revision&&row[column!]!==head[column!])fail("reference_broken","Document head mismatch.");
      }
    }
    if(count(db,"SELECT COUNT(*) AS n FROM bot_documents d WHERE NOT EXISTS (SELECT 1 FROM bot_document_revisions r WHERE r.bot_id=d.bot_id AND r.revision=d.revision)")!==0)fail("reference_broken","Document head lacks history.");
    for(const row of all(db,"SELECT * FROM bot_document_receipts")){
      const botId=String(row.bot_id),origin=readSource(row.origin_json,botId),key=String(row.operation_key);
      if(origin.kind==="legacy_unknown"||key!==(origin.kind==="owner_ui"?`owner:${origin.clientRequestId}`:`action:${origin.actionId}`)
        ||typeof row.input_json!=="string"||row.input_json.length>40000||createHash("sha256").update(row.input_json).digest("hex")!==row.request_hash
        ||!["update","restore","append"].includes(String(row.operation)))
        fail("reference_broken","Document receipt invalid.");
      let input:Record<string,unknown>;try{input=JSON.parse(row.input_json);}catch{fail("reference_broken","Document receipt input invalid.");}
      if(row.operation==="append"){
        const parsed=AppendBotMemoryNoteSchema.safeParse(input),effect=origin.kind==="harness_action"?origin.memoryNote:undefined;
        if(!parsed.success||origin.kind!=="harness_action"||origin.reference!==null||!effect||effect.baseRevision!==parsed.data.expectedRevision
          ||effect.sha256!==createHash("sha256").update(parsed.data.note).digest("hex")||canonicalJson(input as never)!==row.input_json
          ||Number(row.revision)!==effect.baseRevision+(effect.outcome==="appended"?1:0))fail("reference_broken","Document append marker invalid.");
        const head=one(db,"SELECT * FROM bot_document_revisions WHERE bot_id=? AND revision=?",botId,Number(row.revision));
        const base=effect.baseRevision===0?null:one(db,"SELECT * FROM bot_document_revisions WHERE bot_id=? AND revision=?",botId,effect.baseRevision);
        if(!head||effect.baseRevision!==0&&!base||!Number.isSafeInteger(row.created_at)||Number(row.created_at)<Number(head.updated_at)
          ||effect.outcome==="appended"&&(head.updated_at!==row.created_at||head.memory_source_json!==row.origin_json||head.restored_from!==null))fail("reference_broken","Document append revision invalid.");
        const hash=(record:Record<string,unknown>|null|undefined,column:string)=>record?String((JSON.parse(String(record[column]))as Record<string,unknown>).sha256):createHash("sha256").update('').digest("hex");
        if(effect.baseMemoryHash!==hash(base,"memory_pin_json")||hash(head,"soul_pin_json")!==hash(base,"soul_pin_json")||hash(head,"user_pin_json")!==hash(base,"user_pin_json"))fail("reference_broken","Document append predecessor invalid.");
        const action=one(hub,"SELECT request,created_at FROM actions WHERE id=?",origin.actionId)!;
        let request:Record<string,unknown>;try{request=JSON.parse(String(action.request));}catch{fail("reference_broken","Document append action invalid.");}
        const args=request.arguments as Record<string,unknown>,pin=args.pin as Record<string,unknown>;
        if(request.botId!==botId||request.threadId!==origin.threadId||request.destination!=="dexter-harness-owner-proposals"||request.tool!=="dexter.harness.memory.append"
          ||count(hub,"SELECT COUNT(*) AS n FROM action_authorizations WHERE action_id=? AND source='exact_owner'",origin.actionId)!==1
          ||Number(row.created_at)<Number(action.created_at)||canonicalJson(args.input as never)!==row.input_json||!pin||Object.keys(pin).sort().join(',')!=="memoryHash,revision,soulHash,userHash"
          ||pin.revision!==effect.baseRevision||pin.memoryHash!==effect.baseMemoryHash||pin.soulHash!==hash(base,"soul_pin_json")||pin.userHash!==hash(base,"user_pin_json"))fail("reference_broken","Document append action pin invalid.");
        const documentText=(record:Record<string,unknown>|null|undefined,column:string):string=>{
          if(!record)return '';
          const document=JSON.parse(String(record[column]))as Record<string,unknown>;
          return git.documentText(String(document.commit),String(document.path),String(document.sha256));
        };
        const before=documentText(base,"memory_pin_json"),after=documentText(head,"memory_pin_json"),note=parsed.data.note;
        const present=before===note||before.startsWith(`${note}\n\n`)||before.endsWith(`\n\n${note}`)||before.includes(`\n\n${note}\n\n`);
        const expected=effect.outcome==="already_present"?before:before.length===0?note:`${before}\n\n${note}`;
        if((effect.outcome==="already_present")!==present||after!==expected)fail("reference_broken","Document append literal bytes invalid.");
        // Reading both bodies also enforces fatal UTF-8/schema limits on the unchanged human documents.
        for(const column of ["soul_pin_json","user_pin_json"])
          if(documentText(base,column)!==documentText(head,column))fail("reference_broken","Document append human document bytes changed.");
        continue;
      }
      if(origin.kind==="harness_action"&&origin.memoryNote!==undefined)fail("reference_broken","Document receipt marker incompatible with operation.");
      if(count(db,"SELECT COUNT(*) AS n FROM bot_document_revisions WHERE bot_id=? AND revision=? AND updated_at=?",botId,Number(row.revision),Number(row.created_at))!==1
        ||canonicalJson(input as never)!==row.input_json||Number(input.expectedRevision)+1!==row.revision)fail("reference_broken","Document receipt input invalid.");
      if(origin.kind==="owner_ui"){
        const parsed=row.operation==="restore"?RestoreBotMemorySchema.safeParse(input):SetBotDocumentsSchema.safeParse(input);
        if(!parsed.success||parsed.data.clientRequestId!==origin.clientRequestId)fail("reference_broken","Document owner receipt invalid.");
      }else{
        const action=one(hub,"SELECT request FROM actions WHERE id=?",origin.actionId)!;
        let request:Record<string,unknown>;try{request=JSON.parse(String(action.request));}catch{fail("reference_broken","Document action invalid.");}
        const args=request.arguments as Record<string,unknown>;
        if(canonicalJson(args.input as never)!==row.input_json||request.tool!==(row.operation==="restore"?"dexter.harness.memory.restore":"dexter.harness.documents.update"))fail("reference_broken","Document action input invalid.");
      }
    }
  }
  validateMemoryRoutines(db, hub, git);
  validateMemoryLedger(db, hub);
}

/** Optional Team profiles extend existing canonical rows. Historical thread coordinators remain immutable. */
function validateContextTeams(db: DatabaseSync, hub: DatabaseSync): void {
  const owner = one(db,"SELECT value FROM meta WHERE key='owner'")?.value;
  const validID = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  const validNumber = (value: unknown, minimum: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
  if (!validID(owner)) fail("reference_broken","context team owner is invalid");
  const teams = all(db,"SELECT id,owner_id,name FROM teams"), teamIds = new Set<string>();
  if (teams.length > MAX_TEAMS) fail("reference_broken","context team limit exceeded");
  for (const row of teams) {
    if (!validID(row.id) || row.owner_id !== owner || typeof row.name !== "string"
      || !TeamSchema.shape.name.safeParse(row.name).success) fail("reference_broken","context team identity is invalid");
    teamIds.add(row.id);
    if (count(db,"SELECT COUNT(*) AS n FROM members WHERE team_id=? AND owner_id=?",row.id,owner) !== 1)
      fail("reference_broken","context team has no owner membership");
  }
  for (const row of all(db,"SELECT team_id,owner_id,active,revision FROM members")) {
    if (!validID(row.team_id) || !teamIds.has(row.team_id) || !validID(row.owner_id)
      || ![0,1].includes(Number(row.active)) || typeof row.active !== "number" || !validNumber(row.revision,1))
      fail("reference_broken","context team membership is invalid");
  }
  const botSets = new Map<string,Set<string>>();
  for (const row of all(db,"SELECT team_id,bot_id FROM team_bots")) {
    if (!validID(row.team_id) || !teamIds.has(row.team_id) || !validID(row.bot_id)
      || count(hub,"SELECT COUNT(*) AS n FROM bots WHERE id=? AND owner_id=?",row.bot_id,owner) !== 1
      || count(db,"SELECT COUNT(*) AS n FROM members WHERE team_id=? AND owner_id=?",row.team_id,owner) !== 1)
      fail("reference_broken","context team bot is missing or belongs to another owner");
    const members = botSets.get(row.team_id) ?? new Set<string>();
    members.add(row.bot_id); botSets.set(row.team_id,members);
    if (members.size > MAX_TEAM_BOTS) fail("reference_broken","context team bot limit exceeded");
  }
  const raw = one(db,"SELECT value FROM meta WHERE key=?",TEAM_WORKSPACES_META_KEY)?.value;
  if (raw === undefined) return;
  if (typeof raw !== "string" || Buffer.byteLength(raw,"utf8") > MAX_TEAM_METADATA_BYTES) fail("reference_broken","context team document is invalid");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { fail("reference_broken","context team document is invalid"); }
  const parsed = TeamWorkspacesMetadataSchema.safeParse(value);
  if (!parsed.success || teamWorkspacesCanonicalJSON(parsed.data) !== raw) fail("reference_broken","context team document is not canonical");
  const metadata = parsed.data;
  const avatar=(imageId:string):Record<string,unknown>=>{
    if(Number(one(hub,"PRAGMA user_version")?.user_version)<10)fail("reference_broken","Team avatar media is unavailable.");
    const row=one(hub,"SELECT id,media_type,sha256,bytes,width,height,created_at FROM avatar_images WHERE id=? AND owner_id=?",imageId,owner);
    if(!row)fail("reference_broken","Team avatar media is missing or belongs to another owner.");
    return{id:row.id,mediaType:row.media_type,sha256:row.sha256,bytes:row.bytes,width:row.width,height:row.height,createdAt:row.created_at};
  };
  for (const [teamId,profile] of Object.entries(metadata.profiles)) {
    if (!teamIds.has(teamId) || !botSets.get(teamId)?.has(profile.coordinatorBotId)
      || profile.createdAt > profile.updatedAt || count(hub,"SELECT COUNT(*) AS n FROM bots WHERE id=? AND owner_id=?",profile.coordinatorBotId,owner) !== 1)
      fail("reference_broken","context team profile does not match the canonical registry");
    if(profile.avatarImageId)avatar(profile.avatarImageId);
  }
  for (const [threadId,binding] of Object.entries(metadata.bindings)) {
    const profile = metadata.profiles[binding.teamId];
    if (!teamIds.has(binding.teamId) || !profile || binding.teamRevision > profile.revision
      || count(hub,"SELECT COUNT(*) AS n FROM bots WHERE id=? AND owner_id=?",binding.coordinatorBotId,owner) !== 1
      || count(hub,"SELECT COUNT(*) AS n FROM threads WHERE id=? AND bot_id=?",threadId,binding.coordinatorBotId) !== 1)
      fail("reference_broken","context team thread binding is invalid");
    // A changed coordinator or removed bot must not erase history. Compare the stored coordinator to its thread.
    if (binding.delegationId !== null) {
      if (Number(one(hub,"PRAGMA user_version")?.user_version) < 6) fail("reference_broken","context team delegation is unavailable");
      const link = one(hub,"SELECT * FROM bot_delegations WHERE id=?",binding.delegationId);
      if (!link || link.target_thread_id !== threadId || link.target_bot_id !== binding.coordinatorBotId
        || !validID(link.source_bot_id) || !validID(link.source_thread_id) || !validID(link.source_turn_id)
        || !validID(link.target_turn_id) || !validID(link.root_id)
        || count(hub,"SELECT COUNT(*) AS n FROM bots WHERE id=? AND owner_id=?",link.source_bot_id,owner) !== 1
        || count(hub,"SELECT COUNT(*) AS n FROM turns WHERE id=? AND thread_id=? AND bot_id=?",link.source_turn_id,link.source_thread_id,link.source_bot_id) !== 1
        || count(hub,"SELECT COUNT(*) AS n FROM turns WHERE id=? AND thread_id=? AND bot_id=?",link.target_turn_id,threadId,binding.coordinatorBotId) !== 1
        || count(hub,"SELECT COUNT(*) AS n FROM turns WHERE id=?",link.root_id) !== 1)
        fail("reference_broken","context team delegation provenance is invalid");
    }
  }
  const receiptTeams = new Set<string>();
  for (const receipt of Object.values(metadata.createReceipts)) {
    const team = receipt.team, profile = metadata.profiles[team.id];
    if (receiptTeams.has(team.id) || !teamIds.has(team.id) || !profile || team.ownerId !== owner || team.coordinatorBotId === null
      || !team.botIds.includes(team.coordinatorBotId) || team.revision < 1 || team.revision > profile.revision
      || team.createdAt !== profile.createdAt || team.createdAt > team.updatedAt)
      fail("reference_broken","context team creation receipt is invalid");
    receiptTeams.add(team.id);
    if(team.avatarImage && teamWorkspacesCanonicalJSON(team.avatarImage)!==teamWorkspacesCanonicalJSON(avatar(team.avatarImage.id)))
      fail("reference_broken","Team avatar creation receipt is not canonical.");
    for (const botId of team.botIds) {
      if (count(hub,"SELECT COUNT(*) AS n FROM bots WHERE id=? AND owner_id=?",botId,owner) !== 1)
        fail("reference_broken","context team creation receipt refers to a missing bot");
    }
  }
  const receiptThreads = new Set<string>();
  for (const [clientRequestId,receipt] of Object.entries(metadata.threadReceipts)) {
    const binding = metadata.bindings[receipt.threadId];
    const requestHash = createHash("sha256").update(teamWorkspacesCanonicalJSON({teamId:receipt.teamId,
      expectedRevision:receipt.expectedRevision,clientRequestId})).digest("hex");
    if (receiptThreads.has(receipt.threadId) || !binding || binding.delegationId !== null || binding.teamId !== receipt.teamId
      || binding.coordinatorBotId !== receipt.coordinatorBotId || binding.teamRevision !== receipt.teamRevision
      || binding.createdAt !== receipt.createdAt || receipt.expectedRevision !== receipt.teamRevision || receipt.requestHash !== requestHash)
      fail("reference_broken","context team conversation receipt is invalid");
    receiptThreads.add(receipt.threadId);
  }
  for (const [threadId,binding] of Object.entries(metadata.bindings)) {
    if (binding.delegationId === null && !receiptThreads.has(threadId)) fail("reference_broken","context team conversation has no creation receipt");
  }
}

/** Schedules point at Hub threads of their bot; occurrences with a turn point at a turn of that thread. */
export function validateAgenda(db: DatabaseSync, hub: DatabaseSync): void {
  for (const schedule of all(db, "SELECT bot_id, thread_id FROM schedules")) {
    if (count(hub, "SELECT COUNT(*) AS n FROM threads WHERE id = ? AND bot_id = ?", String(schedule.thread_id), String(schedule.bot_id)) !== 1) {
      fail("reference_broken", "agenda schedule thread is missing from the hub");
    }
  }
  for (const occurrence of all(db, `SELECT o.turn_id, s.thread_id FROM occurrences o JOIN schedules s ON s.id = o.schedule_id WHERE o.turn_id IS NOT NULL`)) {
    if (count(hub, "SELECT COUNT(*) AS n FROM turns WHERE id = ? AND thread_id = ?", String(occurrence.turn_id), String(occurrence.thread_id)) !== 1) {
      fail("reference_broken", "agenda occurrence turn is missing from the hub");
    }
  }
}

export function sameCounts(a: unknown, b: unknown, kind: string): void {
  if (JSON.stringify(a) !== JSON.stringify(b)) fail("corrupt", `${kind} counts do not match the manifest`);
}
