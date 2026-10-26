import { DatabaseSync } from "node:sqlite";
import { checkMcpDefinition, looksSecret, mcpLogicalHost, mcpToolkit, mcpToolName, McpToolCatalog, NATIVE_MCP_RECEIPT_LIMIT, validateMcpSetupReceipts, readMcpSetupReceiptRow, mcpSetupHash, readMcpInstanceSelectionRow, validateMcpInstanceSelectionRows, type McpToolPlan } from "@dexter/connectors";
import { checkManifest } from "@dexter/gateway";
import { OperationsError, fail } from "./errors.js";
import { checkFullSchema, nativeMcpSchemaLabel } from "./full-schemas.js";
import { all, count, one } from "./schemas.js";
import {sanitizeNativeMcpMetadata, validateNativeMcpJournalReferences, validateNativeMcpCatalogMetadata} from './mcp-journals.js';

export interface NativeMcpCounts { servers: number; catalogs: number; selections: number; connections: number; setupReceipts?: number; instanceSelectionHeads?: number; instanceSelectionReceipts?: number }
const broken = (): never => fail("reference_broken", "native MCP portable registry is invalid; retain the source and repair its owner-reviewed configuration before transfer");
const object = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) return broken();
  return value as Record<string, unknown>;
};
const strings = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length > 256 || value.some(item => typeof item !== "string") || new Set(value).size !== value.length) return broken();
  return value as string[];
};

/** Validate portable definitions and reviewed pins; no adapter, session or process is constructed. */
export function validateNativeMcp(db: DatabaseSync, hub: DatabaseSync): NativeMcpCounts {
  try {
    const identity = checkFullSchema(db, "nativeMcp"), hubIdentity = checkFullSchema(hub, "hub");
    if (identity.installationId !== hubIdentity.installationId || identity.ownerId !== hubIdentity.ownerId)
      fail("identity_mismatch", "native MCP journal belongs to another installation");
    validateNativeMcpJournalReferences(db,hub);
    const schema = nativeMcpSchemaLabel(db);
    const servers = new Map(all(db, "SELECT * FROM servers").map(row => {
      const definition = checkMcpDefinition(JSON.parse(String(row.definition)));
      if (definition.id !== row.id) broken();
      const t = definition.transport;
      if (Object.values(t.type === "stdio" ? t.env : t.headers).some(value => value.kind === "literal")
        || (t.type === "stdio" && t.args.some((arg, i) => looksSecret(arg, t.args[i - 1])))) {
        fail("unsupported_component", "native MCP registry contains nonportable literal credentials; replace them with credential slots before transfer");
      }
      return [definition.id, definition] as const;
    }));
    if (servers.size > 256) broken();
    const selected = new Map<string, Set<string>>();
    for (const row of all(db, "SELECT * FROM catalogs")) {
      const id = String(row.server_id), definition = servers.get(id);
      if (!definition) return broken();
      const raw: unknown = JSON.parse(String(row.tools));
      validateNativeMcpCatalogMetadata(raw);
      if (!Array.isArray(raw) || raw.length > 256) return broken();
      const publishable = new Set<string>();
      const plans: McpToolPlan[] = raw.map(value => {
        const tool = object(value, ["id", "mcpName", "description", "effect", "state", "manifest", "argumentNames"]);
        if (typeof tool.mcpName !== "string" || tool.id !== mcpToolName(id, tool.mcpName)
          || typeof tool.description !== "string" || tool.description.length > 1024
          || tool.effect !== (definition.readOnlyTools.includes(tool.mcpName) ? "read" : "write")
          || !["publishable", "refused_by_policy", "unsupported_schema"].includes(String(tool.state))) return broken();
        const manifest = tool.manifest === null ? null : checkManifest(tool.manifest);
        let argumentNames: Record<string, string> | null = null;
        if (tool.argumentNames !== null) {
          if (typeof tool.argumentNames !== "object" || Array.isArray(tool.argumentNames)) return broken();
          argumentNames = tool.argumentNames as Record<string, string>;
          if (Object.values(argumentNames).some(value => typeof value !== "string")) return broken();
        }
        if (tool.state === "publishable") {
          if (!manifest || !argumentNames || manifest.name !== tool.id || manifest.toolkit !== mcpToolkit(id)
            || manifest.upstreamHost !== mcpLogicalHost(id) || manifest.upstreamSlug !== (tool.id as string).slice(`mcp.${id}.`.length) || manifest.effect !== tool.effect || manifest.description.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 1024) !== tool.description
            || !/^[0-9a-f]{32}$/.test(manifest.version) || manifest.destinationArgument !== null || manifest.destinationOrigins !== null
            || Object.keys(argumentNames).sort().join(",") !== Object.keys(manifest.nativeInputSchema?.properties ?? manifest.inputSchema.properties).sort().join(",")
            || new Set(Object.values(argumentNames)).size !== Object.values(argumentNames).length) return broken();
          publishable.add(manifest.name);
        } else if (manifest !== null || argumentNames !== null) return broken();
        return { mcpName: tool.mcpName, status: tool.state as McpToolPlan["status"], manifest, argumentNames, reason: null, upstreamHints: null };
      });
      new McpToolCatalog(id, plans);
      selected.set(id, publishable);
    }
    for (const row of all(db, "SELECT * FROM selections")) {
      const id = String(row.server_id), names = strings(JSON.parse(String(row.tools)));
      if (!servers.has(id) || !one(hub, "SELECT id FROM bots WHERE id = ?", String(row.bot_id))
        || names.some(name => !selected.get(id)?.has(name))) return broken();
    }
    let setupReceipts: number | undefined;
    if (schema === "native-mcp-v2" || schema === "native-mcp-v3") {
      validateMcpSetupReceipts(db); // Closed row, UTF8 size, checksum, native request envelope, cap and unique IDs/generations.
      setupReceipts = count(db, "SELECT COUNT(*) AS n FROM setup_receipts");
      if (setupReceipts > NATIVE_MCP_RECEIPT_LIMIT) broken();
      const liveGenerations = new Map<string, string>();
      for (const row of all(db, "SELECT key,value FROM meta WHERE key GLOB 'mcp-instance:*'")) {
        const generation = String(row.value), id = String(row.key).slice("mcp-instance:".length);
        if (liveGenerations.has(generation)) broken();
        liveGenerations.set(generation, id);
      }
      for (const row of all(db, "SELECT * FROM setup_receipts")) {
        const receipt = readMcpSetupReceiptRow(row);
        const liveID = liveGenerations.get(receipt.generation);
        // Removed/replaced history is valid. A generation that IS live cannot attach to another instance/definition.
        if (liveID !== undefined && (liveID !== receipt.instanceId || mcpSetupHash(servers.get(liveID)) !== receipt.definitionPin)) broken();
      }
    }
    let instanceSelectionCounts: {instanceSelectionHeads:number;instanceSelectionReceipts:number}|undefined;
    if(schema === "native-mcp-v3") {
      validateMcpInstanceSelectionRows(db);
      for(const row of all(db,"SELECT * FROM instance_selection_receipts")) {
        const j=readMcpInstanceSelectionRow(row),action=one(hub,"SELECT * FROM actions WHERE id=?",j.actionId);
        const origin=one(hub,"SELECT * FROM tool_action_continuations WHERE action_id=?",j.actionId);
        const turn=origin?one(hub,"SELECT * FROM turns WHERE id=?",String(origin.origin_turn_id)):null;
        const authorization=one(hub,"SELECT * FROM action_authorizations WHERE action_id=?",j.actionId);
        // Historical connection IDs are opaque audit references, not live credentials or current authority.
        if(!action || action.request_hash!==j.hubRequestHash || action.bot_id!==j.botId || action.tool!=="dexter.harness.mcp.select_instances"
          || action.decided_by!==identity.ownerId || authorization?.source!=="exact_owner" || authorization.owner_id!==identity.ownerId
          || !origin || origin.profile_id!==j.profileId || !turn || turn.bot_id!==j.botId || turn.thread_id!==action.thread_id
          || j.originHash!==mcpSetupHash({installationId:identity.installationId,ownerId:identity.ownerId,botId:j.botId,profileId:j.profileId,
            threadId:String(action.thread_id),turnId:String(origin.origin_turn_id),callId:String(origin.call_id),actionId:j.actionId})
          || mcpSetupHash(JSON.parse(String(action.request)).arguments?.input?.selectionPlan)!==mcpSetupHash(j.plan))broken();
      }
      instanceSelectionCounts={instanceSelectionHeads:count(db,"SELECT COUNT(*) AS n FROM instance_selection_heads"),instanceSelectionReceipts:count(db,"SELECT COUNT(*) AS n FROM instance_selection_receipts")};
    }
    if (count(db, "SELECT COUNT(*) AS n FROM connections") !== 0) broken();
    if (count(hub, "SELECT COUNT(*) AS n FROM grants WHERE tool GLOB 'mcp.*' AND policy <> 'deny'") !== 0) broken();
    return { servers: servers.size, catalogs: selected.size, selections: count(db, "SELECT COUNT(*) AS n FROM selections"), connections: 0, ...(setupReceipts === undefined ? {} : { setupReceipts }), ...instanceSelectionCounts };
  } catch (error) {
    if (error instanceof OperationsError) throw error;
    return broken();
  }
}

/** Sanitize copies only: gateway account IDs are not exported and native grants require fresh owner selection. */
export function sanitizeNativeMcp(path: string, hubPath: string): void {
  const db = new DatabaseSync(path);
  try {
    checkFullSchema(db, "nativeMcp");
    sanitizeNativeMcpMetadata(db);
    db.exec("PRAGMA journal_mode = DELETE; PRAGMA secure_delete = ON; DELETE FROM connections; VACUUM;");
  } finally { db.close(); }
  const hub = new DatabaseSync(hubPath);
  try {
    checkFullSchema(hub, "hub");
    hub.exec("PRAGMA secure_delete = ON; UPDATE grants SET policy='deny', revision=revision+1 WHERE tool GLOB 'mcp.*' AND policy <> 'deny';");
    if(Number(hub.prepare("PRAGMA user_version").get()!.user_version)>=12)
      hub.exec("DELETE FROM proposal_only_grants WHERE tool GLOB 'mcp.*';");
    hub.exec("VACUUM;");
  } finally { hub.close(); }
}
