import { HostError, type HostStore } from "@dexter/hub";
import { GatewayError } from "@dexter/gateway";
import type { HostDeviceRoutePort } from "@dexter/hub/http";
import type { DeviceRouteAdmin } from "./device-turn-surface.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
/** Owner-loopback only. Never attach to a paired-client router or an engine surface. */
export function localDeviceRoutePort(store: HostStore, source: () => Readonly<DeviceRouteAdmin>): Readonly<HostDeviceRoutePort> {
  function run<T>(operation: () => T): T {
    try { return operation(); }
    catch (error) {
      if (error instanceof HostError) throw error;
      if (error instanceof GatewayError) {
        const code = error.code === "unavailable" ? "device_unavailable" : ["unauthorized","meta_tool_refused"].includes(error.code) ? "forbidden" : error.code as "invalid_input" | "forbidden" | "not_found" | "conflict";
        throw new HostError(code, "Device route request was refused.");
      }
      throw new HostError("device_unavailable", "Device routes are unavailable.");
    }
  }
  return Object.freeze({
    list: (botId: string) => run(() => {
      const admin = source();
      if (typeof botId !== "string" || !ID.test(botId)) throw new HostError("invalid_input", "Invalid bot ID.");
      store.getBot(botId); return { botId,routes:admin.listRoutes(botId) };
    }),
    patch: (input: unknown) => run(() => source().patchRoute(input)),
    receipt: (id: string) => run(() => {
      const receipt = source().routeReceipt(id);
      if (!receipt) throw new HostError("not_found", "Device route receipt was not found.");
      return receipt;
    }),
  });
}
