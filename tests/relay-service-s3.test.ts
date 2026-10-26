import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer as httpsServer, type Server as HttpsServer } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { RelayEndpoint } from "@dexter/relay";
import { PinnedRelayTransport, RelayTransportError } from "../packages/relay-service/src/index.js";
import { createRelayMemoryCa, createRelayMemoryLeaf } from "./fixtures/relay-memory-tls.js";

const PKI = (() => {
  const ca = createRelayMemoryCa("relay-s3-test-ca");
  return { ca: Buffer.from(ca.identity.certPem), leaf: createRelayMemoryLeaf("host", "relay-s3-server", ca, ["DNS:relay.test"]) };
})();
test.after(() => { PKI.leaf.key.fill(0); PKI.ca.fill(0); });

async function server(handler: (req: IncomingMessage, res: ServerResponse, body: () => string) => void): Promise<{
  port: number; seen: () => string[]; close(): Promise<void>
}> {
  const bodies: string[] = [];
  const s: HttpsServer = httpsServer({ key: PKI.leaf.key, cert: PKI.leaf.cert, minVersion: "TLSv1.3", maxVersion: "TLSv1.3", ALPNProtocols: ["http/1.1"] }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.once("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      bodies.push(body);
      handler(req, res, () => body);
    });
    req.resume();
  });
  await new Promise<void>(resolve => s.listen(0, "127.0.0.1", resolve));
  return { port: (s.address() as AddressInfo).port, seen: () => [...bodies],
    close: () => new Promise<void>(resolve => { s.closeAllConnections(); s.close(() => resolve()); }) };
}
function client(port: number): PinnedRelayTransport {
  return new PinnedRelayTransport({ host: "127.0.0.1", port, servername: "relay.test", ca: PKI.ca, leafSha256: PKI.leaf.pin, timeoutMs: 5_000 });
}
function response(res: ServerResponse): void {
  const body = Buffer.from(JSON.stringify({ deliveries: [{ cursor: 1, receiptId: "s3-receipt", envelope: {
    version: 1, installationId: "s3-install", ownerId: "s3-owner", messageId: "s3-message", senderId: "s3-sender",
    senderGeneration: 1, senderKeyId: "s3-sender-key", recipientId: "s3-device", recipientGeneration: 1,
    recipientKeyId: "s3-key", type: "command", sequence: 1, createdAt: 1, expiresAt: 2,
    ephemeralPublicKey: "ephemeral", nonce: "nonce", ciphertext: "ciphertext", tag: "tag", signature: "signature",
  } }], cursor: 1 }));
  res.writeHead(200, { "content-type": "application/json", "content-length": body.length });
  res.end(body);
}
function expectTransport(code: string, outcome: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof RelayTransportError, String(error));
    assert.deepEqual([error.code, error.outcome], [code, outcome]);
    return true;
  };
}
async function errorCode(promise: Promise<unknown>): Promise<string> {
  try { await promise; return "resolved"; }
  catch (error) { return error instanceof RelayTransportError ? `${error.code}/${error.outcome}` : `other/${String(error)}`; }
}

test("S3 S1: permanent close wins before poll inspects caller data; open serialization stays trap-free and sends its captured snapshot", async () => {
  const fake = await server((_req, res) => response(res));
  const closed = client(fake.port);
  const open = client(fake.port);
  let getterCalls = 0, proxyCalls = 0, toJSONCalls = 0, symbolHookCalls = 0;
  const getterPoll = Object.defineProperty({ marker: "getter" }, "limit", {
    enumerable: true,
    get() { getterCalls++; return 11; },
  });
  const proxyPoll = new Proxy({ limit: 11 }, {
    get(target, key, receiver) { proxyCalls++; return Reflect.get(target, key, receiver); },
    ownKeys(target) { proxyCalls++; return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, key) { proxyCalls++; return Reflect.getOwnPropertyDescriptor(target, key); },
    getPrototypeOf(target) { proxyCalls++; return Reflect.getPrototypeOf(target); },
  });
  const toJSONPoll = { limit: 2, toJSON() { toJSONCalls++; return { limit: 2 }; } };
  const symbolHookPoll = { limit: 2, [Symbol.toPrimitive]() { symbolHookCalls++; return "poll"; } };
  try {
    await closed.close();
    const closedGetter = await errorCode(closed.poll(getterPoll as never));
    const closedProxy = await errorCode(closed.poll(proxyPoll as never));
    const closedToJSON = await errorCode(closed.poll(toJSONPoll as never));
    const closedSymbol = await errorCode(closed.poll(symbolHookPoll as never));
    assert.deepEqual([closedGetter, closedProxy, closedToJSON, closedSymbol, getterCalls, proxyCalls, toJSONCalls, symbolHookCalls], [
      "closed/not_sent", "closed/not_sent", "closed/not_sent", "closed/not_sent", 0, 0, 0, 0,
    ], "closed admission must win without getter, Proxy, toJSON, or symbol hook effects");
    assert.deepEqual([getterCalls, proxyCalls], [0, 0], "closed admission precedes any caller getter or Proxy trap");
    assert.deepEqual(fake.seen(), [], "closed invalid inputs never open a TCP/TLS request");

    const openGetter = await errorCode(open.poll(getterPoll as never));
    const openProxy = await errorCode(open.poll(proxyPoll as never));
    const openToJSON = await errorCode(open.poll(toJSONPoll as never));
    const openSymbol = await errorCode(open.poll(symbolHookPoll as never));
    assert.deepEqual([openGetter, openProxy, openToJSON, openSymbol, getterCalls, proxyCalls, toJSONCalls, symbolHookCalls], [
      "invalid_input/not_sent", "invalid_input/not_sent", "invalid_input/not_sent", "invalid_input/not_sent", 0, 0, 0, 0,
    ], "open safe serialization rejects accessors, Proxies, toJSON, and symbol hooks without invoking them");
    await assert.rejects(open.poll({ limit: 11 } as never), expectTransport("poll_limit", "not_sent"));
    assert.deepEqual(fake.seen(), [], "an oversized primitive limit is rejected before handoff");

    const endpoint = new RelayEndpoint({ ownerId: "s3-owner", installationId: "s3-install", deviceId: "s3-device", generation: 1, keyId: "s3-key" });
    const request = endpoint.poll({ requestId: randomUUID(), issuedAt: Date.now(), after: 0, limit: 2 });
    const acceptedBytes = JSON.stringify(request);
    const pending = open.poll(request);
    request.after = 77;
    request.limit = 0;
    request.requestId = "mutated";
    const result = await pending;
    assert.equal(result.deliveries.length, 1, "the accepted limit of 2 permits a response even after caller mutation to 0");
    assert.equal(result.cursor, 1);
    assert.deepEqual(fake.seen(), [acceptedBytes], "wire bytes equal the single closed snapshot accepted before caller mutation");
    assert.equal(getterCalls, 0);
    assert.equal(proxyCalls, 0);
  } finally {
    await open.close();
    await closed.close();
    await fake.close();
  }
});
