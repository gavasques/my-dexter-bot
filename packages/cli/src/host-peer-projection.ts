import { inspect } from "node:util";
import { RenameDeviceSchema, type Action, type DeviceView } from "@dexter/contracts";
import { HostError, type HostStore } from "@dexter/hub";
import type { HostDevicePort, HostPeerPort, HostPeerView } from "@dexter/hub/http";
import { DeviceError, type ClientPairingRegistry } from "@dexter/devices";

/** The app-client side of the projection: its registry and the live listener that owns its sockets/presence. */
export interface ClientPeerSource {
  registry: ClientPairingRegistry;
  authenticatedPresence(deviceId: string): "online" | "stale" | "revoked";
  dropFingerprints(fingerprints: Iterable<string>): void;
}

function mapped(error: unknown): never {
  if (error instanceof HostError) throw error;
  if (error instanceof Error && error.name === "ZodError") throw new HostError("invalid_input", "Device request does not match the contract.");
  if (error instanceof DeviceError) {
    const code = error.code === "not_found" ? "not_found" : error.code === "forbidden" ? "forbidden"
      : error.code === "invalid_input" ? "invalid_input" : error.code === "unavailable" ? "device_unavailable" : "conflict";
    throw new HostError(code, "Device operation could not be completed.");
  }
  throw new HostError("conflict", "Device operation could not be completed.");
}

/**
 * Unified, owner-scoped projection of every canonical HostStore device. `paired`, `presence` and `role` come from
 * the registry that owns the device's binding: app clients from the ClientPairingRegistry (presence = last
 * authenticated foreground contact on the app listener), agent Macs from the Mac agent port. A platform or a
 * name never selects a role. Revocation is canonical first and then reaches the owning registry and sockets;
 * if the auxiliary step fails the canonical revocation still denies every later request.
 *
 * The DeviceTurnSurface keeps using only the agent-mac port; this projection is for HTTP and administration.
 */
export class HostPeerProjection implements HostPeerPort {
  /** Local development `HostDevicePort` shape (no role), so the loopback app keeps its contract. */
  readonly http: Readonly<HostDevicePort>;
  readonly #store: HostStore;
  readonly #clients: ClientPeerSource | undefined;
  readonly #agent: Readonly<HostDevicePort> | undefined;
  #stopped = false;

  constructor(store: HostStore, sources: { clients?: ClientPeerSource; agent?: Readonly<HostDevicePort> }) {
    this.#store = store;
    this.#clients = sources.clients;
    this.#agent = sources.agent;
    const strip = ({ role: _role, ...view }: HostPeerView): DeviceView => view;
    this.http = Object.freeze({
      list: () => this.list().map(strip),
      get: (id: string) => strip(this.get(id)),
      rename: (id: string, input: unknown) => strip(this.rename(id, input)),
      revoke: (id: string) => strip(this.revoke(id)),
      dispatch: (actionId: string): Promise<Action> => {
        this.#assertOpen();
        if (!this.#agent) return Promise.reject(new HostError("device_unavailable", "Device dispatch is not configured."));
        return this.#agent.dispatch(actionId);
      },
      status: () => { this.#assertOpen(); return this.#agent?.status() ?? { listening: false, pendingDispatches: 0 }; },
    });
  }

  list(): HostPeerView[] {
    return this.#call(() => this.#store.listDevices().map((device) => this.#view(device.id)));
  }
  get(id: string): HostPeerView { return this.#call(() => this.#view(id)); }
  /** Label only: never changes role, capabilities, pins, scopes or grants. */
  rename(id: string, input: unknown): HostPeerView {
    return this.#call(() => {
      const parsed = RenameDeviceSchema.parse(input);
      this.#store.renameDevice(id, parsed);
      return this.#view(id);
    });
  }
  revoke(id: string): HostPeerView {
    return this.#call(() => {
      const clients = this.#clients;
      if (clients && clients.registry.isClientDevice(id)) {
        const fingerprints = clients.registry.listCertificates(id).map((cert) => cert.fingerprint);
        try { clients.registry.revokeDevice(id); } finally { clients.dropFingerprints(fingerprints); }
      } else if (this.#agent) {
        this.#agent.revoke(id);
      } else {
        this.#store.revokeDevice(id);
      }
      return this.#view(id);
    });
  }
  /** Role of one canonical device for trusted composition (e.g. refusing client destinations for grants). */
  isClientDevice(id: string): boolean {
    this.#assertOpen();
    return this.#clients?.registry.isClientDevice(id) ?? false;
  }
  toJSON(): object { return { devices: "projection" }; }
  [inspect.custom](): object { return this.toJSON(); }

  #view(id: string): HostPeerView {
    const clients = this.#clients;
    if (clients && clients.registry.isClientDevice(id)) {
      const device = this.#store.getDevice(id);
      const binding = clients.registry.binding(id);
      if (!binding) throw new HostError("conflict", "Client binding is inconsistent.");
      const paired = binding.status === "active" && device.revokedAt === null;
      return { ...device, paired, presence: paired ? clients.authenticatedPresence(id) : "revoked", role: binding.role };
    }
    if (this.#agent) {
      const view = this.#agent.get(id);
      return { ...view, role: view.paired ? "agent-mac" : "unpaired" };
    }
    const device = this.#store.getDevice(id);
    return { ...device, presence: this.#store.devicePresence(id), paired: false, role: "unpaired" };
  }
  stopAdmission(): void { this.#stopped = true; }
  #assertOpen(): void {
    if (this.#stopped) throw new HostError("conflict", "App client projection is closing.");
  }
  #call<T>(fn: () => T): T {
    this.#assertOpen();
    try { return fn(); } catch (error) { return mapped(error); }
  }
}
