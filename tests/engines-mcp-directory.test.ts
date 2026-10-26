import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCliDriver, MuseMspDriver, isDexterGatewayToolName, type NativeMcpServer } from "@dexter/engines";
const aliases = ["mcp__dexter_gateway__dx_catalog_search", "mcp__dexter_gateway__dx_catalog_describe", "mcp__dexter_gateway__dx_catalog_call"];
const server: NativeMcpServer = { command: process.execPath, args: ["/tmp/dexter-gateway-fixture.js", "/tmp/dexter-gateway-fixture.sock"] };

test("directory aliases are exact first-party entries, never wildcard approval of arbitrary tools", () => {
  for (const name of aliases) { assert.equal(isDexterGatewayToolName(name), true); assert.doesNotThrow(() => new ClaudeCliDriver({ localMcpServer: server, allowedMcpTools: [name] })); assert.doesNotThrow(() => new MuseMspDriver({ localMcpServer: server, allowedMcpTools: [name] })); }
  for (const name of ["mcp__dexter_gateway__dx_catalog_proxy", "mcp__evil__dx_catalog_call", "mcp__dexter_gateway__*", "mcp__dexter_gateway__dx_catalog_call__account", "Bash", "mcp__dexter_gateway__COMPOSIO_MULTI_EXECUTE_TOOL"]) {
    assert.equal(isDexterGatewayToolName(name), false); assert.throws(() => new ClaudeCliDriver({ localMcpServer: server, allowedMcpTools: [name] })); assert.throws(() => new MuseMspDriver({ localMcpServer: server, allowedMcpTools: [name] }));
  }
});

test("actual Claude driver forwards the stable wrapper snapshot and observes only provider tool-result receipts", async t => {
  const dir = await mkdtemp(join(tmpdir(), "dexter-directory-driver-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const script = join(dir, "engine.mjs"), log = join(dir, "argv.json");
  await writeFile(script, `import{writeFileSync}from'node:fs';import{createInterface}from'node:readline';const a=process.argv.slice(2);if(a.includes('--version')){console.log('fixture 2.1.296');process.exit(0)}if(a.includes('auth')){console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai'}));process.exit(0)}writeFileSync(${JSON.stringify(log)},JSON.stringify(a));const s=x=>process.stdout.write(JSON.stringify(x)+'\\n');createInterface({input:process.stdin}).on('line',()=>{const id=a[a.indexOf('--session-id')+1];s({type:'system',subtype:'init',session_id:id,mcp_servers:[{name:'dexter_gateway',status:'connected'}]});s({type:'user',session_id:id,message:{role:'user',content:[{type:'tool_result',tool_use_id:'synthetic',content:JSON.stringify({actionId:'act_directory',requestHash:'b'.repeat(64),status:'succeeded'})}]}});s({type:'result',subtype:'success',result:'synthetic completion',usage:{}})});`);
  const driver = new ClaudeCliDriver({ command: process.execPath, prefixArgs: [script], localMcpServer: server, allowedMcpTools: aliases, requestTimeoutMs: 1000, killGraceMs: 10 });
  const session = await driver.open("thread_synthetic"), events = []; t.after(() => driver.close(session));
  for await (const event of driver.turn(session, "turn_synthetic", "synthetic directory exercise", new AbortController().signal)) events.push(event);
  await driver.close(session); assert.equal(events.at(-1)?.type, "turn.completed");
  const argv = JSON.parse(await readFile(log, "utf8")) as string[]; assert.equal(argv[argv.indexOf("--allowedTools") + 1], aliases.join(",")); assert.equal(argv[argv.indexOf("--tools") + 1], "");
  assert.deepEqual(events.filter(event => event.type === "tool.result.observed"), [{ type: "tool.result.observed", threadId: "thread_synthetic", turnId: "turn_synthetic", actionId: "act_directory", requestHash: "b".repeat(64), status: "succeeded" }]);
});
