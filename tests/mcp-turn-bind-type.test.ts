import assert from "node:assert/strict";
import fs, { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { CapabilityGateway, GatewayError, SyntheticCredentialBroker, prepareMcpTurn } from "@dexter/gateway";
import { HostStore } from "@dexter/hub";

test("a regular-file replacement of the private bind socket is refused before publication", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dexter-bind-type-"));
  const store = new HostStore({ dataDir: dir });
  const gateway = new CapabilityGateway({ store, broker: new SyntheticCredentialBroker(),
    adapter: { async execute() { throw new Error("no adapter calls allowed"); } } });
  t.after(() => { gateway.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const bot = store.createBot({ name: "Bind fixture", profileId: "personal", engine: "claude" });
  const thread = store.createThread(bot.id);
  const { turn } = store.createTurn(thread.id, { clientRequestId: "bind-type", content: "synthetic" });
  store.claimNextTurn(thread.id);
  const issue = gateway.issueCapability.bind(gateway);
  let token = "";
  gateway.issueCapability = (input) => { const issued = issue(input); token = issued.token; return issued; };
  const fence = store.withWriterLease.bind(store);
  let fences = 0;
  let leaseDir = "";
  const makeDir = fs.mkdtempSync;
  const mock = t.mock.method(fs, "mkdtempSync", (prefix: string, options?: { encoding?: BufferEncoding }) => {
    const created = makeDir(prefix, options);
    if (prefix === "/tmp/dx-mcp-") leaseDir = created;
    return created;
  });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  store.withWriterLease = <T>(operation: () => T): T => fence(() => {
    if (++fences === 2) {
      assert.ok(leaseDir);
      const bind = join(leaseDir, "b.sock");
      unlinkSync(bind);
      writeFileSync(bind, "synthetic replacement", { mode: 0o600 });
    }
    return operation();
  });
  await assert.rejects(prepareMcpTurn({ store, gateway, turnId: turn.id,
    wrapperPath: resolve("packages/cli/dist/mcp-stdio.js") }),
    (error: unknown) => error instanceof GatewayError && error.code === "unavailable");
  assert.ok(leaseDir);
  assert.throws(() => gateway.listTools(token));
  // The replacement is at the unpublished bind name; libuv may unlink it on close.
  // No published endpoint is returned, and there is no tool execution.
});
