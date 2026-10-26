import { createHash, generateKeyPairSync, randomBytes, sign, X509Certificate } from "node:crypto";
import { isAbsolute } from "node:path";
import { HostError, type HostStore } from "@dexter/hub";
import { TlsIdentity } from "@dexter/devices";
import { validateAppClientServicesOptions, type AppClientServicesOptions } from "./app-client-services.js";
import { OperatorSealedCustody, SealedCustodyError, type CustodyBinding } from "./operator-sealed-custody.js";

/** This product path advertises only a concrete address in the installed private Tailscale interface. */
export function isTailscaleIPv4(address: unknown): address is string {
  if (typeof address !== "string" || !/^100\.(?:[0-9]{1,3}\.)[0-9]{1,3}\.[0-9]{1,3}$/.test(address)) return false;
  const p = address.split(".").map(Number);
  return p.length === 4 && p.every((n,i)=>Number.isInteger(n)&&n>=0&&n<=255&&String(n)===address.split(".")[i]) && p[1]! >= 64 && p[1]! <=127;
}

// Narrow fixed X.509 v3 profile. No public general certificate generator or lab identity fallback.
function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts), size = body.length;
  if (size > 65535) throw new SealedCustodyError("invalid_input");
  const length = size < 128 ? Buffer.from([size]) : size < 256 ? Buffer.from([0x81, size]) : Buffer.from([0x82, size >>> 8, size & 255]);
  return Buffer.concat([Buffer.from([tag]), length, body]);
}
const sequence = (...parts: Buffer[]) => der(0x30, ...parts);
const oid = (hex: string) => der(6, Buffer.from(hex, "hex"));
const extension = (id: string, value: Buffer, critical = false) => sequence(oid(id), ...(critical ? [der(1, Buffer.from([255]))] : []), der(4, value));
const pem = (label: string, bytes: Buffer) => `-----BEGIN ${label}-----\n${bytes.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END ${label}-----\n`;
const time = (date: Date) => {
  const value = date.toISOString().replace(/[-:T]/g, "").replace(/\.\d{3}Z$/, "Z");
  return der(date.getUTCFullYear() <= 2049 ? 0x17 : 0x18, Buffer.from(date.getUTCFullYear() <= 2049 ? value.slice(2) : value));
};
function appClientHostIdentity(address: string): TlsIdentity {
  if (!isTailscaleIPv4(address)) throw new SealedCustodyError("invalid_input");
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const algorithm = sequence(oid("2a8648ce3d040302"));
  const name = sequence(der(0x31, sequence(oid("550403"), der(12, Buffer.from("Dexter paired app host")))));
  const serial = randomBytes(16); serial[0] = (serial[0]! & 0x7f) | 1;
  const now = Date.now();
  const extensions = sequence(
    extension("551d13", sequence(), true), // Leaf only, not a CA.
    extension("551d0f", der(3, Buffer.from([7, 0x80])), true), // digitalSignature.
    extension("551d11", sequence(der(0x87, Buffer.from(address.split(".").map(Number))))),
    extension("551d25", sequence(oid("2b06010505070301")))); // serverAuth only.
  const tbs = sequence(der(0xa0, der(2, Buffer.from([2]))), der(2, serial), algorithm, name,
    sequence(time(new Date(now - 60_000)), time(new Date(now + 365 * 86400_000))), name,
    publicKey.export({ type: "spki", format: "der" }), der(0xa3, extensions));
  const certificate = sequence(tbs, algorithm, der(3, Buffer.from([0]), sign("sha256", tbs, privateKey)));
  const parsed = new X509Certificate(certificate);
  if (!parsed.verify(publicKey) || !parsed.checkPrivateKey(privateKey) || parsed.checkIP(address) !== address || parsed.ca) throw new SealedCustodyError("unavailable");
  const encoded = privateKey.export({ type: "pkcs8", format: "der" });
  try { return new TlsIdentity(pem("CERTIFICATE", certificate), pem("PRIVATE KEY", encoded), createHash("sha256").update(certificate).digest("hex")); }
  finally { encoded.fill(0); }
}


/** Explicit owner gesture only. Existing installation, create-only ciphertext and private inherited password.
 * The certificate is a pinned leaf for this exact private IP, never a public CA or a wildcard listener.
 * Restart/unlock never creates/rekeys, and a changed interface requires another reviewed setup/pairing.
 * This is encrypted exportable software custody; mTLS claim approval and per-bot grants remain separate.
 */
export async function openDesktopAppClientCustody(store: HostStore, file: string, action: "create" | "unlock",
  expected: {installationId: string; ownerId: string}, password: () => Buffer, address: string, port = 0): Promise<{custody: OperatorSealedCustody; appClients: Readonly<AppClientServicesOptions>}> {
  let secret: Buffer | undefined, custody: OperatorSealedCustody | undefined;
  try {
    if (!isAbsolute(file) || file.includes("\0") || !["create","unlock"].includes(action) || !isTailscaleIPv4(address)
      || !Number.isSafeInteger(port) || port<0 || port>65535) throw new SealedCustodyError("invalid_input");
    store.summary();
    if (expected.installationId !== store.hostId || expected.ownerId !== store.ownerId)
      throw new HostError("conflict", "Desktop app client installation changed before preparation.");
    const binding: CustodyBinding = { installationId: store.hostId, ownerId: store.ownerId, deviceId: "desktop-app-host", generation: 1, keyId: "desktop-app-key" };
    const existing = new OperatorSealedCustody(file,binding);
    secret = password();
    if (!Buffer.isBuffer(secret) || secret.length<16 || secret.length>1024) throw new SealedCustodyError("invalid_input");
    custody = action === "create" ? OperatorSealedCustody.create(file,binding,secret,appClientHostIdentity(address)) : existing;
    custody.unlock(secret);
    const appClients = validateAppClientServicesOptions({ identity:custody.tlsIdentity(),listenHost:address,port,offerTtlMs:300_000 });
    return { custody,appClients };
  } catch(error) {
    await custody?.close();
    if (error instanceof SealedCustodyError || error instanceof HostError) throw error;
    throw new SealedCustodyError("unavailable");
  } finally {secret?.fill(0);}
}
