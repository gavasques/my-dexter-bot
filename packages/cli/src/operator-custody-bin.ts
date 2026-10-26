#!/usr/bin/env node
import { createHash, X509Certificate } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { TlsIdentity } from "@dexter/devices";
import { OperatorSealedCustody, readOperatorPrivateFd, SealedCustodyError, type CustodyBinding } from "./operator-sealed-custody.js";
import { runOperatorSealedOperations } from "./operator-sealed-host.js";

/** Deliberately dedicated executable; never loaded by engine/HTTP/MCP. All secret bytes arrive on inherited FDs. */
export async function runOperatorCustodyCli(argv: readonly string[], write: (line: string) => void): Promise<number> {
  let custody: OperatorSealedCustody | undefined;
  const owned: Buffer[] = [];
  try {
    const command = argv[0], split = argv.indexOf("--"), publicArgs = split < 0 ? argv.slice(1) : argv.slice(1, split);
    const flags = new Map<string, string>();
    for (let i = 0; i < publicArgs.length; i += 2) {
      const k = publicArgs[i], v = publicArgs[i + 1];
      if (!k || !v || !["--file", "--installation", "--owner", "--device", "--generation", "--key-id", "--password-fd", "--tls-fd", "--destination", "--new-password-fd"].includes(k) || flags.has(k)) throw new SealedCustodyError("invalid_input");
      flags.set(k, v);
    }
    const get = (key: string) => { const v = flags.get(key); if (!v) throw new SealedCustodyError("invalid_input"); return v; };
    const fd = (key: string, max = 1024) => { const text = get(key); if (!/^[0-9]{1,8}$/.test(text)) throw new SealedCustodyError("invalid_input"); const b = readOperatorPrivateFd(Number(text), max); owned.push(b); return b; };
    const b: CustodyBinding = { installationId: get("--installation"), ownerId: get("--owner"), deviceId: get("--device"), generation: Number(get("--generation")), keyId: get("--key-id") };
    const path = get("--file");
    if (command === "create") {
      if (split >= 0 || flags.has("--destination") || flags.has("--new-password-fd")) throw new SealedCustodyError("invalid_input");
      const tls = JSON.parse(fd("--tls-fd", 49152).toString("utf8")) as unknown;
      if (!tls || typeof tls !== "object" || Array.isArray(tls) || Object.keys(tls).sort().join(",") !== "certPem,keyPem") throw new SealedCustodyError("invalid_input");
      const { certPem, keyPem } = tls as { certPem: unknown; keyPem: unknown };
      if (typeof certPem !== "string" || typeof keyPem !== "string") throw new SealedCustodyError("invalid_input");
      const cert = new X509Certificate(certPem);
      custody = OperatorSealedCustody.create(path, b, fd("--password-fd"), new TlsIdentity(certPem, keyPem, createHash("sha256").update(cert.raw).digest("hex")));
      write(JSON.stringify(custody)); return 0;
    }
    if (flags.has("--tls-fd") || !["unlock-check", "export-sealed", "ops"].includes(command ?? "")) throw new SealedCustodyError("invalid_input");
    if (command !== "export-sealed" && (flags.has("--destination") || flags.has("--new-password-fd"))) throw new SealedCustodyError("invalid_input");
    if (command !== "ops" && split >= 0) throw new SealedCustodyError("invalid_input");
    custody = new OperatorSealedCustody(path, b); custody.unlock(fd("--password-fd"));
    if (command === "export-sealed") custody.exportSealed(get("--destination"), fd("--new-password-fd"));
    if (command === "ops") {
      if (split < 0) throw new SealedCustodyError("invalid_input");
      return await runOperatorSealedOperations(custody, argv.slice(split + 1), { write });
    }
    write(JSON.stringify(custody)); return 0;
  } catch (error) {
    write(JSON.stringify({ error: error instanceof SealedCustodyError ? error.code : "unavailable" })); return 1;
  } finally { owned.forEach(b => b.fill(0)); await custody?.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) process.exitCode = await runOperatorCustodyCli(process.argv.slice(2), line => process.stdout.write(`${line}\n`));
