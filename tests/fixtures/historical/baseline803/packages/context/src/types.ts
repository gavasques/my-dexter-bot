export class ContextError extends Error {
  constructor(readonly code: "invalid_input" | "forbidden" | "conflict" | "not_found" | "adapter_failed" | "tampered", message: string = code) {
    super(message); this.name = "ContextError";
  }
}
export interface ContextHostOptions { capabilityTTLms?: number; memoryIdentityMapper?: import('./memory-ledger.js').MemoryIdentityMapper }
export type { BotDocuments, SetBotDocuments } from '@dexter/hub';
export type ContextScope = { kind: "global" } | { kind: "team"; teamId: string } | { kind: "bot" | "confidential"; botId: string };
export type Locale = "pt-BR" | "en-US";
export interface ServiceScope { workspace: string; project: string }
export interface ServiceHit extends ServiceScope { path: string }
export interface RecallRequest { query: string; locale: Locale; scopes: readonly ServiceScope[]; limit: number }
/** The chosen backend remains ai-memory v2.5.2. A fixture is an evaluation seam, not a replacement engine. */
export interface MemoryAdapter {
  readonly implementation: "ai-memory-read-adapter" | "fixture" | "unconfigured";
  readonly targetVersion: "2.5.2";
  search(request: RecallRequest): Promise<readonly ServiceHit[]>;
}
export interface MemoryPage {
  id: string; scope: ContextScope; locale: Locale; markdown: string; origin: string;
  classification: "context"; active: boolean; service: ServiceHit; createdAt: number;
}
export interface MemoryInput { scope: ContextScope; locale: Locale; markdown: string; origin: string; classification: "context" | "secret" | "health" }
export interface RecallInput { query: string; locale: Locale; includeConfidential?: boolean; limit?: number }
export interface SkillLock { id: string; version: string; sha256: string; commit: string; path: string }
/** Trusted owner read contracts; these are never engine-capability arguments. */
export interface SkillCatalogQuery { skillId?: string; after?: string; limit?: number }
export interface SkillCatalogPage { items: SkillLock[]; nextCursor: string | null }
export interface SkillVersion extends SkillLock { markdown: string }
export interface SkillActivationQuery { after?: string; limit?: number }
export interface SkillActivationPage { scope: ContextScope; items: SkillLock[]; nextCursor: string | null }
export interface SkillActivationExpected { version: string; sha256: string }
export interface SkillActivation { scope: ContextScope; skillId: string; lock: SkillLock | null }
export interface ArtifactRevision { id: string; revision: number; sha256: string; commit: string; path: string; origin: string; createdAt: number; restoredFrom: number | null }
export interface Artifact extends ArtifactRevision { botId: string; markdown: string; forkedFrom: { artifactId: string; revision: number } | null }
export function id(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new ContextError("invalid_input");
  return value;
}
export function text(value: unknown, max = 32_768): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || !value.isWellFormed()) throw new ContextError("invalid_input");
  return value;
}
export function locale(value: unknown): Locale {
  if (value !== "pt-BR" && value !== "en-US") throw new ContextError("invalid_input"); return value;
}
export function scope(value: ContextScope): ContextScope {
  if (!value || typeof value !== "object") throw new ContextError("invalid_input");
  switch (value.kind) {
    case "global": return { kind: "global" };
    case "team": return { kind: "team", teamId: id(value.teamId) };
    case "bot": case "confidential": return { kind: value.kind, botId: id(value.botId) };
    default: throw new ContextError("invalid_input");
  }
}
export function scopeKey(value: ContextScope): string {
  return value.kind === "global" ? "global" : value.kind === "team" ? `team:${value.teamId}` : `${value.kind}:${value.botId}`;
}
