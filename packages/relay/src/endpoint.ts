import { createCipheriv, createDecipheriv, createHash, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { inspect } from "node:util";
import { RelayError, MAX_CIPHERTEXT_BYTES, bytes, control, controlBytes, envelope, envelopeBytes, header, pin, publicKey, verifyEnvelope,
  type AckItem, type AckRequest, type DevicePin, type Envelope, type PollRequest, type SignedControl } from "./protocol.js";

function exportPublic(key: KeyObject): string { return key.export({ type: "spki", format: "der" }).toString("base64"); }
function agreement(privateKey: KeyObject, remote: string): Buffer {
  try { return diffieHellman({ privateKey, publicKey: publicKey(remote, "x25519") }); }
  catch { throw new RelayError("forbidden"); }
}
function encryptionKey(shared: Buffer, aad: string, installationId: string): Buffer {
  const salt = createHash("sha256").update(`DEXTER_RELAY_KDF_V1\n${installationId}`).digest();
  return Buffer.from(hkdfSync("sha256", shared, salt, Buffer.from(`DEXTER_RELAY_AEAD_V1\n${aad}`), 32));
}
/** Lab endpoint only. Private keys remain in memory; never hand this object or plaintext to RelayStore. */
export class RelayEndpoint {
  readonly #signing: KeyObject;
  readonly #encryption: KeyObject;
  readonly #pin: Readonly<DevicePin>;
  constructor(identity: { ownerId: string; installationId: string; deviceId: string; generation: number; keyId: string }) {
    const signing = generateKeyPairSync("ed25519"), encryption = generateKeyPairSync("x25519");
    this.#signing = signing.privateKey; this.#encryption = encryption.privateKey;
    this.#pin = Object.freeze(pin({ ...identity, signingPublicKey: exportPublic(signing.publicKey), encryptionPublicKey: exportPublic(encryption.publicKey) }));
  }
  get publicPin(): DevicePin { return { ...this.#pin }; }
  toJSON(): object { return { publicPin: this.#pin }; }
  [inspect.custom](): object { return this.toJSON(); }

  seal(recipientValue: DevicePin, request: { messageId: string; sequence: number; type: Envelope["type"]; createdAt: number; expiresAt: number }, plaintext: Uint8Array): Envelope {
    const recipient = pin(recipientValue), sender = this.#pin;
    if (!(plaintext instanceof Uint8Array) || plaintext.byteLength > MAX_CIPHERTEXT_BYTES) throw new RelayError("invalid_input");
    if (sender.ownerId !== recipient.ownerId || sender.installationId !== recipient.installationId) throw new RelayError("forbidden");
    const ephemeral = generateKeyPairSync("x25519"), nonce = randomBytes(12).toString("base64");
    const base = { version: 1 as const, installationId: sender.installationId, ownerId: sender.ownerId, ...request,
      senderId: sender.deviceId, senderGeneration: sender.generation, senderKeyId: sender.keyId,
      recipientId: recipient.deviceId, recipientGeneration: recipient.generation, recipientKeyId: recipient.keyId,
      ephemeralPublicKey: exportPublic(ephemeral.publicKey), nonce };
    // Validate exact header/limits before consuming plaintext. Signature placeholder is not returned.
    envelope({ ...base, ciphertext: "", tag: Buffer.alloc(16).toString("base64"), signature: Buffer.alloc(64).toString("base64") });
    const aad = header(base), shared = agreement(ephemeral.privateKey, recipient.encryptionPublicKey);
    const key = encryptionKey(shared, aad, sender.installationId);
    try {
      const cipher = createCipheriv("aes-256-gcm", key, bytes(nonce, 12, 12), { authTagLength: 16 }); cipher.setAAD(Buffer.from(aad));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]).toString("base64"), tag = cipher.getAuthTag().toString("base64");
      const e = { ...base, ciphertext, tag, signature: "" };
      e.signature = sign(null, envelopeBytes(e), this.#signing).toString("base64");
      return envelope(e);
    } finally { key.fill(0); shared.fill(0); }
  }
  open(value: unknown, senderValue: DevicePin): Buffer {
    const e = envelope(value), sender = pin(senderValue); verifyEnvelope(e, sender, this.publicPin);
    const aad = header(e), shared = agreement(this.#encryption, e.ephemeralPublicKey);
    const key = encryptionKey(shared, aad, e.installationId);
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, bytes(e.nonce, 12, 12), { authTagLength: 16 });
      decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(bytes(e.tag, 16, 16));
      return Buffer.concat([decipher.update(bytes(e.ciphertext, MAX_CIPHERTEXT_BYTES)), decipher.final()]);
    } catch { throw new RelayError("forbidden"); } finally { key.fill(0); shared.fill(0); }
  }
  poll(request: { requestId: string; issuedAt: number; after: number; limit: number }): PollRequest {
    return this.signed({ ...this.base(request), kind: "poll", after: request.after, limit: request.limit, signature: Buffer.alloc(64).toString("base64") }) as PollRequest;
  }
  ack(request: { requestId: string; issuedAt: number; messages: AckItem[] }): AckRequest {
    return this.signed({ ...this.base(request), kind: "ack", messages: request.messages, signature: Buffer.alloc(64).toString("base64") }) as AckRequest;
  }
  private base(request: { requestId: string; issuedAt: number }) {
    const p = this.#pin; return { version: 1 as const, ownerId: p.ownerId, installationId: p.installationId,
      deviceId: p.deviceId, generation: p.generation, keyId: p.keyId, requestId: request.requestId, issuedAt: request.issuedAt };
  }
  private signed(value: SignedControl): SignedControl {
    const c = control(value); c.signature = sign(null, controlBytes(c), this.#signing).toString("base64"); return c;
  }
}
