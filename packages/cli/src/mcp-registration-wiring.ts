import { createHash } from "node:crypto";
import { McpConnectorError, checkMcpDefinition, mcpSetupHash, mcpSetupCanonicalJSON, mcpSetupOriginHash,
  mcpSetupRequestHash, mcpSetupInstancePin, type NativeMcpAdmin } from "@dexter/connectors";
import type { McpRegistrationAuthority, McpRegistrationReceipt } from "@dexter/contracts";
import { HostError, type HostStore } from "@dexter/hub";

const TOOLS = new Set(["dexter.harness.mcp.add", "dexter.harness.mcp.add_http"]);
const DESTINATION = "dexter-harness-owner-proposals";
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HostError("invalid_input", "Invalid MCP registration receipt binding.");
  return value as Record<string, unknown>;
};
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

/** All identity comes from the canonical action/turn binding. No request JSON can select a different origin. */
export function mcpRegistrationAction(store: HostStore, actionId: string, recovery = false) {
  store.assertActiveWriter();
  const action = store.getAction(actionId);
  if (!TOOLS.has(action.request.tool) || action.request.destination !== DESTINATION || action.decidedBy !== store.ownerId
    || (recovery ? !["unknown", "succeeded"].includes(action.state) : action.state !== "running"))
    throw new HostError("forbidden", "No approved MCP registration action.");
  const origin = store.toolActionOrigin(actionId);
  if (!origin) throw new HostError("forbidden", "MCP registration origin is unavailable.");
  if (!recovery) store.ownerToolScope(actionId); // Stop, lease, authority and live authorization remain fenced.
  const input = object(action.request.arguments.input);
  // Legacy actions had no native effect receipt contract. Do not manufacture one by calling registration.
  if (typeof input.registrationDefinitionJson !== "string" || typeof input.registrationInputJson !== "string") {
    if (recovery) return { action, binding: null };
    throw new HostError("conflict", "Legacy MCP proposal needs a new exact approval.");
  }
  if (action.authorization?.source !== "exact_owner") throw new HostError("forbidden", "MCP registration requires exact owner approval.");
  const original = object(JSON.parse(input.registrationDefinitionJson));
  if (Object.hasOwn(original, "source")) throw new HostError("invalid_input", "Registration source is host-owned.");
  const normalized = checkMcpDefinition(original);
  const approved = checkMcpDefinition(JSON.parse(String(input.definitionJson)));
  const inputHash = mcpSetupHash(original), definitionPin = mcpSetupHash(normalized);
  const registrationInputHash = mcpSetupHash(JSON.parse(input.registrationInputJson));
  const pin = object(action.request.arguments.pin);
  if (definitionPin !== mcpSetupHash(approved) || mcpSetupCanonicalJSON(original) !== input.registrationDefinitionJson
    || pin.definitionHash !== sha(String(input.definitionJson)) || pin.registrationInputHash !== registrationInputHash || pin.inputHash !== inputHash)
    throw new HostError("conflict", "MCP registration input pins changed.");
  const authority: McpRegistrationAuthority = { installationId: store.hostId, ownerId: store.ownerId,
    origin: { kind: "harness_action", botId: action.request.botId, threadId: action.request.threadId,
      turnId: origin.turnId, actionId: action.id, callId: origin.callId } };
  const requestId = `action:${action.id}`;
  return { action, binding: { request: { requestId, expectedInstancePin: null, definition: original }, authority,
    definitionPin, inputHash, registrationInputHash, originHash: mcpSetupOriginHash(authority, { hostId: store.hostId, ownerId: store.ownerId }),
    requestHash: mcpSetupRequestHash(definitionPin, inputHash) } };
}
export function validateMcpActionReceipt(receipt: McpRegistrationReceipt, binding: NonNullable<ReturnType<typeof mcpRegistrationAction>["binding"]>): void {
  const requestIdHash = mcpSetupHash({ requestId: binding.request.requestId });
  const requestKeyHash = mcpSetupHash({ operation: "mcp.register", originHash: binding.originHash, requestIdHash });
  if (receipt.requestIdHash !== requestIdHash || receipt.requestKeyHash !== requestKeyHash || receipt.originHash !== binding.originHash
    || receipt.definitionPin !== binding.definitionPin || receipt.inputHash !== binding.inputHash || receipt.requestHash !== binding.requestHash
    || receipt.instanceId !== object(binding.request.definition).id || receipt.instancePin !== mcpSetupInstancePin(binding.definitionPin, receipt.generation))
    throw new HostError("conflict", "Native MCP effect receipt does not match its original action.");
}
/** Query only. The unknown Hub outcome remains unknown; a found effect receipt is not new dispatch authority. */
export function recoverMcpRegistration(store: HostStore, admin: Readonly<NativeMcpAdmin>, actionId: string) {
  const { action, binding } = mcpRegistrationAction(store, actionId, true);
  if (!binding) return { actionId: action.id, hubRequestHash: action.requestHash, dispatcherState: action.state,
    registration: null, legacyReceiptUnavailable: true, replayed: false };
  const registration = admin.registrationReceipt({ requestId: binding.request.requestId }, binding.authority);
  if (registration) validateMcpActionReceipt(registration.receipt, binding);
  return { actionId: action.id, hubRequestHash: action.requestHash, dispatcherState: action.state,
    registration, registrationInputHash: binding.registrationInputHash, legacyReceiptUnavailable: false, replayed: false };
}
/** Trusted owner-loopback identity, resolved for every request; no body authority is admitted. */
export const ownerMcpRegistrationAuthority = (store: HostStore): McpRegistrationAuthority => {
  store.assertActiveWriter();
  return { installationId: store.hostId, ownerId: store.ownerId, origin: { kind: "owner_local" } };
};
/** Fixed codes only, never imported/upstream/parser text. */
export function guardedMcpRegistration<Value>(operation: () => Value, mutation = false): Value {
  try { return operation(); } catch (error) {
    if (error instanceof HostError) throw error;
    if (error instanceof McpConnectorError) {
      const invalid = ["invalid_request", "invalid_definition", "secret_refused", "endpoint_invalid", "endpoint_secret_refused"].includes(error.code);
      throw new HostError(error.code === "scope_mismatch" ? "forbidden" : invalid ? "invalid_input" : "conflict", `Native MCP registration refused: ${error.code}.`);
    }
    throw new HostError(mutation ? "outcome_unknown" : "conflict", "Native MCP registration outcome is unconfirmed; read its receipt before any retry.");
  }
}
