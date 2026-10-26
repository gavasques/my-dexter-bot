import { CONNECTIONS_CAPABILITY_FRAME_SCHEMA, CONNECTIONS_CAPABILITY_PATTERN, type ConnectionsConfigurationStatus } from "@dexter/contracts";
import type { ConnectionsCustodyView } from "./connections-configuration.js";

/**
 * In-memory custody of the connections service capability inside the host process (the secret behind
 * `credentialRef`). Filled only by the app-owned private pipe (`dexter.connections-capability/1` frames on the
 * inherited stdin FIFO); never HTTP, argv, environment, a file, a receipt or a log. It accepts the capability only
 * for the exact origin + credential generation the running service was composed with (`scope`); without a composed
 * service (`scope` null) every `set` is refused. A request id is settled once: a repeat returns the recorded outcome
 * without a second effect. Only fixed acknowledgements (and the last settled request, without data) leave here.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SEEN = 64;
type Outcome = "ready" | "locked" | "refused";
type PrivateRequest = NonNullable<ConnectionsConfigurationStatus["privateRequest"]>;

export interface ConnectionsCapabilityPrivateInput {
  /** One parsed private frame (already bounded, schema checked by the pipe reader). Returns the fixed acknowledgement. */
  frame(value: Record<string, unknown>): Outcome;
}

export class ConnectionsCapabilityVault implements ConnectionsCapabilityPrivateInput, ConnectionsCustodyView {
  readonly #scope: Readonly<{ origin: string; generation: number }> | null;
  #hostID: string | null = null;
  #capability: string | null = null;
  #state: "absent" | "ready" | "locked" = "absent";
  #last: PrivateRequest | null = null;
  readonly #seen = new Map<string, Outcome>();
  #closed = false;

  constructor(scope: { origin: string; generation: number } | null) {
    this.#scope = scope ? Object.freeze({ origin: scope.origin, generation: scope.generation }) : null;
  }
  get scope(): Readonly<{ origin: string; generation: number }> | null { return this.#scope; }
  /** Binds the exact host identity once (after the canonical store exists); frames for another host are refused. */
  arm(hostID: string): void {
    if (this.#hostID !== null || typeof hostID !== "string" || hostID.length < 1 || hostID.length > 128) throw new Error("connections custody: refused");
    this.#hostID = hostID;
  }
  /** Provider capability (called per request by the service client). Absent/locked → throws ("credential unavailable"). */
  capability(): string {
    if (this.#closed || this.#state !== "ready" || this.#capability === null) throw new Error("connections custody: unavailable");
    return this.#capability;
  }
  status(): { state: "absent" | "ready" | "locked"; generation: number | null } {
    return { state: this.#state, generation: this.#state === "ready" ? this.#scope?.generation ?? null : null };
  }
  lastRequest(): PrivateRequest | null { return this.#last ? { ...this.#last } : null; }

  frame(value: Record<string, unknown>): Outcome {
    const requestId = value.requestId;
    if (typeof requestId !== "string" || !UUID.test(requestId)) return "refused";
    const seen = this.#seen.get(requestId);
    if (seen) return seen;
    const operation = value.operation, generation = value.generation;
    const keys = operation === "set" ? "capability,generation,hostID,operation,origin,requestId,schema" : "generation,hostID,operation,origin,requestId,schema";
    let outcome: Outcome = "refused";
    if (!this.#closed && this.#hostID !== null && value.schema === CONNECTIONS_CAPABILITY_FRAME_SCHEMA && Object.keys(value).sort().join(",") === keys
      && value.hostID === this.#hostID && (operation === "set" || operation === "lock") && typeof generation === "number" && Number.isSafeInteger(generation)
      && generation >= 0 && this.#scope !== null && value.origin === this.#scope.origin && generation === this.#scope.generation) {
      if (operation === "lock") { this.#capability = null; this.#state = "locked"; outcome = "locked"; }
      else if (typeof value.capability === "string" && CONNECTIONS_CAPABILITY_PATTERN.test(value.capability)) {
        this.#capability = value.capability; this.#state = "ready"; outcome = "ready";
      }
    }
    if (this.#seen.size >= SEEN) this.#seen.delete(this.#seen.keys().next().value!);
    this.#seen.set(requestId, outcome);
    this.#last = { requestId, operation: operation === "lock" ? "lock" : "set",
      generation: typeof generation === "number" && Number.isSafeInteger(generation) && generation >= 0 ? generation : 0, state: outcome };
    return outcome;
  }

  close(): void { this.#closed = true; this.#capability = null; if (this.#state === "ready") this.#state = "locked"; }
}
