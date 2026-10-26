import { createHash, generateKeyPairSync, randomBytes, sign, X509Certificate } from "node:crypto";
import { isAbsolute } from "node:path";
import { HostError, type HostStore } from "@dexter/hub";
import { TlsIdentity } from "@dexter/devices";
import { type DeviceServicesOptions } from "./device-services.js";
import { prepareLocalDeviceChannel } from "./local-device-bootstrap.js";
import { OperatorSealedCustody, SealedCustodyError, type CustodyBinding } from "./operator-sealed-custody.js";

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
function localHostIdentity(): TlsIdentity {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const algorithm = sequence(oid("2a8648ce3d040302"));
  const name = sequence(der(0x31, sequence(oid("550403"), der(12, Buffer.from("Dexter local device host")))));
  const serial = randomBytes(16); serial[0] = (serial[0]! & 0x7f) | 1;
  const now = Date.now();
  const extensions = sequence(
    extension("551d13", sequence(), true), // Leaf only, not a CA.
    extension("551d0f", der(3, Buffer.from([7, 0x80])), true), // digitalSignature.
    extension("551d11", sequence(der(0x87, Buffer.from([127, 0, 0, 1])), der(0x82, Buffer.from("localhost")))),
    extension("551d25", sequence(oid("2b06010505070301")))); // serverAuth only.
  const tbs = sequence(der(0xa0, der(2, Buffer.from([2]))), der(2, serial), algorithm, name,
    sequence(time(new Date(now - 60_000)), time(new Date(now + 365 * 86400_000))), name,
    publicKey.export({ type: "spki", format: "der" }), der(0xa3, extensions));
  const certificate = sequence(tbs, algorithm, der(3, Buffer.from([0]), sign("sha256", tbs, privateKey)));
  const parsed = new X509Certificate(certificate);
  if (!parsed.verify(publicKey) || !parsed.checkPrivateKey(privateKey) || parsed.checkIP("127.0.0.1") !== "127.0.0.1"
    || parsed.checkHost("localhost") !== "localhost" || parsed.ca) throw new SealedCustodyError("unavailable");
  const encoded = privateKey.export({ type: "pkcs8", format: "der" });
  try { return new TlsIdentity(pem("CERTIFICATE", certificate), pem("PRIVATE KEY", encoded), createHash("sha256").update(certificate).digest("hex")); }
  finally { encoded.fill(0); }
}

export interface LocalDeviceCustodyResult {
  /** Unlocked custody ownership transfers on success. Drain its host before close()/lock(). */
  custody: OperatorSealedCustody;
  devices: Readonly<DeviceServicesOptions>;
}
/**
 * Trusted owner-local action, never HTTP/engine input by itself. Import/construction is inert. Uses the
 * already-open canonical host identity, never creates a host. `create` explicitly issues a loopback-only
 * self-signed pin and publishes ONLY encrypted custody; an existing file refuses without replacement.
 * `unlock` only opens the existing file and never regenerates expired/invalid trust. TLS1.3/pin checking
 * and claim approval are unchanged. This is software password custody, not non-exportable hardware.
 *
 * `password` returns an OWNED 16..1024 byte Buffer through a trusted callback (no argv/env/file/log).
 * The returned buffer is consumed and zeroed even on failure. The caller supplies the read deadline.
 * JavaScript PEM strings/KeyObjects cannot be guaranteed erased; private key material persists only in
 * the authenticated encrypted file. Root must restrict this action/path to its explicit local owner UI.
 */
export async function openLocalDeviceCustody(store: HostStore, file: string, action: "create" | "unlock",
  password: () => Buffer, port = 4318): Promise<LocalDeviceCustodyResult> {
  let secret: Buffer | undefined, custody: OperatorSealedCustody | undefined;
  try {
    if (typeof file !== "string" || !isAbsolute(file) || file.includes("\0") || !["create", "unlock"].includes(action)
      || typeof password !== "function" || !Number.isSafeInteger(port) || port < 0 || port > 65535) throw new SealedCustodyError("invalid_input");
    store.summary();
    const binding: CustodyBinding = { installationId: store.hostId, ownerId: store.ownerId,
      deviceId: "local-device-host", generation: 1, keyId: "local-device-key" };
    // Validate binding before invoking the trusted password callback. Constructor does no IO.
    const existing = new OperatorSealedCustody(file, binding);
    secret = password();
    if (!Buffer.isBuffer(secret) || secret.length < 16 || secret.length > 1024) throw new SealedCustodyError("invalid_input");
    store.summary();
    custody = action === "create" ? OperatorSealedCustody.create(file, binding, secret, localHostIdentity()) : existing;
    custody.unlock(secret);
    return { custody, devices: prepareLocalDeviceChannel(custody, { installationId: store.hostId, ownerId: store.ownerId }, port) };
  } catch (error) {
    await custody?.close();
    if (error instanceof SealedCustodyError || error instanceof HostError) throw error;
    throw new SealedCustodyError("unavailable");
  } finally { if (Buffer.isBuffer(secret)) secret.fill(0); }
}
