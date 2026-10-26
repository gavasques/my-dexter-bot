/**
 * External process for durability tests. Modes:
 *   crash <dataDir> <actionId> <effectFile>   dispatch; the executor records one effect and is SIGKILLed
 *   exit <dataDir> <actionId> <effectFile>    dispatch; the executor records one effect and exits without closing
 *   hold <dataDir>                            hold the host lease until killed; prints "ready"
 *   try-open <dataDir>                        try to open the store; prints "opened" or the HostError code
 */
import { appendFileSync, closeSync, fsyncSync, openSync } from "node:fs";
import { dispatchAction, HostError, HostStore } from "@dexter/hub";

const [mode, dataDir, actionId, effectFile] = process.argv.slice(2);
if (!mode || !dataDir) throw new Error("usage: crash-worker <mode> <dataDir> [actionId effectFile]");

function recordEffect(): void {
  appendFileSync(effectFile!, "effect\n");
  const fd = openSync(effectFile!, "r");
  fsyncSync(fd);
  closeSync(fd);
}

if (mode === "try-open") {
  try {
    new HostStore({ dataDir }).close();
    process.stdout.write("opened\n");
  } catch (error) {
    process.stdout.write(`${error instanceof HostError ? error.code : "error"}\n`);
  }
} else if (mode === "hold") {
  new HostStore({ dataDir });
  setInterval(() => {}, 1_000);
  process.stdout.write("ready\n");
} else if (mode === "crash" || mode === "exit") {
  const store = new HostStore({ dataDir });
  await dispatchAction(store, actionId!, async () => {
    recordEffect();
    if (mode === "crash") process.kill(process.pid, "SIGKILL");
    process.exit(3);
  });
  throw new Error("unreachable: executor must not return");
} else {
  throw new Error(`unknown mode ${mode}`);
}
