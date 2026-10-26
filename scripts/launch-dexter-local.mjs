#!/usr/bin/env node
// Developer launcher: validates prerequisites, then opens an explicit Dexter.app with a per-process
// local-host launch configuration. The app (not this script) starts and supervises its own loopback host.
// It never builds, installs or downloads anything and never touches defaults, TCC, Keychain or login items.
// Mac local mode is an optional development host; the user-owned VPS remains the canonical product host.
import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { parseArgs } from "node:util";

const USAGE = `Usage: node scripts/launch-dexter-local.mjs --app ABS/Dexter.app --cli ABS/packages/cli/dist/index.js --data-dir ABS_DIR
  [--node ABS_NODE] [--port 4317] [--enable-engines] [--enable-agenda] [--dry-run]
--enable-engines runs real Claude/Codex CLIs against your subscription; it is off unless passed.`;

function fail(message) {
  process.stderr.write(`launch-dexter-local: ${message}\n`);
  process.exit(1);
}

function absolute(name, value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")
    || value.split("/").some((part) => part === ".." || part === ".")) fail(`--${name} must be an absolute path without . or .. segments.`);
  return path.normalize(value).replace(/\/+$/, "") || "/";
}

let values;
try {
  ({ values } = parseArgs({ options: {
    app: { type: "string" }, cli: { type: "string" }, "data-dir": { type: "string" }, node: { type: "string" },
    port: { type: "string", default: "4317" }, "enable-engines": { type: "boolean", default: false }, "enable-agenda": {type:"boolean",default:false},
    "dry-run": { type: "boolean", default: false }, help: { type: "boolean", default: false },
  }, strict: true }));
} catch { fail(`invalid arguments.\n${USAGE}`); }
if(values["enable-agenda"]&&!values["enable-engines"])fail("--enable-agenda requires --enable-engines.");
if (values.help) { process.stdout.write(USAGE + "\n"); process.exit(0); }
if (process.platform !== "darwin") fail("macOS only.");

const app = absolute("app", values.app);
const cli = absolute("cli", values.cli);
const dataDir = absolute("data-dir", values["data-dir"]);
// Default: the Node that runs this launcher (already absolute and caller-chosen).
const node = absolute("node", values.node ?? process.execPath);
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1024 || port > 65535) fail("--port must be 1024–65535.");

// App bundle: an explicit .app directory, opened by path (never by name lookup).
if (!app.endsWith(".app") || !existsSync(path.join(app, "Contents", "Info.plist")) || !statSync(app).isDirectory())
  fail("--app must point to an existing .app bundle.");

// Node: executable, satisfying the repository engine range (node:sqlite).
try { accessSync(node, constants.X_OK); } catch { fail("--node is not an executable file."); }
let nodeVersion = "";
try { nodeVersion = execFileSync(node, ["--version"], { encoding: "utf8", timeout: 5_000 }).trim(); } catch { fail("--node could not report its version."); }
const [major, minor] = nodeVersion.replace(/^v/, "").split(".").map(Number);
if (!(major === 24 && minor >= 14)) fail(`Node ${nodeVersion || "unknown"} does not satisfy >=24.14.0 <25.`);

// CLI entry: a built file. Not rebuilt here; a stale build is the caller's responsibility.
if (!cli.endsWith(".js") || !existsSync(cli) || !statSync(cli).isFile()) fail("--cli must be the built CLI entry (packages/cli/dist/index.js). Build it first.");

// Data directory: new (parent exists), empty, or an existing Dexter store. Never an arbitrary directory.
if (existsSync(dataDir)) {
  const info = lstatSync(dataDir);
  if (!info.isDirectory()) fail("--data-dir exists and is not a plain directory.");
  const entries = readdirSync(dataDir);
  const isStore = entries.includes("dexter.sqlite") && lstatSync(path.join(dataDir, "dexter.sqlite")).isFile();
  if (entries.length > 0 && !isStore) fail("--data-dir is not empty and is not a Dexter store; choose a dedicated directory.");
} else if (!existsSync(path.dirname(dataDir)) || !statSync(path.dirname(dataDir)).isDirectory()) {
  fail("--data-dir parent does not exist.");
}

// Port: refuse if anything already listens; an unknown listener is never stopped or reused.
const free = await new Promise((resolve) => {
  const server = createServer();
  server.once("error", () => resolve(false));
  server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(() => resolve(true)));
});
if (!free) fail(`port ${port} on 127.0.0.1 is in use by another process; it was left untouched.`);

const env = {
  DEXTER_LOCAL_HOST_START: "1",
  DEXTER_LOCAL_HOST_NODE: node,
  DEXTER_LOCAL_HOST_CLI: cli,
  DEXTER_LOCAL_HOST_DATA_DIR: dataDir,
  DEXTER_LOCAL_HOST_PORT: String(port),
  DEXTER_LOCAL_HOST_ENABLE_ENGINES: values["enable-engines"] ? "1" : "0",
  DEXTER_LOCAL_HOST_ENABLE_AGENDA: values["enable-agenda"] ? "1" : "0",
};
// `-n` starts a fresh instance so the environment applies; `--env` scopes it to that process only.
const args = ["-n", "-a", app, ...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`])];

process.stdout.write(JSON.stringify({ status: values["dry-run"] ? "preflight_only" : "opening", app, node: nodeVersion, cli, dataDir,
  address: `http://127.0.0.1:${port}`, engines: values["enable-engines"] ? "enabled (subscription usage)" : "disabled" }, null, 2) + "\n");
if (values["dry-run"]) process.exit(0);
try { execFileSync("/usr/bin/open", args, { stdio: "inherit", timeout: 15_000 }); } catch { fail("macOS could not open the app."); }
