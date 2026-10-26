// Explicit LAB PKI: no filesystem, subprocess, production defaults or custody fallback.
import { createHash, generateKeyPairSync, randomBytes, sign, X509Certificate, type KeyObject } from "node:crypto";
import { isIP } from "node:net";
import { inspect, types } from "node:util";
import { DeviceError } from "./errors.js";
import { TlsIdentity } from "./files.js";
export interface LabCertificateOptions {
  profile: "device" | "host" | "client" | "ca" | "peer";
  name: string;
  /** Explicit IPv4/DNS SANs; host defaults to 127.0.0.1 and localhost. */
  san?: readonly string[];
  notBefore?: Date;
  notAfter?: Date;
  issuer?: LabTlsMaterial;
}
const fail = (): never => { throw new DeviceError("invalid_input", "invalid lab certificate profile"); };
function der(tag: number, body: Buffer): Buffer {
  if (body.length > 65535) return fail();
  const length = body.length < 128 ? Buffer.from([body.length]) : body.length <= 255 ? Buffer.from([0x81, body.length]) : Buffer.from([0x82, body.length >>> 8, body.length & 255]);
  return Buffer.concat([Buffer.from([tag]), length, body]);
}
const seq = (...b: Buffer[]) => der(0x30, Buffer.concat(b));
const oid = (hex: string) => der(6, Buffer.from(hex, "hex"));
const algorithm = seq(oid("2a8648ce3d040302")); // ecdsa-with-SHA256, absent parameters
const nameDER = (name: string) => seq(der(0x31, seq(oid("550403"), der(12, Buffer.from(name)))));
// RFC5280 4.1.2.5. Supported input years2000..9999; discard milliseconds.
const timeDER = (time: Date) => {
  const full = time.toISOString().replace(/[-:T]/g, "").replace(/\.\d{3}Z$/, "Z");
  return der(time.getUTCFullYear() <= 2049 ? 0x17 : 0x18, Buffer.from(time.getUTCFullYear() <= 2049 ? full.slice(2) : full));
};
const extension = (id: string, value: Buffer, critical = false) => seq(oid(id), ...(critical ? [der(1, Buffer.from([255]))] : []), der(4, value));
const pem = (label: string, b: Buffer) => `-----BEGIN ${label}-----\n${b.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END ${label}-----\n`;
/** Redacted memory material. Existing Node TLS contracts retain a PEM string in TlsIdentity;
 * transient PKCS8 buffers are wiped. JavaScript strings and OpenSSL internal copies cannot be wiped. */
const issuanceToken = Symbol("lab issuance");
const issued = new WeakMap<LabTlsMaterial, { key: KeyObject; subject: Buffer; ca: boolean; cert: X509Certificate }>();
export class LabTlsMaterial {
  readonly #key: KeyObject;
  readonly #subject: Buffer;
  readonly #ca: boolean;
  readonly identity: TlsIdentity;
  constructor(token: symbol, key: KeyObject, subject: Buffer, ca: boolean, certificate: Buffer) {
    if (token !== issuanceToken) throw new DeviceError("invalid_input", "factory-issued lab material required");
    this.#key = key; this.#subject = subject; this.#ca = ca;
    const encoded = key.export({ format: "der", type: "pkcs8" });
    try { this.identity = new TlsIdentity(pem("CERTIFICATE", certificate), pem("PRIVATE KEY", encoded), createHash("sha256").update(certificate).digest("hex")); }
    finally { encoded.fill(0); }
    issued.set(this, { key, subject: Buffer.from(subject), ca, cert: new X509Certificate(certificate) });
    Object.freeze(this);
  }
  signCertificate(tbs: Buffer): Buffer { if (!this.#ca) return fail(); return sign("sha256", tbs, this.#key); }
  get issuerName(): Buffer { return Buffer.from(this.#subject); }
  get isCA(): boolean { return this.#ca; }
  toJSON(): object { return { fingerprint: this.identity.fingerprint, ca: this.#ca }; }
  [inspect.custom](): object { return this.toJSON(); }
}
/** Bounded X.509 v3 DER, P-256 named curve and actual signatures. Narrow single CA→leaf
 * profiles; IPv6, arbitrary extensions and subordinate CAs are intentionally unsupported. */
export function createLabTlsIdentity(options: LabCertificateOptions): LabTlsMaterial {
  if (!options || types.isProxy(options) || Object.getPrototypeOf(options) !== Object.prototype) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(options);
  if (Reflect.ownKeys(descriptors).some(k => typeof k !== "string" || !["profile", "name", "san", "notBefore", "notAfter", "issuer"].includes(k) || !("value" in descriptors[k]!))) return fail();
  const { profile, name, issuer } = options;
  if (!["device", "host", "client", "ca", "peer"].includes(profile) || typeof name !== "string" || !/^[a-zA-Z0-9 ._-]{1,64}$/.test(name)) return fail();
  const signer = issuer === undefined ? undefined : issued.get(issuer);
  if (issuer !== undefined && (!signer || !signer.ca || profile === "ca")) return fail();
  const before = options.notBefore ?? new Date(Date.now() - 60000), after = options.notAfter ?? new Date(issuer ? Date.parse(new X509Certificate(issuer.identity.certPem).validTo) : Date.now() + 86400000);
  if (!(before instanceof Date) || !(after instanceof Date) || !Number.isFinite(before.getTime()) || !Number.isFinite(after.getTime()) || Math.floor(before.getTime()/1000) >= Math.floor(after.getTime()/1000) || before.getUTCFullYear() < 2000 || after.getUTCFullYear() > 9999) return fail();
  if (signer) {
    const cert = signer.cert;
    if (Math.floor(before.getTime()/1000)*1000 < Date.parse(cert.validFrom) || Math.floor(after.getTime()/1000)*1000 > Date.parse(cert.validTo)) return fail();
  }
  const sans = options.san ?? (profile === "host" || profile === "peer" ? ["IP:127.0.0.1", "DNS:localhost"] : []);
  if (!Array.isArray(sans) || types.isProxy(sans) || sans.length > 8 || new Set(sans).size !== sans.length) return fail();
  const names = sans.map(value => {
    if (typeof value !== "string") return fail();
    if (value.startsWith("IP:") && isIP(value.slice(3)) === 4) return der(0x87, Buffer.from(value.slice(3).split(".").map(Number)));
    if (value.startsWith("DNS:") && value.length <= 257 && /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(value.slice(4)) && value.slice(4).split(".").every(s => s.length >= 1 && s.length <= 63 && !s.startsWith("-") && !s.endsWith("-"))) return der(0x82, Buffer.from(value.slice(4), "ascii"));
    return fail();
  });
  const ca = profile === "ca"; if (ca && sans.length) return fail();
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const subject = nameDER(name), serial = randomBytes(16); serial[0] = (serial[0]! & 0x7f) | 1;
  const extensions = [extension("551d13", ca ? seq(der(1, Buffer.from([255])), der(2, Buffer.from([0]))) : seq(), true), extension("551d0f", der(3, ca ? Buffer.from([1, 6]) : Buffer.from([7, 0x80])), true)];
  if (names.length) extensions.push(extension("551d11", seq(...names)));
  if (profile === "peer") extensions.push(extension("551d25", seq(oid("2b06010505070301"),oid("2b06010505070302"))));
  else if (profile === "host" || profile === "client") extensions.push(extension("551d25", seq(oid(profile === "host" ? "2b06010505070301" : "2b06010505070302"))));
  const tbs = seq(der(0xa0, der(2, Buffer.from([2]))), der(2, serial), algorithm, signer?.subject ?? subject,
    seq(timeDER(before), timeDER(after)), subject, publicKey.export({ format: "der", type: "spki" }), der(0xa3, seq(...extensions)));
  const signature = sign("sha256", tbs, signer?.key ?? privateKey);
  const certificate = seq(tbs, algorithm, der(3, Buffer.concat([Buffer.from([0]), signature])));
  const parsed = new X509Certificate(certificate);
  if (!parsed.verify(signer?.cert.publicKey ?? publicKey) || !parsed.checkPrivateKey(privateKey)) return fail();
  return new LabTlsMaterial(issuanceToken, privateKey, subject, ca, certificate);
}
