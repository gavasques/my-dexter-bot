// Node synthetic helper transport only. Production NativeDeviceClient is unchanged.
// Exact owned executable registry; FD3 private material never enters argv/env/script/files.
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import type { Writable } from "node:stream";
import type { TlsIdentity } from "@dexter/devices";
const original = childProcess.spawn;
const identities = new Map<string, () => Pick<TlsIdentity, "certPem" | "keyPem" | "fingerprint">>();
export function nativeMemorySpawn(executable: string, identity: () => Pick<TlsIdentity, "certPem" | "keyPem" | "fingerprint">): () => void {
  if (identities.has(executable)) throw Error("duplicate memory helper");
  if (!identities.size) {
    childProcess.spawn = ((command: string, args: string[], options: Record<string, unknown>) => {
      const source = identities.get(command);
      if (!source) return Reflect.apply(original, childProcess, [command, args, options]);
      if (options.stdio !== "pipe") throw Error("unexpected memory helper transport");
      const child = original(command, args, { ...options, stdio: ["pipe", "pipe", "pipe", "pipe"] });
      const id = source(); const bytes = Buffer.from(JSON.stringify({ cert: id.certPem, key: id.keyPem }));
      if (bytes.length > 16384) { bytes.fill(0); child.kill(); throw Error("memory helper bound"); }
      const pipe = child.stdio[3] as Writable; pipe.on("error", () => {});
      pipe.end(bytes, () => bytes.fill(0)); return child;
    }) as typeof childProcess.spawn;
    syncBuiltinESMExports();
  }
  identities.set(executable, identity);
  return () => { identities.delete(executable); if (!identities.size) { childProcess.spawn = original; syncBuiltinESMExports(); } };
}
