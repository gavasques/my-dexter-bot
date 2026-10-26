import { createHash, randomBytes } from "node:crypto";
import { GatewayError, MCP_AUTHORIZED_INVENTORY_LIMIT, type CapabilityScope, type GatewayCallResult, type ToolView, type TurnToolSurface } from "@dexter/gateway";

interface LifecycleSurface extends TurnToolSurface { stopAdmission?(): void; close?(): void | Promise<void> }
interface DeviceSurface extends LifecycleSurface { ownsRoute(id: string): boolean; reserveCompositeCall(token: string,input: unknown,context: {surface:"gateway"|"device";listed:boolean}): void }
interface CompositeCapability { gateway: string; devices: string | null; scope: Readonly<CapabilityScope> }
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const identities = ["installationId","ownerId","profileId","botId","threadId","turnId"] as const;
function error(code: "unauthorized" | "conflict" | "unavailable" | "invalid_input"): never { throw new GatewayError(code,`turn tools: ${code}`); }

/** Trusted facade over the unchanged gateway and optional device surface, never an engine-selected router. */
export class CompositeTurnSurface implements TurnToolSurface {
  readonly #gateway: LifecycleSurface; readonly #devices: DeviceSurface | undefined;
  readonly #caps = new Map<string,CompositeCapability>(); readonly #calls = new Set<Promise<GatewayCallResult>>();
  private readonly limits: Readonly<{ maxCapabilities?: number; maxCatalogTools?: number }>;
  #stopped = false; #closed = false; #closing: Promise<void> | null = null;
  constructor(gateway: LifecycleSurface, devices?: DeviceSurface, limits: {
    maxCapabilities?: number;
    /** Total eligible inventory before the separate MCP direct schema/token planner. */
    maxCatalogTools?: number;
  } = {}) {
    this.#gateway = gateway; this.#devices = devices; this.limits = Object.freeze({ ...limits });
    const capabilities = limits.maxCapabilities ?? 128, inventory = limits.maxCatalogTools ?? MCP_AUTHORIZED_INVENTORY_LIMIT;
    if (!Number.isSafeInteger(capabilities) || capabilities < 1 || capabilities > 1024
      || !Number.isSafeInteger(inventory) || inventory < 1 || inventory > MCP_AUTHORIZED_INVENTORY_LIMIT) error("invalid_input");
  }
  toJSON(): object { return this.status(); }
  status(): { accepting: boolean; capabilities: number; calls: number; closed: boolean } { return { accepting:!this.#stopped,capabilities:this.#caps.size,calls:this.#calls.size,closed:this.#closed }; }
  issueCapability(input: { turnId: string; ttlMs?: number }): { token: string; scope: CapabilityScope } {
    if (this.#stopped) error("unavailable");
    // Validate existing child capabilities; a terminal/expired child revokes both sides and frees the slot.
    for (const [key,cap] of this.#caps) { try { this.#gateway.listTools(cap.gateway); if (cap.devices) this.#devices!.listTools(cap.devices); } catch { this.remove(key,cap); } }
    if (this.#caps.size >= (this.limits.maxCapabilities ?? 128)) error("unavailable");
    let gw: ReturnType<TurnToolSurface["issueCapability"]> | undefined, dv: ReturnType<TurnToolSurface["issueCapability"]> | undefined;
    try {
      gw = this.#gateway.issueCapability(input); this.validateIssued(gw,input.turnId);
      if (this.#devices) { dv = this.#devices.issueCapability(input); this.validateIssued(dv,input.turnId); if (identities.some(k => dv!.scope[k] !== gw!.scope[k])) error("unauthorized"); }
      const scope = Object.freeze({ ...gw.scope,expiresAt:Math.min(gw.scope.expiresAt,dv?.scope.expiresAt ?? gw.scope.expiresAt) });
      const token = randomBytes(32).toString("base64url"), cap = { gateway:gw.token,devices:dv?.token ?? null,scope };
      this.#caps.set(sha(token),cap);
      // Catalog conflicts/limits are admission failures, not a half-issued capability.
      try { this.listTools(token); } catch (e) { this.remove(sha(token),cap); throw e; }
      return { token,scope };
    } catch (e) {
      if (gw) this.revokeChild(this.#gateway,gw.token); if (dv && this.#devices) this.revokeChild(this.#devices,dv.token);
      throw e instanceof GatewayError ? e : new GatewayError("unavailable","turn tools unavailable");
    }
  }
  private validateIssued(issued: ReturnType<TurnToolSurface["issueCapability"]>,turnId: string): void {
    if (!issued || typeof issued.token !== "string" || !TOKEN.test(issued.token) || !issued.scope || identities.some(k => typeof issued.scope[k] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(issued.scope[k]))
      || issued.scope.turnId !== turnId || !Number.isSafeInteger(issued.scope.expiresAt) || issued.scope.expiresAt <= 0) error("unauthorized");
  }
  private resolve(token: string): CompositeCapability {
    if (this.#stopped || typeof token !== "string" || !TOKEN.test(token)) error("unauthorized");
    const cap = this.#caps.get(sha(token)); if (!cap) error("unauthorized"); return cap;
  }
  listTools(token: string): ToolView[] {
    const cap = this.resolve(token);
    try {
      const views = [...this.#gateway.listTools(cap.gateway),...(cap.devices ? this.#devices!.listTools(cap.devices) : [])];
      if (views.length > (this.limits.maxCatalogTools ?? MCP_AUTHORIZED_INVENTORY_LIMIT)) error("unavailable");
      const aliases = new Set<string>();
      for (const v of views) {
        const alias = sha(`${v.name}\0${v.connectionId}`).slice(0,24);
        if (aliases.has(alias) || !v.name || !v.connectionId || v.connectionId.length > 128 || v.name.length > 128) error("conflict");
        aliases.add(alias);
      }
      return views;
    } catch (e) { this.remove(sha(token),cap); throw e; }
  }
  call(token: string,input: unknown,options: { signal?: AbortSignal } = {}): Promise<GatewayCallResult> {
    let operation: Promise<GatewayCallResult>;
    try {
      const cap = this.resolve(token), views = this.listTools(token);
      const raw = structuredClone(input) as Record<string,unknown>;
      if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof raw.connectionId !== "string") error("invalid_input");
      const target = this.#devices?.ownsRoute(raw.connectionId) ? this.#devices : this.#gateway;
      const child = target === this.#devices ? cap.devices : cap.gateway; if (!child) error("unauthorized");
      if (cap.devices) this.#devices!.reserveCompositeCall(cap.devices,raw,{surface:target === this.#devices ? "device" : "gateway",listed:views.some(v=>v.name===raw.tool && v.connectionId===raw.connectionId)});
      // Catalog validation above is pre-admission only. The admitted child owns its outcome and body projection;
      // a later TTL/catalog/collision/other-child failure must never rewrite a completed result.
      operation = target.call(child,raw,options);
    } catch (e) { return Promise.reject(e instanceof GatewayError || e instanceof Error && "code" in e && e.code === "host_locked" ? e : new GatewayError("unavailable","turn tools unavailable")); }
    this.#calls.add(operation); void operation.then(() => this.#calls.delete(operation),() => this.#calls.delete(operation)); return operation;
  }
  revokeCapability(token: string): void { if (typeof token !== "string") return; const key = sha(token),cap = this.#caps.get(key); if (cap) this.remove(key,cap); }
  private revokeChild(surface: TurnToolSurface,token: string): void { try { surface.revokeCapability(token); } catch { /* Revoke the other independent component even after a trusted-child failure. */ } }
  private remove(key: string,cap: CompositeCapability): void { this.#caps.delete(key); this.revokeChild(this.#gateway,cap.gateway); if (cap.devices && this.#devices) this.revokeChild(this.#devices,cap.devices); }
  stopAdmission(): void {
    if (this.#stopped) return; this.#stopped = true;
    for (const [key,cap] of this.#caps) this.remove(key,cap);
    let failure: unknown;
    for (const child of [this.#gateway,this.#devices]) try { child?.stopAdmission?.(); } catch (e) { failure ??= e; }
    if (failure) throw new GatewayError("unavailable","turn tools stop incomplete");
  }
  close(): Promise<void> {
    let stopped: unknown; try { this.stopAdmission(); } catch (e) { stopped = e; }
    this.#closing ??= (async () => {
      await Promise.allSettled([...this.#calls]);
      const closed = await Promise.allSettled([Promise.resolve().then(() => this.#gateway.close?.()),Promise.resolve().then(() => this.#devices?.close?.())]);
      if (stopped || closed.some(x => x.status === "rejected") || this.#calls.size) error("unavailable");
      this.#closed = true;
    })(); return this.#closing;
  }
}
