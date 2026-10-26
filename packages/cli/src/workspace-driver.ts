import { lstatSync, mkdirSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { EngineMcpAttachmentSchema } from "@dexter/contracts";
import type { EngineMcpAttachment, EngineId, EngineSelection, ImageAttachment, JsonValue } from "@dexter/contracts";
import { ClaudeCliDriver, CodexAppServerDriver, GrokAcpDriver, AntigravityAcpDriver, MuseMspDriver, EngineError } from "@dexter/engines";
import type { EngineDriver, EngineEvent, EngineImageInput, EngineSession, NativeMcpServer } from "@dexter/engines";
import { prepareMcpTurn, type TurnToolSurface, type McpTurnLease, type McpTurnOptions } from "@dexter/gateway";
import type { HostStore, RuntimeOpenContext } from "@dexter/hub";
import { isCanonicalCommandPath } from "./engine-command-config.js";

/** Options come from trusted host composition, never engine arguments. */
export interface WorkspaceNativeOptions {
  cwd?: string;
  localMcpServer?: NativeMcpServer;
  allowedMcpTools?: readonly string[];
  observeMcpAttachment?: (evidence: EngineMcpAttachment) => void;
  /** Fixed per engine by host composition; never derived from the workspace, lease or turn. */
  command?: string;
}
export interface WorkspaceDriverOptions {
  mcp?: { gateway: TurnToolSurface; wrapperPath: string; bridgeLimits?: McpTurnOptions["bridgeLimits"];artifactSink?:McpTurnOptions["artifactSink"] };
  /** Operator-selected absolute executable (already resolved by startup); absent keeps the PATH-named native CLI. */
  command?: string;
  /** Trusted fixture/factory seam. Production uses the native drivers below. */
  makeDriver?: (engine: EngineId, options: WorkspaceNativeOptions) => EngineDriver;
}
interface ImageDirectory { directory:string; ino:bigint; files:{path:string;ino:bigint}[]; images:EngineImageInput[] }
interface Binding { driver: EngineDriver; lease: McpTurnLease | null; turnId: string | null; closePromise: Promise<void> | null; cwd:string; images:Map<string,ImageDirectory> }

/** Separate working directories organize bot context within the owner's trust domain. */
export class WorkspaceDriver implements EngineDriver {
  private readonly sessions = new Map<EngineSession, Binding>();
  private readonly options: WorkspaceDriverOptions;
  readonly sessionReuse: "thread" | "turn";
  get capabilities() { return { ...this.make().capabilities }; }
  constructor(readonly id: EngineId, private readonly store: HostStore, private readonly dataDir: string, options: WorkspaceDriverOptions = {}) {
    if (options.mcp && (!isAbsolute(options.mcp.wrapperPath) || resolve(options.mcp.wrapperPath) !== options.mcp.wrapperPath)) throw new EngineError("protocol_error");
    if (options.command !== undefined && !isCanonicalCommandPath(options.command)) throw new EngineError("protocol_error");
    this.options = Object.freeze({ ...options, ...(options.mcp ? { mcp: Object.freeze({ ...options.mcp }) } : {}) });
    this.sessionReuse = options.mcp ? "turn" : "thread";
  }
  private make(built: WorkspaceNativeOptions = {}): EngineDriver {
    // Same command for status and open; workspace/lease fields (cwd, native MCP, allowed tools) are kept as built.
    const options: WorkspaceNativeOptions = this.options.command === undefined ? built : { ...built, command: this.options.command };
    const driver = this.options.makeDriver?.(this.id, options) ?? (() => {
      switch (this.id) {
        case "claude": return new ClaudeCliDriver(options);
        case "codex": return new CodexAppServerDriver(options);
        case "grok": return new GrokAcpDriver(options);
        case "muse": return new MuseMspDriver(options);
        case "antigravity": return new AntigravityAcpDriver(options);
      }
    })();
    if (driver.id !== this.id) throw new EngineError("protocol_error");
    return driver;
  }
  status() { return this.make().status(); }
  private assertTurn(threadId: string, turnId: string): void {
    const turn = this.store.getTurn(turnId); const thread = this.store.getThread(threadId); const bot = this.store.getBot(thread.botId);
    if (turn.state !== "running" || turn.threadId !== threadId || turn.botId !== bot.id || turn.engine !== this.id) throw new EngineError("protocol_error");
  }
  async open(threadId: string, nativeCursor?: string, context?: RuntimeOpenContext): Promise<EngineSession> {
    const thread = this.store.getThread(threadId);
    const bot = this.store.getBot(thread.botId);
    if ((context?.selection?.engine ?? bot.engine) !== this.id) throw new EngineError("protocol_error");
    if (![bot.id, thread.id].every(id => /^[A-Za-z0-9_-]+$/.test(id))) throw new EngineError("protocol_error");
    if (this.options.mcp) {
      if (!context || context.signal.aborted) throw new EngineError("session_closed");
      this.assertTurn(threadId, context.turnId);
    }
    const cwd = join(this.dataDir, "workspaces", bot.id, thread.id);
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    let lease: McpTurnLease | null = null;
    let driver: EngineDriver | null = null;
    let session: EngineSession | null = null;
    try {
      if (this.options.mcp && context) {
        lease = await prepareMcpTurn({ store: this.store, gateway: this.options.mcp.gateway, wrapperPath: this.options.mcp.wrapperPath,
          bridgeLimits:{...this.options.mcp.bridgeLimits,catalogTokenBudget:Math.min(this.options.mcp.bridgeLimits?.catalogTokenBudget??16_000,
            {claude:16_000,codex:12_000,grok:6_000,muse:4_000,antigravity:6_000}[this.id]),
            pinnedToolNames:["dexter.harness.guide","dexter.harness.configuration","dexter.harness.status"],
            multimodalResults:this.id==="claude"||this.id==="codex"},
          ...(this.options.mcp.artifactSink?{artifactSink:this.options.mcp.artifactSink}:{}),
          turnId: context.turnId, signal: context.signal });
        const scope = lease.scope;
        if (scope.installationId !== this.store.hostId || scope.ownerId !== this.store.ownerId || scope.botId !== bot.id
          || scope.profileId !== bot.profileId || scope.threadId !== threadId || scope.turnId !== context.turnId) throw new EngineError("protocol_error");
        if (context.signal.aborted || lease.isStopped) throw new EngineError("session_closed");
      }
      let observed = false;
      const observeMcpAttachment = (input: EngineMcpAttachment): void => {
        const parsed = EngineMcpAttachmentSchema.safeParse(input);
        if (!parsed.success || parsed.data.engine !== this.id || !lease || !context || lease.isStopped || context.signal.aborted) throw new EngineError('protocol_error');
        this.assertTurn(threadId, context.turnId);
        if (observed) return;
        this.store.recordToolEvent(context.turnId, 'tool.resolved', { kind: 'engine_mcp_attachment', ...parsed.data });
        observed = true;
      };
      driver = this.make({ cwd, ...(['grok', 'muse'].includes(this.id) && lease ? { observeMcpAttachment } : {}), ...(lease ? { localMcpServer: lease.nativeServer,
        ...(["claude", "grok", "muse", "antigravity"].includes(this.id) ? { allowedMcpTools: lease.allowedMcpTools } : {}) } : {}) });
      session = await driver.open(threadId, nativeCursor, context);
      const binding: Binding = { driver, lease, turnId: lease ? context!.turnId : null, closePromise: null,cwd,images:new Map() };
      this.sessions.set(session, binding);
      if (session.threadId !== threadId || typeof session.nativeCursor !== "string") throw new EngineError("protocol_error");
      if (lease && context) {
        if (context.signal.aborted || lease.isStopped) throw new EngineError("session_closed");
        this.assertTurn(threadId, context.turnId);
      }
      return session;
    } catch (error) {
      lease?.stop();
      if (session && driver) {
        try { await this.close(session); }
        catch {
          // close has awaited both native cleanup and MCP residue. A rejected native
          // close cannot confirm cleanup: retain the opening forever. The runtime's
          // abort race then quarantines this opening and keeps its thread/writer.
          await new Promise<never>(() => {});
        }
      }
      else if (lease) {
        // A rejected native open owns its partial process cleanup (Codex awaits stop before rejecting).
        // No session was returned, so never fabricate a cursor/session for close.
        // Await the residue even when cleanup rejects. As in the returned-session
        // branch, retain the original engine error; cleanup failure may retain
        // unexpected local files and must not be described as successful cleanup.
        await lease.whenDrained().catch(() => {});
      }
      throw error;
    }
  }
  private binding(session: EngineSession, turnId?: string): Binding {
    const binding = this.sessions.get(session);
    if (!binding || binding.closePromise) throw new EngineError("session_closed");
    if (binding.turnId !== null && (binding.turnId !== turnId || binding.lease?.isStopped)) throw new EngineError("session_closed");
    return binding;
  }
  turn(session: EngineSession, turnId: string, input: string, signal: AbortSignal, _selection?:EngineSelection, attachments?:readonly ImageAttachment[]): AsyncIterable<EngineEvent> {
    const binding = this.binding(session, turnId);
    if (binding.lease) this.assertTurn(session.threadId, turnId);
    // Only this bot's host-owned role is context. Other bot profiles/memory never enter its instruction.
    const turn = this.store.getTurn(turnId), role = this.store.getBot(turn.botId).roleDescription;
    this.assertTurn(session.threadId,turnId);
    const persisted=this.store.turnAttachments(turnId);
    if(attachments!==undefined && JSON.stringify(attachments)!==JSON.stringify(persisted))throw new EngineError("protocol_error");
    if(persisted.length && binding.driver.capabilities.supportsImages!==true)throw new EngineError("unsupported");
    let images=binding.images.get(turnId);
    if(persisted.length && !images){
      if(signal.aborted)throw new EngineError("session_closed");
      const directory=mkdtempSync(join(binding.cwd,`.dexter-images-${turnId}-`)),ino=lstatSync(directory,{bigint:true}).ino;
      images={directory,ino,files:[],images:[]};binding.images.set(turnId,images);
      try{
        for(const image of persisted){
          const own=this.store.getImageAttachment(session.threadId,image.id);
          if(JSON.stringify(own.attachment)!==JSON.stringify(image))throw new EngineError("protocol_error");
          const path=join(directory,`${image.id}.png`);
          writeFileSync(path,own.data,{flag:"wx",mode:0o600});
          images.files.push({path,ino:lstatSync(path,{bigint:true}).ino});
          images.images.push({...image,data:own.data,localPath:path});
        }
      }catch(error){this.removeImages(images);binding.images.delete(turnId);throw error;}
    }
    const contextual = role ? `Host-configured role for this bot:\n${role}\n\nTask:\n${input}` : input;
    return binding.driver.turn(session, turnId, contextual, signal, turn.selection,images?.images);
  }
  respondToTool(session: EngineSession, turnId: string, requestId: string, result: JsonValue): Promise<void> {
    return this.binding(session, turnId).driver.respondToTool(session, turnId, requestId, result);
  }
  interrupt(session: EngineSession, turnId: string): Promise<void> {
    const binding = this.sessions.get(session);
    if (!binding) return Promise.resolve();
    if (binding.turnId !== null && binding.turnId !== turnId) return Promise.reject(new EngineError("session_closed"));
    binding.lease?.stop(); // revoke synchronously, before an uncooperative native interrupt can wait
    return binding.driver.interrupt(session, turnId);
  }
  close(session: EngineSession): Promise<void> {
    const binding = this.sessions.get(session);
    if (!binding) return Promise.resolve();
    binding.lease?.stop();
    binding.closePromise ??= this.drain(session, binding);
    return binding.closePromise;
  }
  private async drain(session: EngineSession, binding: Binding): Promise<void> {
    const settled = await Promise.allSettled([
      Promise.resolve().then(() => binding.driver.close(session)),
      Promise.resolve().then(() => binding.lease?.whenDrained()),
    ]);
    if (this.sessions.get(session) === binding) this.sessions.delete(session);
    const failure = settled.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    // Only after the owned native driver and MCP calls drain; interrupted inference may still hold its paths.
    for(const images of binding.images.values())this.removeImages(images);
    binding.images.clear();
  }
  private removeImages(images:ImageDirectory):void {
    // A substituted file/directory belongs to somebody else: cleanup never recursively removes it.
    const directory=(()=>{try{return lstatSync(images.directory,{bigint:true});}catch{return null;}})();
    if(!directory?.isDirectory() || directory.isSymbolicLink() || directory.ino!==images.ino)return;
    for(const file of images.files){
      const stat=(()=>{try{return lstatSync(file.path,{bigint:true});}catch{return null;}})();
      if(stat?.isFile() && !stat.isSymbolicLink() && stat.ino===file.ino)try{unlinkSync(file.path);}catch{/* Retain residue; never delete a replacement. */}
    }
    try{rmdirSync(images.directory);}catch{/* Unexpected foreign contents are retained, not recursively removed. */}
  }
}
