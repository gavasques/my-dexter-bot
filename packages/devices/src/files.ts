import { chmodSync, lstatSync, mkdirSync, readFileSync, type Stats } from "node:fs";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { join } from "node:path";
import { inspect } from "node:util";
import { DeviceError } from "./errors.js";
import { fingerprintDer } from "./wire.js";

function uid(): number {
  if (!process.getuid) throw new DeviceError("unavailable", "POSIX ownership required");
  return process.getuid();
}
function statOrNull(path: string): Stats | null {
  try { return lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new DeviceError("unavailable", "private path unavailable");
  }
}

/** Existing (or created) directory owned by this user, not a symlink, without group/other access. */
export function privateDirectory(path: string, create = true): void {
  let stat = statOrNull(path);
  if (!stat && create) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    stat = statOrNull(path);
  }
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== uid() || (stat.mode & 0o077) !== 0) {
    throw new DeviceError("forbidden", "private directory required");
  }
}
/** A regular file owned by this user without group/other access, never a symlink (dangling or not). */
export function privateFile(path: string): void {
  const stat = statOrNull(path);
  if (!stat || stat.isSymbolicLink() || !stat.isFile() || stat.uid !== uid() || (stat.mode & 0o077) !== 0) {
    throw new DeviceError("forbidden", "private file required");
  }
}
/**
 * Before opening an auxiliary SQLite file: the database and its WAL/SHM siblings must be absent or private
 * regular files. A symlink, including a dangling one, is refused so the open cannot be redirected.
 */
export function privateDatabasePath(path: string): void {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
    const stat = statOrNull(candidate);
    if (stat === null) continue;
    if (stat.isSymbolicLink() || !stat.isFile() || stat.uid !== uid()) throw new DeviceError("forbidden", "private database required");
  }
}
export function sealDatabase(path: string): void {
  chmodSync(path, 0o600);
  privateFile(path);
}

/**
 * A TLS identity held in memory. The private key is a private field: it is not enumerable, not part of
 * JSON and not shown by `util.inspect`.
 */
export class TlsIdentity {
  readonly #keyPem: string;
  constructor(readonly certPem: string, keyPem: string, readonly fingerprint: string) {
    this.#keyPem = keyPem;
    Object.freeze(this);
  }
  get keyPem(): string { return this.#keyPem; }
  toJSON(): { fingerprint: string } { return { fingerprint: this.fingerprint }; }
  [inspect.custom](): { fingerprint: string } { return this.toJSON(); }
}
/**
 * Loads `cert.pem` + `key.pem` from a private directory. The key must match the certificate. Lab and tests
 * use synthetic temporary identities; production key storage (Keychain/Secure Enclave) is an explicit gate.
 */
export function loadIdentity(dir: string): TlsIdentity {
  privateDirectory(dir, false);
  const certPath = join(dir, "cert.pem");
  const keyPath = join(dir, "key.pem");
  privateFile(keyPath);
  const certStat = statOrNull(certPath);
  if (!certStat || certStat.isSymbolicLink() || !certStat.isFile() || certStat.uid !== uid()) throw new DeviceError("forbidden", "certificate file required");
  try {
    const certPem = readFileSync(certPath, "utf8");
    const keyPem = readFileSync(keyPath, "utf8");
    const cert = new X509Certificate(certPem);
    if (!cert.checkPrivateKey(createPrivateKey(keyPem))) throw new DeviceError("invalid_input", "key does not match certificate");
    return new TlsIdentity(certPem, keyPem, fingerprintDer(cert.raw));
  } catch (error) {
    if (error instanceof DeviceError) throw error;
    throw new DeviceError("invalid_input", "identity unreadable");
  }
}
