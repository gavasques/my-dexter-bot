import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, createSecretKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, scryptSync, sign, X509Certificate, type KeyObject } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { inspect, types } from "node:util";
import { TlsIdentity } from "@dexter/devices";
import type { CustodyProvider, OwnerAuthority, SnapshotKey } from "@dexter/operations";
import { bytes, pin, publicKey } from "@dexter/relay/protocol";
import type { DevicePin } from "@dexter/relay";
import type { DecryptionRequest, RelayCustodyProvider } from "@dexter/relay-host";

const MAGIC = Buffer.from("DXSEAL01");
const MAX_FILE = 65536, MAX_HEADER = 2048, FIXED = 72;
const N = 32768, R = 8, P = 1;
const ID = /^[A-Za-z0-9_-]{1,80}$/;
export type SealedCustodyCode = "invalid_input" | "private_path_required" | "conflict" | "authentication_failed" | "locked" | "busy" | "unavailable";
export class SealedCustodyError extends Error {
  constructor(readonly code: SealedCustodyCode) { super(`operator custody ${code}`); this.name = "SealedCustodyError"; }
}
const fail = (code: SealedCustodyCode): never => { throw new SealedCustodyError(code); };
function sanitized<T>(operation: () => T): T {
  try { return operation(); } catch (error) { if (error instanceof SealedCustodyError) throw error; return fail("unavailable"); }
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return fail("invalid_input");
  const descriptors = Object.getOwnPropertyDescriptors(value), own = Reflect.ownKeys(descriptors);
  if (own.length !== keys.length || own.some(k => typeof k !== "string" || !keys.includes(k) || !descriptors[k]!.enumerable || !("value" in descriptors[k]!))) return fail("invalid_input");
  return Object.fromEntries(keys.map(k => [k, descriptors[k]!.value]));
}
export interface CustodyBinding { installationId: string; ownerId: string; deviceId: string; generation: number; keyId: string }
function binding(value: unknown): Readonly<CustodyBinding> {
  const x = object(value, ["installationId", "ownerId", "deviceId", "generation", "keyId"]);
  for (const k of ["installationId", "ownerId", "deviceId", "keyId"]) if (typeof x[k] !== "string" || !ID.test(x[k])) fail("invalid_input");
  if ((x["keyId"] as string).length > 55 || !Number.isSafeInteger(x["generation"]) || (x["generation"] as number) < 1) fail("invalid_input");
  return Object.freeze(x) as unknown as Readonly<CustodyBinding>;
}
function secret(value: Buffer): Buffer {
  if (types.isProxy(value) || !Buffer.isBuffer(value) || value.length < 16 || value.length > 1024) return fail("invalid_input");
  return Buffer.from(value);
}
function uid() { if (!process.getuid) return fail("private_path_required"); return process.getuid(); }
function privateStat(stat: Stats, directory: boolean) {
  if (stat.uid !== uid() || (stat.mode & 0o777) !== (directory ? 0o700 : 0o600) || (directory ? !stat.isDirectory() : !stat.isFile())) fail("private_path_required");
}
function privateDirectory(path: string, create: boolean): string {
  const p = resolve(path);
  // Reject symlink components, including parent redirection; no recursive creation or permission repair.
  for (let q = dirname(p); ; q = dirname(q)) {
    if (lstatSync(q).isSymbolicLink()) fail("private_path_required");
    if (dirname(q) === q) break;
  }
  try { lstatSync(p); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT" || !create) fail("private_path_required");
    mkdirSync(p, { mode: 0o700 });
  }
  const s = lstatSync(p); if (s.isSymbolicLink()) fail("private_path_required"); privateStat(s, true);
  return realpathSync(p);
}
function readPrivate(path: string): Buffer {
  privateDirectory(dirname(path), false);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd); privateStat(st, false);
    if (st.nlink !== 1 || st.size < FIXED + 16 || st.size > MAX_FILE) fail("invalid_input");
    const out = Buffer.alloc(st.size); let pos = 0;
    while (pos < out.length) { const n = readSync(fd, out, pos, out.length - pos, pos); if (!n) fail("invalid_input"); pos += n; }
    const after = fstatSync(fd);
    if (after.size !== st.size || after.mtimeMs !== st.mtimeMs || after.ctimeMs !== st.ctimeMs) fail("conflict");
    return out;
  } finally { closeSync(fd); }
}
/** Create-only atomic publication. A random, private staging file is fsynced, linked without replacement, removed,
 * then the directory is fsynced. Same-uid/root path races are outside this cooperative-owner model. */
function publish(path: string, contents: Buffer): void {
  if (contents.length > MAX_FILE) fail("invalid_input");
  const parent = privateDirectory(dirname(path), true), target = join(parent, basename(path));
  const temporary = join(parent, `.sealed-${randomBytes(16).toString("hex")}`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    privateStat(fstatSync(fd), false); writeFileSync(fd, contents); fsyncSync(fd); closeSync(fd); fd = undefined;
    try { linkSync(temporary, target); } catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") fail("conflict"); throw e; }
    unlinkSync(temporary);
    const directory = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temporary); } catch { /* only our temporary */ } }
}
interface PublicDescription { binding: Readonly<CustodyBinding>; publicPin: Readonly<DevicePin>; ownerSigningPublicKey: string; snapshotKeyId: string; tlsFingerprint: string }
interface Material { snapshot: KeyObject; owner: KeyObject; signing: KeyObject; encryption: KeyObject; tls: TlsIdentity }
function pub(key: KeyObject): string { return createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64"); }
function publicDescription(m: Material, b: Readonly<CustodyBinding>): Readonly<PublicDescription> {
  const tls = new X509Certificate(m.tls.certPem), key = createPrivateKey(m.tls.keyPem);
  if (!tls.checkPrivateKey(key) || createHash("sha256").update(tls.raw).digest("hex") !== m.tls.fingerprint || !["ec", "rsa", "ed25519"].includes(key.asymmetricKeyType ?? "")) fail("invalid_input");
  return Object.freeze({ binding: b, publicPin: Object.freeze(pin({ ...b, signingPublicKey: pub(m.signing), encryptionPublicKey: pub(m.encryption) })),
    ownerSigningPublicKey: pub(m.owner), snapshotKeyId: `${b.keyId}-snapshot`, tlsFingerprint: m.tls.fingerprint });
}
function checkedDescription(value: unknown): Readonly<PublicDescription> {
  const x = object(value, ["binding", "publicPin", "ownerSigningPublicKey", "snapshotKeyId", "tlsFingerprint"]);
  const b = binding(x["binding"]), p = Object.freeze(pin(x["publicPin"]));
  if (Object.keys(b).some(k => b[k as keyof CustodyBinding] !== p[k as keyof CustodyBinding]) || typeof x["ownerSigningPublicKey"] !== "string" || x["snapshotKeyId"] !== `${b.keyId}-snapshot` || typeof x["tlsFingerprint"] !== "string" || !/^[a-f0-9]{64}$/.test(x["tlsFingerprint"])) fail("invalid_input");
  publicKey(x["ownerSigningPublicKey"], "ed25519");
  return Object.freeze({ binding: b, publicPin: p, ownerSigningPublicKey: x["ownerSigningPublicKey"] as string, snapshotKeyId: x["snapshotKeyId"] as string, tlsFingerprint: x["tlsFingerprint"] as string });
}
function serialize(m: Material): Buffer {
  const buffers: Buffer[] = [];
  try {
    const exportKey = (k: KeyObject) => { const b = k.export({ type: "pkcs8", format: "der" }); buffers.push(b); return b.toString("base64"); };
    const s = m.snapshot.export(); buffers.push(s);
    return Buffer.from(JSON.stringify({ snapshot: s.toString("base64"), owner: exportKey(m.owner), signing: exportKey(m.signing), encryption: exportKey(m.encryption), certPem: m.tls.certPem, keyPem: m.tls.keyPem }));
  } finally { buffers.forEach(b => b.fill(0)); }
}
function material(plain: Buffer): Material {
  const x = object(JSON.parse(plain.toString("utf8")) as unknown, ["snapshot", "owner", "signing", "encryption", "certPem", "keyPem"]);
  const privateKey = (v: unknown, algorithm: "ed25519" | "x25519") => {
    const b = bytes(v, 256); try { const key = createPrivateKey({ key: b, type: "pkcs8", format: "der" });
      const canonical = key.export({ type: "pkcs8", format: "der" }); try { if (key.asymmetricKeyType !== algorithm || !canonical.equals(b)) fail("invalid_input"); } finally { canonical.fill(0); }
      return key;
    } finally { b.fill(0); }
  };
  if (typeof x["certPem"] !== "string" || typeof x["keyPem"] !== "string" || x["certPem"].length > 16384 || x["keyPem"].length > 16384) fail("invalid_input");
  const b = bytes(x["snapshot"], 32, 32); let snapshot: KeyObject; try { snapshot = createSecretKey(b); } finally { b.fill(0); }
  const cert = new X509Certificate(x["certPem"] as string);
  return { snapshot, owner: privateKey(x["owner"], "ed25519"), signing: privateKey(x["signing"], "ed25519"), encryption: privateKey(x["encryption"], "x25519"), tls: new TlsIdentity(x["certPem"] as string, x["keyPem"] as string, createHash("sha256").update(cert.raw).digest("hex")) };
}
function derive(password: Buffer, salt: Buffer): Buffer { return scryptSync(password, salt, 32, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 }); }
function seal(plain: Buffer, description: Readonly<PublicDescription>, password: Buffer): Buffer {
  const header = Buffer.from(JSON.stringify(description)); if (header.length > MAX_HEADER) fail("invalid_input");
  const fixed = Buffer.alloc(FIXED); MAGIC.copy(fixed); fixed.writeUInt32BE(N, 8); fixed.writeUInt32BE(R, 12); fixed.writeUInt32BE(P, 16); fixed.writeUInt32BE(header.length, 20); fixed.writeUInt32BE(plain.length, 24);
  randomBytes(32).copy(fixed, 28); randomBytes(12).copy(fixed, 60);
  const aad = Buffer.concat([fixed, header]), key = derive(password, fixed.subarray(28, 60));
  try { const cipher = createCipheriv("aes-256-gcm", key, fixed.subarray(60, 72), { authTagLength: 16 }); cipher.setAAD(aad);
    return Buffer.concat([aad, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  } finally { key.fill(0); }
}
function parse(file: Buffer): { aad: Buffer; description: Readonly<PublicDescription>; ciphertext: Buffer; tag: Buffer } {
  if (file.length < FIXED + 16 || file.length > MAX_FILE || !file.subarray(0, 8).equals(MAGIC) || file.readUInt32BE(8) !== N || file.readUInt32BE(12) !== R || file.readUInt32BE(16) !== P) fail("invalid_input");
  const h = file.readUInt32BE(20), c = file.readUInt32BE(24);
  if (h < 2 || h > MAX_HEADER || c < 2 || c > MAX_FILE - FIXED - h - 16 || file.length !== FIXED + h + c + 16) fail("invalid_input");
  const header = file.subarray(FIXED, FIXED + h), description = checkedDescription(JSON.parse(header.toString("utf8")) as unknown);
  // Single closed canonical representation: duplicate JSON keys and alternate representations refuse.
  if (!Buffer.from(JSON.stringify(description)).equals(header)) fail("invalid_input");
  return { aad: file.subarray(0, FIXED + h), description, ciphertext: file.subarray(FIXED + h, -16), tag: file.subarray(-16) };
}
function open(file: Buffer, password: Buffer, expected: Readonly<CustodyBinding>): { material: Material; description: Readonly<PublicDescription> } {
  const p = parse(file);
  if (JSON.stringify(p.description.binding) !== JSON.stringify(expected)) fail("authentication_failed");
  const key = derive(password, file.subarray(28, 60)); let plain: Buffer | undefined;
  try {
    const d = createDecipheriv("aes-256-gcm", key, file.subarray(60, 72), { authTagLength: 16 }); d.setAAD(p.aad); d.setAuthTag(p.tag);
    plain = d.update(p.ciphertext); try { d.final(); } catch { return fail("authentication_failed"); }
    const m = material(plain);
    if (JSON.stringify(publicDescription(m, expected)) !== JSON.stringify(p.description)) fail("authentication_failed");
    return { material: m, description: p.description };
  } finally { key.fill(0); plain?.fill(0); }
}

/** Exportable software keys sealed to a local operator passphrase. Every open starts locked; unlock never creates,
 * repairs or rotates. Methods returned from one unlock are epoch-bound and stay revoked after subsequent unlock. */
export class OperatorSealedCustody {
  readonly #path: string; readonly #binding: Readonly<CustodyBinding>;
  #material: Material | null = null; #description: Readonly<PublicDescription> | null = null; #epoch = 0; #closed = false;
  #flights = new Set<Promise<unknown>>(); #locking: Promise<void> | null = null;
  constructor(path: string, expected: CustodyBinding) { this.#path = resolve(path); this.#binding = binding(expected); }
  static create(path: string, expected: CustodyBinding, password: Buffer, tls: TlsIdentity): OperatorSealedCustody {
    return sanitized(() => {
      const b = binding(expected), pw = secret(password); let plain: Buffer | undefined;
      try {
        // TLS provisioning is explicit and local; no self-signed production certificate generation here.
        if (types.isProxy(tls) || Object.getPrototypeOf(tls) !== TlsIdentity.prototype) fail("invalid_input");
        const entropy = randomBytes(32); let snapshot: KeyObject; try { snapshot = createSecretKey(entropy); } finally { entropy.fill(0); }
        const m: Material = { snapshot, owner: generateKeyPairSync("ed25519").privateKey, signing: generateKeyPairSync("ed25519").privateKey, encryption: generateKeyPairSync("x25519").privateKey, tls };
        const description = publicDescription(m, b); plain = serialize(m); publish(resolve(path), seal(plain, description, pw));
        return new OperatorSealedCustody(path, b);
      } finally { pw.fill(0); plain?.fill(0); }
    });
  }
  unlock(password: Buffer): void {
    sanitized(() => {
      if (this.#closed) fail("locked"); if (this.#locking || this.#material) fail("busy");
      const pw = secret(password);
      try { const result = open(readPrivate(this.#path), pw, this.#binding); this.#material = result.material; this.#description = result.description; this.#epoch++; }
      finally { pw.fill(0); }
    });
  }
  private admit(epoch = this.#epoch): Material {
    if (this.#closed || this.#locking || !this.#material || epoch !== this.#epoch) return fail("locked"); return this.#material;
  }
  private flight<T>(epoch: number, action: (m: Material) => T): Promise<T> {
    let m: Material; try { m = this.admit(epoch); } catch (e) { return Promise.reject(e); }
    // Captured material permits already-admitted work to finish after stop-admission. Future admissions refuse.
    const p = Promise.resolve().then(() => sanitized(() => action(m)));
    this.#flights.add(p); void p.finally(() => this.#flights.delete(p)).catch(() => undefined); return p;
  }
  operations(): Readonly<CustodyProvider> {
    this.admit(); const epoch = this.#epoch, description = this.#description!;
    const key: SnapshotKey = Object.freeze({ keyId: description.snapshotKeyId, use: <T>(fn: (k: KeyObject) => T): T => fn(this.admit(epoch).snapshot) });
    const signer: OwnerAuthority = Object.freeze({ publicKey: publicKey(description.ownerSigningPublicKey, "ed25519"), sign: (message: Buffer): Buffer => {
      if (!Buffer.isBuffer(message) || message.length > MAX_FILE) fail("invalid_input"); return sign(null, message, this.admit(epoch).owner);
    } });
    return Object.freeze({ snapshotKey: () => { this.admit(epoch); return key; }, ownerSigner: () => { this.admit(epoch); return signer; } });
  }
  relay(): Readonly<RelayCustodyProvider> {
    this.admit(); const epoch = this.#epoch, description = this.#description!;
    return Object.freeze({ kind: "operator_sealed_exportable", publicPin: description.publicPin,
      current: () => { try { this.admit(epoch); return true; } catch { return false; } },
      sign: (data: Uint8Array) => {
        if (types.isProxy(data) || !(data instanceof Uint8Array) || data.byteLength > MAX_FILE) return Promise.reject(new SealedCustodyError("invalid_input"));
        const copy = Buffer.from(data); return this.flight(epoch, m => { try { return sign(null, copy, m.signing); } finally { copy.fill(0); } });
      },
      decrypt: (raw: Readonly<DecryptionRequest>) => {
        let request: Record<string, unknown>;
        try { request = object(raw, ["ephemeralPublicKey", "nonce", "ciphertext", "tag", "aad", "installationId"]); } catch (e) { return Promise.reject(e); }
        if (request["installationId"] !== this.#binding.installationId || typeof request["aad"] !== "string" || request["aad"].length > MAX_HEADER) return Promise.reject(new SealedCustodyError("invalid_input"));
        return this.flight(epoch, m => {
          const shared = diffieHellman({ privateKey: m.encryption, publicKey: publicKey(request["ephemeralPublicKey"], "x25519") });
          const salt = createHash("sha256").update(`DEXTER_RELAY_KDF_V1\n${this.#binding.installationId}`).digest();
          const key = Buffer.from(hkdfSync("sha256", shared, salt, Buffer.from(`DEXTER_RELAY_AEAD_V1\n${request["aad"] as string}`), 32));
          let unverified: Buffer | undefined;
          try {
            const d = createDecipheriv("aes-256-gcm", key, bytes(request["nonce"], 12, 12), { authTagLength: 16 }); d.setAAD(Buffer.from(request["aad"] as string)); d.setAuthTag(bytes(request["tag"], 16, 16));
            unverified = d.update(bytes(request["ciphertext"], 32768)); try { d.final(); } catch { unverified.fill(0); return fail("authentication_failed"); }
            return unverified;
          } finally { shared.fill(0); key.fill(0); }
        });
      }, close: () => { try { this.admit(epoch); } catch (error) { return Promise.reject(error); } return this.lock(); } });
  }
  /** Trusted host startup only. TLS APIs copy private material internally; the host lifecycle MUST drain and shut
   * down before locking custody. An already lent TlsIdentity/KeyObject cannot be erased or remotely revoked by JS. */
  tlsIdentity(): TlsIdentity { return this.admit().tls; }
  exportSealed(destination: string, newPassword: Buffer): void {
    sanitized(() => {
      const m = this.admit(), pw = secret(newPassword); let plain: Buffer | undefined;
      try { plain = serialize(m); publish(resolve(destination), seal(plain, this.#description!, pw)); }
      finally { pw.fill(0); plain?.fill(0); }
    });
  }
  /** Rekey creates a NEW sealed backup only, never overwrites the live custody file. Operator selects the new path
   * after shutdown. This does not transfer authority, grants, writers, or coordinator state. */
  lock(): Promise<void> {
    if (this.#locking) return this.#locking;
    this.#epoch++; // immediately invalidate all retained capabilities
    this.#locking = (async () => { await Promise.allSettled([...this.#flights]); this.#material = null; })();
    void this.#locking.finally(() => { this.#locking = null; }).catch(() => undefined);
    return this.#locking;
  }
  async close(): Promise<void> { this.#closed = true; await this.lock(); }
  toJSON() { return { kind: "operator_sealed_exportable", storage: "software", exportable: true, unlocked: Boolean(this.#material) && !this.#locking && !this.#closed, binding: this.#binding, identity: this.#description, physicalCustodyVerified: false }; }
  [inspect.custom]() { return this.toJSON(); }
}

/** Local inherited private FD input. No argv/env password, echoing TTY, stdout, or user module loading. Owner-only
 * regular files or inherited FIFO only; caller owns descriptor lifetime. Reads are bounded before allocation. */
export function readOperatorPrivateFd(fd: number, maximum = 1024): Buffer {
  return sanitized(() => {
    if (!Number.isSafeInteger(fd) || fd < 3 || !Number.isSafeInteger(maximum) || maximum < 16 || maximum > MAX_FILE) fail("invalid_input");
    const st = fstatSync(fd);
    if (st.uid !== uid() || (!st.isFIFO() && !st.isFile()) || (st.isFile() && ((st.mode & 0o777) !== 0o600 || st.nlink !== 1 || st.size > maximum))) fail("private_path_required");
    const out = Buffer.alloc(maximum + 1); let offset = 0;
    try { while (offset <= maximum) { const n = readSync(fd, out, offset, out.length - offset, null); if (!n) break; offset += n; }
      if (offset > maximum) fail("invalid_input"); return Buffer.from(out.subarray(0, offset));
    } finally { out.fill(0); }
  });
}
