// Test-only CLI probe: records the order of frozen RelayStore.close and RelayService.close calls inside the real
// CLI process and can deliver the stop signal synchronously after runCli started (i.e. during its first
// asynchronous startup await). The recorded events are written on exit to the file named by argv.
import { writeFileSync } from "node:fs";
import { RelayStore } from "@dexter/relay";
import { RelayService } from "../../packages/relay-service/src/server.js";
import { runCli } from "../../packages/relay-service/src/cli.js";

const [mode, eventsFile, ...args] = process.argv.slice(2);
const events: string[] = [];
const storeClose = RelayStore.prototype.close;
RelayStore.prototype.close = function (this: RelayStore): void { events.push("store-close"); storeClose.call(this); };
const serviceClose = RelayService.prototype.close;
RelayService.prototype.close = function (this: RelayService): Promise<void> {
  events.push("service-close-begin");
  return serviceClose.call(this).finally(() => { events.push("service-close-end"); });
};
process.on("exit", () => writeFileSync(eventsFile!, events.join(",")));
void runCli(args);
if (mode === "startup-signal") process.emit("SIGTERM", "SIGTERM");
