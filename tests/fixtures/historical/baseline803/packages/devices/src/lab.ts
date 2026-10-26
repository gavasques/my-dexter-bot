import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DeviceError } from "./errors.js";
import { privateDirectory, type TlsIdentity } from "./files.js";
import { createLabTlsIdentity } from "./lab-pki.js";
/** LAB ONLY: persists only the PUBLIC certificate. Production loadIdentity remains strict.
 * Callers must retain/inject the returned memory identity; no private-key file is created. */
export function generateSyntheticIdentity(dir: string, label: string): TlsIdentity {
  if (typeof label !== "string" || !/^[a-z0-9-]{1,32}$/.test(label)) throw new DeviceError("invalid_input", "invalid label");
  const identity = createLabTlsIdentity({ profile: "device", name: `dexter-synthetic-${label}` }).identity;
  privateDirectory(dir);
  writeFileSync(join(dir, "cert.pem"), identity.certPem, { mode: 0o600, flag: "wx" });
  return identity;
}
