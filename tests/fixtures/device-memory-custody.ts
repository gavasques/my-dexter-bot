// TEST ONLY seam. No key.pem file exists. The production metadata guards execute against
// the actual PUBLIC cert file; private read returns memory bytes. This proves guard logic
// and key/cert binding, NOT physical private-key custody. Default production stays unchanged.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { TlsIdentity } from "@dexter/devices";
import type { TestContext } from "node:test";
type MemoryIdentity = Pick<TlsIdentity, "certPem" | "keyPem" | "fingerprint">;
const entries = new Map<string, MemoryIdentity>();
const mutable = fs as unknown as {lstatSync: typeof fs.lstatSync; readFileSync: typeof fs.readFileSync};
const originalStat = fs.lstatSync, originalRead = fs.readFileSync;
function pathKey(path: unknown): string | undefined { return typeof path === "string" ? resolve(path) : undefined; }
export function memoryCustody(dir: string, identity: MemoryIdentity, t?: TestContext): () => void {
  const key = resolve(dir, "key.pem"); if (entries.has(key)) throw Error("duplicate memory custody");
  if (!entries.size) {
    mutable.lstatSync = ((path: unknown, ...rest: unknown[]) => {
      const k = pathKey(path); return Reflect.apply(originalStat, fs, [k && entries.has(k) ? join(k, "..", "cert.pem") : path, ...rest]);
    }) as typeof fs.lstatSync;
    mutable.readFileSync = ((path: unknown, ...rest: unknown[]) => {
      const id = entries.get(pathKey(path) ?? "");
      if (!id) return Reflect.apply(originalRead, fs, [path, ...rest]);
      return rest[0] === "utf8" ? id.keyPem : Buffer.from(id.keyPem);
    }) as typeof fs.readFileSync;
    syncBuiltinESMExports();
  }
  entries.set(key, identity);
  let closed = false;
  const close = () => { if (closed) return; closed = true; entries.delete(key); if (!entries.size) { mutable.lstatSync = originalStat; mutable.readFileSync = originalRead; syncBuiltinESMExports(); } };
  t?.after(close); return close;
}
export function replaceMemoryKey(dir: string, identity: MemoryIdentity): void {
  const key = resolve(dir, "key.pem"); if (!entries.has(key)) throw Error("missing memory custody"); entries.set(key, identity);
}
export { receiveMemoryIdentity } from "./memory-identity-channel.js";
