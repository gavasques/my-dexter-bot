import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { inspect } from 'node:util';
import { canonicalJson } from '@dexter/hub';
import { assertOpenVikingBotIdentity, validateOpenVikingUserKey, openVikingOrigin, type OpenVikingBotIdentity, type OpenVikingCredentialCustody } from '@dexter/context';

export class OpenVikingCustodyError extends Error {
  constructor(readonly code: 'locked' | 'invalid_input' | 'conflict' | 'unavailable') {
    super('OpenViking private custody ' + code); this.name = 'OpenVikingCustodyError';
  }
}
export interface OpenVikingCustodyBinding { hostId: string; ownerId: string; origin: string }
type Envelope = { schema: 'dexter.openviking-private-custody/1'; binding: OpenVikingCustodyBinding;
  nonce: string; ciphertext: string; tag: string };
type PrivateValues = { administrativeKey: string; users: Record<string, string> };
const refuse = (code: OpenVikingCustodyError['code']): never => { throw new OpenVikingCustodyError(code); };
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const MAX_BYTES = 2 * 1024 * 1024;
const printable = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum && /^[\x21-\x7e]+$/.test(value);

/** Private host file contains authenticated ciphertext only. The 32-byte wrapping key comes from
 * the native app's scoped Keychain through its own inherited pipe, never HTTP, argv or environment.
 * This is software custody. JS credential strings and crypto internal copies cannot be guaranteed erased. */
export class OpenVikingPrivateCustody implements OpenVikingCredentialCustody {
  readonly #file: string;
  readonly #binding: Readonly<OpenVikingCustodyBinding>;
  #key: Buffer | null = null;
  #values: PrivateValues | null = null;
  #head: string | null = null;
  constructor(file: string, binding: OpenVikingCustodyBinding) {
    if (!isAbsolute(file) || file.includes('\0') || !printable(binding.hostId, 128) || !printable(binding.ownerId, 128)) refuse('invalid_input');
    this.#file = resolve(file); this.#binding = Object.freeze({ ...binding, origin: openVikingOrigin(binding.origin) });
  }
  toJSON(): { configured: boolean; unlocked: boolean; custody: string } {
    return { configured: this.#head !== null, unlocked: this.#key !== null, custody: 'native_keychain_wrapped_ciphertext' };
  }
  [inspect.custom](): string { return 'OpenVikingPrivateCustody(' + (this.#key ? 'unlocked' : 'locked') + ')'; }
  #directory(): void {
    const p = dirname(this.#file), st = lstatSync(p);
    if (!st.isDirectory() || st.isSymbolicLink() || realpathSync(p) !== p || (st.mode & 0o077) !== 0
      || !process.getuid || st.uid !== process.getuid()) refuse('unavailable');
  }
  #read(): Buffer {
    this.#directory();
    const st = lstatSync(this.#file);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || (st.mode & 0o077) !== 0
      || st.uid !== process.getuid!() || st.size > MAX_BYTES || realpathSync(this.#file) !== this.#file) refuse('unavailable');
    const fd = openSync(this.#file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd);
      if (opened.dev !== st.dev || opened.ino !== st.ino || opened.size !== st.size || !opened.isFile()) refuse('conflict');
      return readFileSync(fd);
    } finally { closeSync(fd); }
  }
  #decode(bytes: Buffer, key: Buffer): PrivateValues {
    let plaintext: Buffer | undefined;
    try {
      const envelope = JSON.parse(bytes.toString('utf8')) as Envelope;
      if (Object.keys(envelope).sort().join(',') !== 'binding,ciphertext,nonce,schema,tag'
        || envelope.schema !== 'dexter.openviking-private-custody/1'
        || canonicalJson(envelope.binding as unknown as Parameters<typeof canonicalJson>[0]) !== canonicalJson(this.#binding)
        || !/^[a-f0-9]{24}$/.test(envelope.nonce) || !/^[a-f0-9]{32}$/.test(envelope.tag)
        || typeof envelope.ciphertext !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(envelope.ciphertext)) refuse('conflict');
      const encoded = Buffer.from(envelope.ciphertext, 'base64');
      if (encoded.toString('base64') !== envelope.ciphertext) refuse('conflict');
      const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'hex'));
      cipher.setAAD(Buffer.from(canonicalJson(this.#binding))); cipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
      plaintext = Buffer.concat([cipher.update(encoded), cipher.final()]); encoded.fill(0);
      const values = JSON.parse(plaintext.toString('utf8')) as PrivateValues;
      if (Object.keys(values).sort().join(',') !== 'administrativeKey,users'
        || !printable(values.administrativeKey, 4096) || !values.users || typeof values.users !== 'object'
        || Array.isArray(values.users) || Object.keys(values.users).length > 2048
        || Object.entries(values.users).some(([k, v]) => !/^bot1_[a-f0-9]{2,256}$/.test(k) || !printable(v, 2048))) refuse('conflict');
      return values;
    } catch { return refuse('conflict'); } finally { plaintext?.fill(0); }
  }
  /** Existing files are load-only. Missing does not silently create a new account/identity. Consumes owned key bytes. */
  unlock(key: Buffer): void {
    try {
      if (!Buffer.isBuffer(key) || key.length !== 32 || this.#key) refuse('invalid_input');
      const bytes = this.#read();
      try { this.#values = this.#decode(bytes, key); this.#head = digest(bytes); this.#key = Buffer.from(key); }
      finally { bytes.fill(0); }
    } catch (e) { if (e instanceof OpenVikingCustodyError) throw e; refuse('unavailable'); }
    finally { if (Buffer.isBuffer(key)) key.fill(0); }
  }
  /** Explicit owner provisioning only. Destination must not exist; never overwrite, rotate or adopt another file. */
  create(key: Buffer, administrativeKey: string): void {
    let began = false;
    try {
      if (!Buffer.isBuffer(key) || key.length !== 32 || !printable(administrativeKey, 4096) || this.#key) refuse('invalid_input');
      this.#directory(); if (existsSync(this.#file)) refuse('conflict');
      began = true; this.#key = Buffer.from(key); this.#values = { administrativeKey, users: {} }; this.#head = null;
      this.#persist(true);
    } catch (e) { if (began) this.lock(); if (e instanceof OpenVikingCustodyError) throw e; refuse('unavailable'); }
    finally { if (Buffer.isBuffer(key)) key.fill(0); }
  }
  administrativeKey(): string { if (!this.#key || !this.#values) return refuse('locked'); return this.#values.administrativeKey; }
  /** Presence/shape only, never exposes key bytes or grants backend authority. */
  hasBotCredential(identity: OpenVikingBotIdentity): boolean {
    try {
      this.#identity(identity);
      const key = this.#values!.users[identity.userId];
      if (key === undefined) return false;
      validateOpenVikingUserKey(key, identity);
      return true;
    } catch { return false; }
  }
  async load(identity: OpenVikingBotIdentity): Promise<string | null> {
    this.#identity(identity); const key = this.#values!.users[identity.userId] ?? null;
    if (key !== null) try { validateOpenVikingUserKey(key, identity); } catch { refuse('conflict'); }
    return key;
  }
  async save(identity: OpenVikingBotIdentity, userKey: string): Promise<void> {
    this.#identity(identity); try { validateOpenVikingUserKey(userKey, identity); } catch { refuse('invalid_input'); }
    const prior = this.#values!.users[identity.userId];
    if (prior !== undefined) { if (prior !== userKey) refuse('conflict'); return; }
    this.#values!.users[identity.userId] = userKey;
    try { this.#persist(false); } catch (error) { delete this.#values!.users[identity.userId]; throw error; }
  }
  #identity(identity: OpenVikingBotIdentity): void {
    if (!this.#key || !this.#values) refuse('locked');
    try { assertOpenVikingBotIdentity(identity); } catch { refuse('invalid_input'); }
    if (identity.workspaceId !== this.#binding.hostId) refuse('conflict');
  }
  #persist(createOnly: boolean): void {
    if (!this.#key || !this.#values) refuse('locked');
    const wrappingKey = this.#key;
    if (wrappingKey === null) refuse('locked');
    this.#directory();
    const plaintext = Buffer.from(JSON.stringify(this.#values));
    if (plaintext.length > MAX_BYTES / 2) { plaintext.fill(0); refuse('invalid_input'); }
    let bytes: Buffer | undefined, temp: string | undefined, published = false;
    try {
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', wrappingKey!, nonce);
      cipher.setAAD(Buffer.from(canonicalJson(this.#binding)));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const envelope: Envelope = { schema: 'dexter.openviking-private-custody/1', binding: { ...this.#binding },
        nonce: nonce.toString('hex'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('hex') };
      ciphertext.fill(0); bytes = Buffer.from(JSON.stringify(envelope));
      if (createOnly) {
        const fd = openSync(this.#file, 'wx', 0o600);
        try { writeFileSync(fd, bytes); fsyncSync(fd); published = true; } finally { closeSync(fd); }
      } else {
        const old = this.#read(); try { if (digest(old) !== this.#head) refuse('conflict'); } finally { old.fill(0); }
        temp = this.#file + '.new-' + randomBytes(12).toString('hex'); const fd = openSync(temp, 'wx', 0o600);
        try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
        const current = this.#read(); try { if (digest(current) !== this.#head) refuse('conflict'); } finally { current.fill(0); }
        renameSync(temp, this.#file); temp = undefined; published = true;
      }
      this.#head = digest(bytes);
      const fd = openSync(dirname(this.#file), 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
    } catch (e) {
      // If publication happened, verify exact bytes before returning. A lost durability ACK is never a blind second write.
      if (published && bytes) {
        try { const observed = this.#read(); try { if (digest(observed) === digest(bytes)) { this.#head = digest(bytes); return; } } finally { observed.fill(0); } } catch { /* fixed error below */ }
      }
      if (e instanceof OpenVikingCustodyError) throw e; refuse('unavailable');
    } finally { plaintext.fill(0); bytes?.fill(0); if (temp) try { unlinkSync(temp); } catch { /* own temp only */ } }
  }
  lock(): void { this.#key?.fill(0); this.#key = null; this.#values = null; }
}
