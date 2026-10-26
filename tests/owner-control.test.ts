// Owner control socket: real Unix server/client on private temp dirs, a live HostStore writer fence, an in-memory admin
// port for protocol cases and the live AppClientServices admin with a synthetic Node TLS client for the pairing flow.
// No accounts, remote network or real secrets; the generated pairing code stays in memory and is never printed.
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { HostError, HostStore } from "@dexter/hub";
import {
  OWNER_CONTROL_PROTOCOL, OwnerControlServer, canonicalJson, encodeFrame, validateOwnerControlOptions,
  type OwnerAppClientAdminPort, type OwnerPendingClaim,
} from "../packages/cli/src/owner-control.js";
import { ownerControlRequest, runOwnerControlCli } from "../packages/cli/src/owner-control-client.js";
import { appLab, call } from "./app-client-lab.js";

const FP = "a".repeat(64), OTHER_FP = "b".repeat(64);
const SYNTHETIC_CODE = "S".repeat(43);

function privateRoot(t: TestContext): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dexter-oc-")));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function fakeAdmin() {
  const calls: string[] = [];
  const claims: OwnerPendingClaim[] = [{ claimId: "ccl_one", kind: "pair", role: "client-ios", scopes: ["chat.read"], deviceId: null,
    clientFingerprint: FP, name: "Lab phone", expiresAt: 2_000_000_000_000 }];
  let failReject = false;
  const port: OwnerAppClientAdminPort = {
    pairingBundle(input) {
      calls.push(`offer:${canonicalJson(input)}`);
      return { protocol: "dexter-app-client-v1", installationId: "host_lab", hostUrl: "https://127.0.0.1:1", hostCertificateDER: "AA==",
        hostFingerprint: OTHER_FP, offerId: "cof_lab", kind: input.kind, role: input.kind === "pair" ? input.role : "client-mac",
        scopes: input.kind === "pair" ? input.scopes : [], deviceId: input.kind === "rotate" ? input.deviceId : null, expiresAt: 1, code: SYNTHETIC_CODE };
    },
    pendingClaims() { calls.push("list"); return claims; },
    approveClaim(id) { calls.push(`approve:${id}`); return { deviceId: "dev_lab", fingerprint: FP }; },
    rejectClaim(id) { calls.push(`reject:${id}`); if (failReject) throw new HostError("conflict", "x"); },
    cancelOffer(id) { calls.push(`cancel:${id}`); },
  };
  return { calls, port, failRejects() { failReject = true; } };
}
async function lab(t: TestContext, options: { requestTimeoutMs?: number } = {}) {
  const root = privateRoot(t);
  const store = new HostStore({ dataDir: join(root, "host") });
  const admin = fakeAdmin();
  const socketPath = join(root, "ctl", "owner.sock");
  const server = new OwnerControlServer({ socketPath, ...options },
    { admin: () => admin.port, assertWriter: () => { store.withWriterLease(() => undefined); }, installationId: store.hostId });
  assert.equal(await server.start(), socketPath);
  t.after(async () => { await server.close(); store.close(); });
  return { root, store, admin, socketPath, server };
}
/** Sends raw bytes; resolves with the decoded response payload, or null when the server closed without one. */
function raw(path: string, bytes: Buffer, hold?: Promise<void>): Promise<unknown> {
  return new Promise((resolve) => {
    const socket = connect({ path });
    const chunks: Buffer[] = [];
    socket.on("data", (c: Buffer) => chunks.push(c));
    socket.on("error", () => {});
    socket.on("close", () => {
      const all = Buffer.concat(chunks);
      resolve(all.length >= 4 ? JSON.parse(all.subarray(4).toString("utf8")) : null);
    });
    socket.on("connect", () => { if (hold) void hold.then(() => socket.write(bytes)); else socket.write(bytes); });
  });
}
function framed(text: string | Buffer): Buffer {
  const body = typeof text === "string" ? Buffer.from(text, "utf8") : text;
  const header = Buffer.alloc(4); header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}
const envelope = (op: string, args: unknown): unknown => ({ args, op, protocol: OWNER_CONTROL_PROTOCOL });
function io() {
  const out = { stdout: "", stderr: "" };
  return { out, io: { stdout: (s: string) => { out.stdout += s; }, stderr: (s: string) => { out.stderr += s; } } };
}

test("configuration is pure and closed: bad paths and fields refuse without touching the filesystem", (t) => {
  const root = privateRoot(t);
  for (const socketPath of ["relative.sock", `${root}/a/../b.sock`, `${root}/x/`, `${root}/${"n".repeat(120)}.sock`, `${root}/bad name.sock`, `${root}/a\0b`, "/"]) {
    assert.throws(() => validateOwnerControlOptions({ socketPath }), HostError, socketPath);
  }
  assert.throws(() => validateOwnerControlOptions({ socketPath: `${root}/c/s.sock`, requestTimeoutMs: 10 }), HostError);
  assert.throws(() => validateOwnerControlOptions({ socketPath: `${root}/c/s.sock`, listen: "0.0.0.0" } as never), HostError);
  new OwnerControlServer({ socketPath: join(root, "c", "s.sock") }, { admin: () => fakeAdmin().port, assertWriter: () => {}, installationId: "host_x" });
  assert.equal(existsSync(join(root, "c")), false, "construction creates nothing");
});

test("start creates a private 0700 dir and 0600 socket; close removes only what it created", async (t) => {
  const l = await lab(t);
  assert.equal(lstatSync(join(l.root, "ctl")).mode & 0o777, 0o700);
  const st = lstatSync(l.socketPath);
  assert.ok(st.isSocket()); assert.equal(st.mode & 0o777, 0o600);
  const outcome = await ownerControlRequest(l.socketPath, { op: "status", args: {} });
  assert.deepEqual(outcome, { kind: "response", response: { ok: true, protocol: OWNER_CONTROL_PROTOCOL,
    result: { status: "ready", installationId: l.store.hostId, pendingClaims: 1 } } });
  await l.server.close();
  assert.equal(existsSync(l.socketPath), false);
  assert.equal(existsSync(join(l.root, "ctl")), false);
  await assert.rejects(l.server.start(), HostError, "a closed server never restarts");
});

test("close removes the socket it created but preserves an unrelated file or socket that replaced the path", async (t) => {
  // net.Server.close() unlinks whatever pathname libuv bound; the listener must never be bound to the advertised path.
  for (const kind of ["file", "socket"] as const) {
    const l = await lab(t);
    const bystander = kind === "socket" ? createServer() : null;
    rmSync(l.socketPath);
    if (bystander) await new Promise<void>(r => bystander.listen({ path: l.socketPath }, () => r()));
    else writeFileSync(l.socketPath, "unrelated");
    const before = lstatSync(l.socketPath);
    l.server.stopAdmission();
    await l.server.close();
    assert.equal(existsSync(l.socketPath), true, `${kind}: the unrelated replacement survives close`);
    const after = lstatSync(l.socketPath);
    assert.equal(after.ino, before.ino, `${kind}: replacement untouched`);
    assert.equal(after.isSocket(), kind === "socket");
    if (kind === "file") assert.equal(readFileSync(l.socketPath, "utf8"), "unrelated");
    assert.equal(readdirSync(join(l.root, "ctl")).length, 1, `${kind}: only the replacement remains; the directory is not removed`);
    if (bystander) await new Promise<void>(r => bystander.close(() => r()));
  }
});

test("a failed start leaves nothing it did not create: no private bind name, no unrelated entry", async (t) => {
  const root = privateRoot(t);
  const ports = { admin: () => fakeAdmin().port, assertWriter: () => {}, installationId: "host_x" };
  mkdirSync(join(root, "ctl"), { mode: 0o700 });
  writeFileSync(join(root, "ctl", "owner.sock"), "stale");
  await assert.rejects(new OwnerControlServer({ socketPath: join(root, "ctl", "owner.sock") }, ports).start(), HostError);
  assert.deepEqual(readdirSync(join(root, "ctl")), ["owner.sock"]);
  assert.equal(readFileSync(join(root, "ctl", "owner.sock"), "utf8"), "stale");
  // Admission stopped before the start settles: the instance is rolled back and the directory it created is removed.
  const early = new OwnerControlServer({ socketPath: join(root, "fresh", "owner.sock") }, ports);
  const starting = early.start();
  early.stopAdmission();
  await assert.rejects(starting, HostError);
  await early.close();
  assert.equal(existsSync(join(root, "fresh")), false);
});

test("startup fails closed on existing entries, symlinks and non-private dirs, and unlinks nothing", async (t) => {
  const root = privateRoot(t);
  const ports = { admin: () => fakeAdmin().port, assertWriter: () => {}, installationId: "host_x" };
  mkdirSync(join(root, "d1"), { mode: 0o700 });
  writeFileSync(join(root, "d1", "owner.sock"), "stale");
  await assert.rejects(new OwnerControlServer({ socketPath: join(root, "d1", "owner.sock") }, ports).start(), HostError);
  assert.equal(readFileSync(join(root, "d1", "owner.sock"), "utf8"), "stale", "existing entry untouched");
  mkdirSync(join(root, "real"), { mode: 0o700 });
  symlinkSync(join(root, "real"), join(root, "link"));
  await assert.rejects(new OwnerControlServer({ socketPath: join(root, "link", "owner.sock") }, ports).start(), HostError);
  assert.ok(lstatSync(join(root, "link")).isSymbolicLink());
  mkdirSync(join(root, "shared"), { mode: 0o750 }); chmodSync(join(root, "shared"), 0o750);
  await assert.rejects(new OwnerControlServer({ socketPath: join(root, "shared", "owner.sock") }, ports).start(), HostError);
  assert.equal(existsSync(join(root, "shared", "owner.sock")), false);
  // A stale socket from a crashed host is also refused, never removed.
  mkdirSync(join(root, "d2"), { mode: 0o700 });
  symlinkSync("/nonexistent", join(root, "d2", "owner.sock"));
  await assert.rejects(new OwnerControlServer({ socketPath: join(root, "d2", "owner.sock") }, ports).start(), HostError);
  assert.ok(lstatSync(join(root, "d2", "owner.sock")).isSymbolicLink());
});

test("framing and schema are strict: non-canonical, ambiguous or widened requests never reach the backend", async (t) => {
  const l = await lab(t);
  const status = canonicalJson(envelope("status", {}));
  const refusals: Buffer[] = [
    framed(JSON.stringify(envelope("status", {}), null, 1)),
    framed(`{"args":{},"op":"claims.list","op":"status","protocol":"${OWNER_CONTROL_PROTOCOL}"}`),
    framed(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(status)])),
    framed(Buffer.concat([Buffer.from(status.slice(0, -1)), Buffer.from([0xff, 0x7d])])),
    framed(canonicalJson(envelope("shell", { cmd: "id" }))),
    framed(canonicalJson({ ...envelope("status", {}) as object, ownerId: "own_x" })),
    framed(canonicalJson(envelope("offer.create", { kind: "pair", role: "client-ios", scopes: ["chat.read"], principal: "x" }))),
    framed(canonicalJson(envelope("offer.create", { kind: "pair", role: "agent-mac", scopes: [] }))),
    framed(canonicalJson(envelope("offer.create", { kind: "pair", role: "client-ios", scopes: ["chat.write", "chat.read"] }))),
    framed(canonicalJson(envelope("offer.create", { kind: "pair", role: "client-ios", scopes: ["admin"] }))),
    framed(canonicalJson(envelope("offer.create", { kind: "pair", role: "client-ios" }))),
    framed(canonicalJson(envelope("claim.approve", { claimId: "ccl_one" }))),
    framed(canonicalJson(envelope("claim.approve", { claimId: "ccl_one", clientFingerprint: FP, code: SYNTHETIC_CODE }))),
    framed(canonicalJson({ args: {}, op: "status", protocol: "dexter-owner-control-v0" })),
  ];
  for (const bytes of refusals) {
    assert.deepEqual(await raw(l.socketPath, bytes), { error: { code: "invalid_request", effect: "none" }, ok: false, protocol: OWNER_CONTROL_PROTOCOL });
  }
  const header = Buffer.alloc(4); header.writeUInt32BE(70_000, 0);
  assert.equal(await raw(l.socketPath, header), null, "oversized length is cut without a reply");
  assert.equal(await raw(l.socketPath, Buffer.concat([framed(status), Buffer.from("x")])), null, "trailing bytes");
  assert.equal(await raw(l.socketPath, Buffer.alloc(4)), null, "empty frame");
  assert.deepEqual(l.admin.calls, [], "no backend call for any refused request");
});

test("closed operations bind owner intent: explicit scopes, exact claim pin, no grants, unknown effect after invocation", async (t) => {
  const l = await lab(t);
  const offer = await ownerControlRequest(l.socketPath, { op: "offer.create", args: { kind: "pair", role: "client-mac", scopes: [] } });
  assert.equal(offer.kind === "response" && offer.response.ok && offer.response.result.code, SYNTHETIC_CODE);
  assert.equal(l.admin.calls[0], `offer:${canonicalJson({ kind: "pair", role: "client-mac", scopes: [] })}`);
  const mismatch = await ownerControlRequest(l.socketPath, { op: "claim.approve", args: { claimId: "ccl_one", clientFingerprint: OTHER_FP } });
  assert.deepEqual(mismatch.kind === "response" && mismatch.response, { ok: false, protocol: OWNER_CONTROL_PROTOCOL, error: { code: "fingerprint_mismatch", effect: "none" } });
  const missing = await ownerControlRequest(l.socketPath, { op: "claim.approve", args: { claimId: "ccl_two", clientFingerprint: FP } });
  assert.deepEqual(missing.kind === "response" && missing.response.ok === false && missing.response.error, { code: "not_found", effect: "none" });
  assert.equal(l.admin.calls.filter(c => c.startsWith("approve")).length, 0);
  const approved = await ownerControlRequest(l.socketPath, { op: "claim.approve", args: { claimId: "ccl_one", clientFingerprint: FP } });
  assert.deepEqual(approved.kind === "response" && approved.response.ok && approved.response.result,
    { deviceId: "dev_lab", clientFingerprint: FP, kind: "pair", role: "client-ios", scopes: ["chat.read"], grantsCreated: 0 });
  l.admin.failRejects();
  const rejected = await ownerControlRequest(l.socketPath, { op: "claim.reject", args: { claimId: "ccl_one" } });
  assert.deepEqual(rejected.kind === "response" && rejected.response.ok === false && rejected.response.error, { code: "conflict", effect: "unknown" });
  const cancelled = await ownerControlRequest(l.socketPath, { op: "offer.cancel", args: { offerId: "cof_lab" } });
  assert.deepEqual(cancelled.kind === "response" && cancelled.response.ok && cancelled.response.result, { offerId: "cof_lab", status: "cancelled" });
});

test("admission is checked after the last await: a request completed after stopAdmission is refused, new connections fail", async (t) => {
  const l = await lab(t);
  let release!: () => void;
  const hold = new Promise<void>(r => { release = r; });
  const frame = encodeFrame(envelope("offer.create", { kind: "pair", role: "client-ios", scopes: ["chat.read"] }));
  const pending = raw(l.socketPath, frame, hold);
  await new Promise(r => setTimeout(r, 50));
  l.server.stopAdmission();
  release();
  assert.deepEqual(await pending, { error: { code: "closing", effect: "none" }, ok: false, protocol: OWNER_CONTROL_PROTOCOL });
  assert.deepEqual(l.admin.calls, []);
  assert.deepEqual(await ownerControlRequest(l.socketPath, { op: "status", args: {} }), { kind: "not_sent" });
});

test("close drains every admitted connection before resolving; the deadline bounds a silent client", async (t) => {
  const l = await lab(t, { requestTimeoutMs: 800 });
  const socket = connect({ path: l.socketPath });
  socket.on("error", () => {});
  await new Promise<void>(r => socket.once("connect", () => r()));
  socket.write(Buffer.from([0, 0]));
  await new Promise(r => setTimeout(r, 50));
  let closed = false;
  const started = Date.now();
  const closing = l.server.close().then(() => { closed = true; });
  await new Promise(r => setTimeout(r, 200));
  assert.equal(closed, false, "an admitted connection keeps close pending");
  // The private dir this instance created stays until drained.
  assert.equal(existsSync(join(l.root, "ctl")), true, "created directory kept until drained");
  await closing;
  assert.ok(Date.now() - started >= 500, "resolved by the absolute deadline, not early");
  assert.equal(existsSync(l.socketPath), false);
  assert.equal(existsSync(join(l.root, "ctl")), false);
  socket.destroy();
});

test("the canonical writer fence is checked per request; a second HostStore is refused while control works", async (t) => {
  const l = await lab(t);
  assert.throws(() => new HostStore({ dataDir: join(l.root, "host") }), (e: unknown) => e instanceof HostError && e.code === "host_locked");
  const ok = await ownerControlRequest(l.socketPath, { op: "claims.list", args: {} });
  assert.equal(ok.kind === "response" && ok.response.ok, true);
  l.store.close();
  const fenced = await ownerControlRequest(l.socketPath, { op: "offer.create", args: { kind: "pair", role: "client-ios", scopes: [] } });
  assert.deepEqual(fenced.kind === "response" && fenced.response.ok === false && fenced.response.error, { code: "host_locked", effect: "none" });
  assert.equal(l.admin.calls.filter(c => c.startsWith("offer")).length, 0);
});

test("CLI: code only to an exclusive 0600 file or explicit stdout; no code flag; strict usage", async (t) => {
  const l = await lab(t);
  const s = ["--owner-control-socket", l.socketPath];
  const outDir = join(l.root, "out"); mkdirSync(outDir, { mode: 0o700 });
  const file = join(outDir, "bundle.json");
  const a = io();
  assert.equal(await runOwnerControlCli(["offer", ...s, "--role", "client-ios", "--scope", "chat.write", "--scope", "chat.read", "--out", file], a.io), 0);
  assert.equal(lstatSync(file).mode & 0o777, 0o600);
  assert.equal((JSON.parse(readFileSync(file, "utf8")) as { code: string }).code, SYNTHETIC_CODE);
  assert.ok(!a.out.stdout.includes(SYNTHETIC_CODE) && a.out.stderr === "", "summary carries no code");
  assert.equal(l.admin.calls.at(-1), `offer:${canonicalJson({ kind: "pair", role: "client-ios", scopes: ["chat.read", "chat.write"] })}`);
  const calls = l.admin.calls.length;
  const b = io();
  assert.equal(await runOwnerControlCli(["offer", ...s, "--role", "client-ios", "--no-scopes", "--out", file], b.io), 1, "no overwrite");
  symlinkSync(join(outDir, "elsewhere"), join(outDir, "link.json"));
  assert.equal(await runOwnerControlCli(["offer", ...s, "--role", "client-ios", "--no-scopes", "--out", join(outDir, "link.json")], b.io), 1, "no symlink");
  assert.equal(existsSync(join(outDir, "elsewhere")), false);
  assert.equal(l.admin.calls.length, calls, "refused output never creates an offer");
  for (const argv of [["offer", ...s, "--role", "client-ios", "--out", join(outDir, "x.json")], ["offer", ...s, "--role", "client-ios", "--no-scopes"],
    ["offer", ...s, "--role", "client-ios", "--no-scopes", "--stdout", "--out", join(outDir, "y.json")], ["approve", "ccl_one", ...s],
    ["offer", ...s, "--code", "x"], ["claims", ...s, "--scope", "chat.read"], ["shell", ...s], ["status"]]) {
    assert.equal(await runOwnerControlCli(argv, io().io), 2, argv.join(" "));
  }
  assert.equal(l.admin.calls.length, calls);
  const c = io();
  assert.equal(await runOwnerControlCli(["offer", ...s, "--role", "client-mac", "--no-scopes", "--stdout"], c.io), 0);
  assert.equal(c.out.stdout.split("\n").length, 2, "exactly one bundle line");
  const d = io();
  assert.equal(await runOwnerControlCli(["approve", "ccl_one", "--fingerprint", OTHER_FP, ...s], d.io), 1);
  assert.match(d.out.stderr, /fingerprint_mismatch/);
});

test("a lost answer after handoff is unknown for mutations, never retried", async (t) => {
  const root = privateRoot(t);
  mkdirSync(join(root, "stub"), { mode: 0o700 });
  const path = join(root, "stub", "owner.sock");
  let requests = 0;
  const stub = createServer(socket => { socket.once("data", () => { requests++; socket.destroy(); }); });
  await new Promise<void>(r => stub.listen(path, () => r()));
  chmodSync(path, 0o600);
  t.after(() => new Promise<void>(r => stub.close(() => r())));
  const a = io();
  assert.equal(await runOwnerControlCli(["approve", "ccl_one", "--fingerprint", FP, "--owner-control-socket", path], a.io), 3);
  assert.match(a.out.stderr, /"effect": "unknown"/);
  const b = io();
  assert.equal(await runOwnerControlCli(["claims", "--owner-control-socket", path], b.io), 1);
  assert.match(b.out.stderr, /"effect": "none"/);
  assert.equal(requests, 2, "one request per command");
});

test("live AppClientAdmin: owner offer -> TLS claim -> owner approve over the socket, same writer, no grants", async (t) => {
  const l = await appLab(t);
  // Canonical path: the lab root may sit under a symlinked tmpdir (/var -> /private/var), which is refused.
  const socketPath = join(realpathSync(l.root), "ctl", "owner.sock");
  const control = new OwnerControlServer({ socketPath }, { admin: () => l.services.admin,
    assertWriter: () => { l.store.withWriterLease(() => undefined); }, installationId: l.store.hostId });
  await control.start();
  t.after(() => control.close());
  const s = ["--owner-control-socket", socketPath];
  const outDir = join(realpathSync(l.root), "out"); mkdirSync(outDir, { mode: 0o700 });
  const file = join(outDir, "bundle.json");
  const offer = io();
  assert.equal(await runOwnerControlCli(["offer", ...s, "--role", "client-ios", "--scope", "chat.read", "--out", file], offer.io), 0);
  const bundle = JSON.parse(readFileSync(file, "utf8")) as { offerId: string; code: string; hostUrl: string; hostFingerprint: string; installationId: string; scopes: string[] };
  rmSync(file);
  assert.ok(!offer.out.stdout.includes(bundle.code) && !offer.out.stderr.includes(bundle.code));
  assert.deepEqual([bundle.hostUrl, bundle.hostFingerprint, bundle.installationId, bundle.scopes], [l.trust.url, l.host.fingerprint, l.store.hostId, ["chat.read"]]);
  const phone = l.identity("phone");
  const claimed = await call(l.trust, phone, "POST", "/app-client/v1/pair/claim", { offerId: bundle.offerId, code: bundle.code, name: "Lab iPhone" });
  assert.equal(claimed.status, 200);
  const listed = io();
  assert.equal(await runOwnerControlCli(["claims", ...s], listed.io), 0);
  const [claim] = (JSON.parse(listed.out.stdout) as { items: { claimId: string; clientFingerprint: string; role: string; scopes: string[] }[] }).items;
  assert.deepEqual([claim!.claimId, claim!.clientFingerprint, claim!.role, claim!.scopes], [claimed.json.claimId, phone.fingerprint, "client-ios", ["chat.read"]]);
  assert.equal(await runOwnerControlCli(["approve", claim!.claimId, "--fingerprint", l.host.fingerprint, ...s], io().io), 1, "wrong pin refused");
  const approve = io();
  assert.equal(await runOwnerControlCli(["approve", claim!.claimId, "--fingerprint", phone.fingerprint, ...s], approve.io), 0);
  assert.equal((JSON.parse(approve.out.stdout) as { grantsCreated: number }).grantsCreated, 0);
  const status = await call(l.trust, phone, "POST", "/app-client/v1/pair/status", { claimId: claimed.json.claimId });
  assert.equal(status.json.status, "approved");
  assert.equal(l.store.summary().counts.grants, 0, "approval creates no grant");
  assert.throws(() => new HostStore({ dataDir: join(l.root, "host") }), (e: unknown) => e instanceof HostError && e.code === "host_locked");
  // Replay of the spent offer through the TLS channel stays refused; cancel of it is a no-op on the backend.
  assert.equal((await call(l.trust, l.identity("other"), "POST", "/app-client/v1/pair/claim", { offerId: bundle.offerId, code: bundle.code, name: "x" })).status, 403);
  assert.equal(await runOwnerControlCli(["cancel", bundle.offerId, ...s], io().io), 0);
});
