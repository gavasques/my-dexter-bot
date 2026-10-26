import { types } from "node:util";
import { type Grant } from "@dexter/contracts";
import { HostError, type HostStore } from "@dexter/hub";
import { type HostGrantPort } from "@dexter/hub/http";
import { DEVICE_OPERATIONS } from "@dexter/devices";
import { type DeviceServices } from "./device-services.js";

const KEYS = ["botId", "tool", "destination", "policy", "expiresAt", "expectedRevision"];
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const invalid = (): never => { throw new HostError("invalid_input", "Invalid device grant request."); };
function request(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || types.isProxy(input) || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input), keys = Reflect.ownKeys(descriptors);
  if (keys.length !== KEYS.length || keys.some(key => typeof key !== "string" || !KEYS.includes(key) || !("value" in descriptors[key]!))) return invalid();
  const value = Object.fromEntries(KEYS.map(key => [key, descriptors[key]!.value]));
  for (const key of ["botId", "tool", "destination"]) if (typeof value[key] !== "string" || !ID.test(value[key])) invalid();
  if (value.expectedRevision !== null && (typeof value.expectedRevision !== "number" || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 1)) invalid();
  if (!["allow", "ask", "deny"].includes(value.policy as string)) invalid();
  if (value.expiresAt !== null && (typeof value.expiresAt !== "number" || !Number.isSafeInteger(value.expiresAt) || value.expiresAt < 1)) invalid();
  return value;
}
/** Same canonical list/CAS semantics as AppClientServices.grants, without constructing its TLS listener.
 * Only the agent registry's current active pin qualifies a destination: app-client keys never appear in it.
 * Source resolves admission per operation. No grants at construction, no await between CAS and fenced write.
 */
export function localDeviceGrantPort(store: HostStore, source: () => Pick<DeviceServices, "admin" | "tools">): Readonly<HostGrantPort> {
  return Object.freeze({
    list: (botId: string) => {
      if (typeof botId !== "string" || !ID.test(botId)) return invalid();
      const devices = source(); store.getBot(botId);
      const items: { botId: string; tool: string; destination: string; grant: Grant | null }[] = [];
      for (const device of store.listDevices()) {
        if (device.revokedAt !== null || devices.tools.snapshot(device.id)?.status !== "active") continue;
        for (const tool of device.capabilities) if (DEVICE_OPERATIONS.has(tool)) {
          items.push({ botId, tool, destination: device.id, grant: store.getGrant(botId, tool, device.id) });
        }
      }
      return { botId, items };
    },
    put: (input: unknown) => {
      const value = request(input), devices = source();
      const botId = value.botId as string, tool = value.tool as string, destination = value.destination as string;
      store.getBot(botId);
      const current = store.getGrant(botId, tool, destination);
      if ((current?.revision ?? null) !== value.expectedRevision) throw new HostError("conflict", "Grant revision changed.");
      // DeviceServices owns the final pin/capability/operation and canonical writer checks.
      return devices.admin.grant({ botId, tool, destination, policy: value.policy, expiresAt: value.expiresAt });
    },
  });
}
