#!/usr/bin/env node
// Local packager: assembles a relocatable Dexter.app that can start its optional local-development
// host from Finder/Dock. Inputs are explicit and caller-built; this script never builds, downloads,
// installs, signs, launches or touches defaults/TCC/Keychain/login items. Account CLIs and login state
// stay user-owned. An explicitly supplied public Antigravity ACP runtime may be bundled;
// its private login/profile is never copied. The user-owned VPS remains the
// canonical product host; this bundle only arms the Mac's optional loopback development host.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync, chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync,
  readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { parseArgs } from "node:util";

const USAGE = `Usage: node scripts/package-local-desktop.mjs --app ABS/Dexter.app --node ABS/node
  --cli ABS/packages/cli/dist/index.js --out ABS/NEW/Dexter\\ Local.app
  [--node-license ABS/LICENSE] [--port 4317] [--store-name local-host] [--enable-engines] [--dry-run]
  [--identity-helper ABS/dexter-device-identity]
  [--cua-helper ABS/dexter-cua-helper]
  [--antigravity-runtime ABS/DIR-WITH-agy_acp_server.par-AND-localharness_external]
--node must be a standalone Node 24 (>=24.14) that links only macOS system libraries (official nodejs.org build).
--enable-engines lets the packaged host run selected official CLIs on your subscription; it is off unless passed.
A saved Settings choice (Allow local engines) overrides it at the next opening or with Apply Now.
Helpers/node is a relative alias of Helpers/dexter-node for user CLI wrappers that use #!/usr/bin/env node.
--identity-helper copies a caller-built native identity helper to Helpers/dexter-device-identity and writes inert
mac-agent-helper.json so Settings can guide Mac agent setup; without it the package keeps the old layout.
--cua-helper copies a caller-built screen-control helper and inert metadata; starting it, calibration and
surface consent remain explicit local actions. It never grants tools or requests macOS permissions here.
The output is unsigned for the added content; sign it yourself before use.`;

const SCHEMA = "dexter.local-host-launch/1";
const NODE_REL = "Helpers/dexter-node";
// Internal alias only: placed first on the host's controlled PATH when local engines are allowed.
const NODE_ALIAS_REL = "Helpers/node";
// Optional native identity helper: copied, never built or invoked here.
const IDENTITY_HELPER_REL = "Helpers/dexter-device-identity";
const CUA_HELPER_REL = "Helpers/dexter-cua-helper";
const ANTIGRAVITY_REL = "Helpers/Antigravity";
const ANTIGRAVITY_FILES = ["agy_acp_server.par", "localharness_external"];
const HOST_REL = "Resources/DexterLocalHost";
const MAX_FILES = 20_000;
// Never copied, whatever the source: secrets, auth state, stores, logs, caches, VCS and build metadata.
const DENY_FILE = /^(\.env.*|\.npmrc|\.yarnrc.*|\.netrc|.*\.(pem|key|p8|p12|sqlite|sqlite-wal|sqlite-shm|db|log|map|tsbuildinfo)|auth.*\.json|credentials.*|.*\.d\.[cm]?ts|\.DS_Store)$/i;
// Input-app refusal: secret/state/log names only (build artefacts such as .DS_Store are not data).
const APP_DENY_FILE = /^(\.env.*|\.npmrc|\.yarnrc.*|\.netrc|.*\.(pem|key|p8|p12|sqlite|sqlite-wal|sqlite-shm|db|log)|auth.*\.json|credentials.*)$/i;
const DENY_DIR = new Set(["node_modules", ".git", ".cache", ".turbo", "coverage", ".claude", ".codex", "logs", "tmp", "test", "tests", "__tests__"]);
// Published npm trees can contain development-only scripts whose dependencies are deliberately
// absent in production. Drop those files from third-party packages, retaining runtime closure checks.
const THIRD_PARTY_DEV_DIR = new Set(["benchmark", "benchmarks"]);
const THIRD_PARTY_DEV_FILE = /^(?:eslint\.config\.[cm]?js|\.eslintrc(?:\..*)?)$/;
// AJV's optional native RE2 adapter is not used by the MCP SDK's default validator (native RegExp).
// Keep this omission version-scoped. A future runtime import of the adapter fails the closure check;
// do not bundle the native addon or silently ignore an unresolved import.
const OPTIONAL_RUNTIME_OMISSIONS = new Map([["ajv@8.17.1", new Set(["dist/runtime/re2.js"])]]);
const SYSTEM_LIB = /^\/(usr\/lib|System\/Library)\//;

function fail(message) {
  process.stderr.write(`package-local-desktop: ${message}\n`);
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
    app: { type: "string" }, node: { type: "string" }, cli: { type: "string" }, out: { type: "string" },
    "node-license": { type: "string" }, port: { type: "string", default: "4317" },
    "store-name": { type: "string", default: "local-host" }, "enable-engines": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false }, help: { type: "boolean", default: false },
    "identity-helper": { type: "string" },
    "cua-helper": { type: "string" },
    "antigravity-runtime": { type: "string" },
  }, strict: true }));
} catch { fail(`invalid arguments.\n${USAGE}`); }
if (values.help) { process.stdout.write(USAGE + "\n"); process.exit(0); }
if (process.platform !== "darwin") fail("macOS only.");
for (const key of ["app", "node", "cli", "out"]) if (!values[key]) fail(`--${key} is required.\n${USAGE}`);

const app = absolute("app", values.app);
const node = absolute("node", values.node);
const cli = absolute("cli", values.cli);
const out = absolute("out", values.out);
const identityHelper = values["identity-helper"] === undefined ? null : absolute("identity-helper", values["identity-helper"]);
const cuaHelper = values["cua-helper"] === undefined ? null : absolute("cua-helper", values["cua-helper"]);
for (const [name, helper] of [["identity-helper", identityHelper], ["cua-helper", cuaHelper]]) {
  if (helper === null) continue;
  const s = lstatSync(helper, { throwIfNoEntry: false });
  if (!s || !s.isFile() || (s.mode & 0o111) === 0 || (s.mode & 0o022) !== 0 || s.size < 1 || s.size > 64 * 1024 * 1024)
    fail(`--${name} must be a regular executable file (not a symlink, not group/world-writable, at most 64 MiB).`);
}
const antigravityRuntime = values["antigravity-runtime"] === undefined ? null : absolute("antigravity-runtime", values["antigravity-runtime"]);
if (antigravityRuntime !== null) {
  const directory = lstatSync(antigravityRuntime, { throwIfNoEntry: false });
  if (!directory?.isDirectory() || directory.isSymbolicLink()) fail("--antigravity-runtime must be a real directory.");
  const entries = readdirSync(antigravityRuntime);
  if (entries.length !== ANTIGRAVITY_FILES.length || entries.some(name => !ANTIGRAVITY_FILES.includes(name)))
    fail("--antigravity-runtime must contain exactly the two public vendor executables; no profiles or credentials.");
  for (const name of ANTIGRAVITY_FILES) {
    const file = lstatSync(path.join(antigravityRuntime, name));
    if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o111) === 0 || (file.mode & 0o022) !== 0 || file.size < 1 || file.size > 300 * 1024 * 1024)
      fail("Antigravity runtime input must be a regular, non-writable executable of at most 300 MiB.");
  }
}
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1024 || port > 65535) fail("--port must be 1024–65535.");
const storeName = values["store-name"];
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(storeName)) fail("--store-name must be 1–64 of [A-Za-z0-9._-], starting alphanumeric.");

// --- App bundle: explicit fresh build output, not already packaged. The whole tree is copied, so it
// is preflighted first: prohibited data or a symlink leaving the bundle is refused, never sanitized.
if (!app.endsWith(".app") || !existsSync(path.join(app, "Contents", "Info.plist")) || !lstatSync(app).isDirectory())
  fail("--app must point to an existing .app bundle directory (not a symlink).");
if (lexists(path.join(app, "Contents", NODE_REL)) || lexists(path.join(app, "Contents", NODE_ALIAS_REL))
  || lexists(path.join(app, "Contents", HOST_REL)) || lexists(path.join(app, "Contents", IDENTITY_HELPER_REL))
  || lexists(path.join(app, "Contents", CUA_HELPER_REL)) || lexists(path.join(app, "Contents", ANTIGRAVITY_REL)))
  fail("--app already contains a packaged local host; pass the unmodified build output.");
if (!existsSync(path.join(app, "Contents", "MacOS"))) fail("--app has no Contents/MacOS executable directory.");
// Assembly writes under these: each must be a real directory inside the bundle (or absent, then created).
for (const rel of ["Contents", "Contents/Helpers", "Contents/Resources"]) {
  if (!realDirOrAbsent(path.join(app, rel), rel === "Contents"))
    fail(`--app ${rel} must be a real directory, not a symlink or file; pass an unmodified build output.`);
}
preflightApp(app);

function lexists(file) {
  try { lstatSync(file); return true; } catch { return false; }
}

function realDirOrAbsent(dir, required) {
  if (!lexists(dir)) return !required;
  return lstatSync(dir).isDirectory();
}

function preflightApp(root) {
  const rootReal = realpathSync(root);
  let count = 0;
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const src = path.join(dir, entry.name);
      const rel = path.relative(root, src);
      if (++count > MAX_FILES) fail(`--app has more than ${MAX_FILES} entries; refusing.`);
      if (APP_DENY_FILE.test(entry.name) || (entry.isDirectory() && DENY_DIR.has(entry.name)))
        fail(`--app contains prohibited data (${rel}); rebuild a clean app. Nothing was copied.`);
      if (entry.isSymbolicLink()) {
        // Internal framework links (Versions/Current -> A) are kept; anything absolute or escaping is not.
        const target = readlinkSync(src);
        const lexical = path.resolve(path.dirname(src), target);
        let real = null;
        try { real = realpathSync(src); } catch { /* dangling: lexical check only */ }
        if (path.isAbsolute(target) || !(lexical + "/").startsWith(root + "/")
          || (real !== null && !(real + "/").startsWith(rootReal + "/")))
          fail(`--app contains a symlink leaving the bundle (${rel}); refusing.`);
        continue;
      }
      if (entry.isDirectory()) { visit(src); continue; }
      if (!entry.isFile()) fail(`--app contains a non-regular file (${rel}).`);
    }
  };
  visit(root);
}

// --- Output: fresh path only; never overwrite or merge.
if (!out.endsWith(".app")) fail("--out must end with .app.");
if (existsSync(out)) fail("--out already exists; choose a fresh path (nothing is overwritten).");
if (!existsSync(path.dirname(out)) || !statSync(path.dirname(out)).isDirectory()) fail("--out parent directory does not exist.");
if (out.startsWith(app + "/") || app.startsWith(out + "/")) fail("--out must not be inside --app (or vice versa).");

// --- Node: version, architecture and portable linkage. Not downloaded or replaced.
const nodeInfo = lstatSync(node);
if (!nodeInfo.isFile()) fail("--node must be a regular file (resolve symlinks/shims yourself and pass the real binary).");
try { accessSync(node, constants.X_OK); } catch { fail("--node is not executable."); }
let nodeVersion = "";
try { nodeVersion = execFileSync(node, ["--version"], { encoding: "utf8", timeout: 5_000 }).trim(); } catch { fail("--node could not report its version (is it a shim?)."); }
const [major, minor] = nodeVersion.replace(/^v/, "").split(".").map(Number);
if (!(major === 24 && minor >= 14)) fail(`Node ${nodeVersion || "unknown"} does not satisfy >=24.14.0 <25.`);

function tool(name, args) {
  try { return execFileSync(`/usr/bin/${name}`, args, { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }); }
  catch { fail(`/usr/bin/${name} failed or is unavailable; install Xcode Command Line Tools to verify Node linkage.`); }
}
const archs = tool("lipo", ["-archs", node]).trim().split(/\s+/);
const hostArch = process.arch === "arm64" ? "arm64" : "x86_64";
if (!archs.includes(hostArch)) fail(`--node architectures (${archs.join(", ")}) do not include this Mac's ${hostArch}.`);
// Dependency lines are indented; per-file/per-architecture header lines (universal binaries) are not.
const linkage = tool("otool", ["-L", node]).split("\n").filter((line) => /^\s+\S/.test(line))
  .map((line) => line.trim().split(" (compatibility")[0]);
const foreign = [...new Set(linkage.filter((lib) => !SYSTEM_LIB.test(lib)))];
if (foreign.length) {
  fail(`--node is not portable: it links ${foreign.slice(0, 4).join(", ")}${foreign.length > 4 ? ", …" : ""}.\n`
    + "  A Homebrew/MacPorts Node depends on external dylibs. Download the official macOS tarball from nodejs.org"
    + " (node-v24.x-darwin-<arch>.tar.gz), verify its SHASUMS256, and pass its bin/node plus LICENSE. Nothing was downloaded here.");
}
const nodeLicense = values["node-license"] ? absolute("node-license", values["node-license"]) : path.resolve(path.dirname(node), "..", "LICENSE");
if (!existsSync(nodeLicense) || !lstatSync(nodeLicense).isFile()) fail("Node LICENSE not found next to bin/ (official layout); pass --node-license.");

// --- Host packages: resolve the CLI's runtime dependency closure through Node's resolution rules.
const cliReal = realpathSync(cli);
if (!cliReal.endsWith(".js") || !statSync(cliReal).isFile()) fail("--cli must be the built CLI entry (packages/cli/dist/index.js). Build it first.");
const cliPackageDir = path.dirname(path.dirname(cliReal));
const cliManifest = readJson(path.join(cliPackageDir, "package.json"), "CLI package.json");
if (cliManifest.name !== "@dexter/cli" || path.relative(cliPackageDir, cliReal) !== path.join("dist", "index.js"))
  fail("--cli must be <@dexter/cli>/dist/index.js.");

function readJson(file, label) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { fail(`${label} could not be read as JSON.`); }
}

function resolvePackageDir(fromDir, name) {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name, "package.json");
    if (existsSync(candidate)) return realpathSync(path.dirname(candidate));
    if (dir === path.dirname(dir)) return null;
  }
}

const packages = new Map(); // name -> { dir, manifest, workspace }
const queue = [{ name: cliManifest.name, dir: cliPackageDir, from: "(entry)" }];
while (queue.length) {
  const { name, dir, from } = queue.shift();
  const manifest = readJson(path.join(dir, "package.json"), `${name} package.json`);
  if (manifest.name !== name) fail(`${dir} declares ${manifest.name}, expected ${name} (required by ${from}).`);
  const existing = packages.get(name);
  if (existing) {
    if (existing.manifest.version !== manifest.version)
      fail(`${name} resolves to both ${existing.manifest.version} and ${manifest.version}; a flat bundle cannot hold both.`);
    continue;
  }
  const workspace = name.startsWith("@dexter/");
  packages.set(name, { dir, manifest, workspace });
  if (manifest.scripts && ["preinstall", "install", "postinstall"].some((k) => manifest.scripts[k]) && !workspace)
    fail(`${name} has install scripts (possible native build); not packaged.`);
  const peerMeta = manifest.peerDependenciesMeta ?? {};
  const required = { ...(manifest.dependencies ?? {}),
    ...Object.fromEntries(Object.entries(manifest.peerDependencies ?? {}).filter(([peer]) => !peerMeta[peer]?.optional)) };
  for (const dep of Object.keys(required)) {
    const depDir = resolvePackageDir(dir, dep);
    if (!depDir) fail(`${dep} (required by ${name}) is not installed; run pnpm install and build first.`);
    queue.push({ name: dep, dir: depDir, from: name });
  }
  for (const [opt] of Object.entries(manifest.optionalDependencies ?? {}))
    if (resolvePackageDir(dir, opt)) fail(`${name} has installed optional dependency ${opt}; review it before packaging.`);
}

// --- File selection: workspace packages ship package.json + dist; third-party packages ship their
// published files. Licenses kept; maps, declarations, nested node_modules and denied names dropped.
const files = []; // { src, rel }
const warnings = [];
const omittedFiles = [];
function walk(root, relRoot, label, thirdParty = null) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const src = path.join(root, entry.name);
    const rel = path.join(relRoot, entry.name);
    if (entry.isSymbolicLink()) fail(`${label} contains a symlink (${rel}); not packaged.`);
    if (entry.isDirectory()) {
      if (!DENY_DIR.has(entry.name) && !(thirdParty && THIRD_PARTY_DEV_DIR.has(entry.name)))
        walk(src, rel, label, thirdParty);
      continue;
    }
    if (!entry.isFile()) fail(`${label} contains a non-regular file (${rel}).`);
    if (entry.name.endsWith(".node") || entry.name === "binding.gyp") fail(`${label} contains a native addon (${rel}); not portable.`);
    // This exact compiled workspace module is credential-handling CODE, not a credential store.
    // Keep the denial for every other credentials.* file, including all JSON/auth state.
    const credentialCode = label === "@dexter/connectors" && thirdParty === null
      && rel === path.join("app", "node_modules", "@dexter/connectors", "dist", "mcp", "credentials.js");
    if (DENY_FILE.test(entry.name) && !credentialCode) continue;
    if (thirdParty) {
      const packageRelative = path.relative(thirdParty.root, src).split(path.sep).join("/");
      if (THIRD_PARTY_DEV_FILE.test(entry.name)) continue;
      if (OPTIONAL_RUNTIME_OMISSIONS.get(thirdParty.id)?.has(packageRelative)) {
        omittedFiles.push({ package: thirdParty.id, file: packageRelative, reason: "unused optional native RE2 adapter" });
        continue;
      }
    }
    files.push({ src, rel });
    if (files.length > MAX_FILES) fail(`more than ${MAX_FILES} files selected; refusing (is a whole checkout being picked up?).`);
  }
}
const licenseFiles = [];
for (const [name, { dir, manifest, workspace }] of packages) {
  const dest = path.join("app", "node_modules", name);
  if (workspace) {
    const dist = path.join(dir, "dist");
    if (!existsSync(dist) || !lstatSync(dist).isDirectory()) fail(`${name} has no dist/; build the workspace first.`);
    const sanitized = Object.fromEntries(Object.entries(manifest)
      .filter(([key]) => ["name", "version", "private", "type", "main", "exports", "imports", "bin", "dependencies", "peerDependencies", "license"].includes(key)));
    files.push({ json: sanitized, rel: path.join(dest, "package.json") });
    walk(dist, path.join(dest, "dist"), name);
    const srcDir = path.join(dir, "src");
    if (existsSync(srcDir) && newest(srcDir) > newest(dist)) warnings.push(`${name}: src/ is newer than dist/ (stale build?)`);
  } else {
    walk(dir, dest, name, { root: dir, id: `${name}@${manifest.version}` });
    const license = readdirSync(dir).find((f) => /^(licen[cs]e|copying|notice)(\..*)?$/i.test(f));
    if (license) licenseFiles.push(`${name}@${manifest.version}: ${path.join(dest, license)}`);
    else warnings.push(`${name}@${manifest.version}: no license file shipped by the package (declared: ${manifest.license ?? "none"})`);
  }
}

function newest(dir) {
  let latest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) latest = Math.max(latest, newest(p));
    else if (entry.isFile()) latest = Math.max(latest, statSync(p).mtimeMs);
  }
  return latest;
}

// --- Closure check: every static import/require resolves inside the selected set. Specifiers built
// at runtime cannot be seen here; the host's own startup remains the authoritative check.
const selected = new Set(files.map((f) => f.rel));
const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
const SPECIFIER = [
  /\bimport\s*(?:[\w$*{}\s,]+?\s*from\s*)?["']([^"'\n]+)["']/g,
  /\bexport\s*(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*["']([^"'\n]+)["']/g,
  /\bimport\(\s*["']([^"'\n]+)["']\s*\)/g,
  /\brequire\(\s*["']([^"'\n]+)["']\s*\)/g,
];
const unresolved = [];
for (const file of files) {
  if (!file.src || !/\.[cm]?js$/.test(file.rel)) continue;
  const owner = ownerOf(file.rel);
  const declared = new Set([owner.name, ...Object.keys(owner.manifest.dependencies ?? {}), ...Object.keys(owner.manifest.peerDependencies ?? {})]);
  const text = stripComments(readFileSync(file.src, "utf8"));
  for (const [index, pattern] of SPECIFIER.entries()) for (const match of text.matchAll(pattern)) {
    const spec = match[1];
    const mode = index === 3 ? "require" : "import";
    if (builtins.has(spec) || spec.startsWith("node:")) continue;
    if (spec.startsWith(".")) {
      const target = path.normalize(path.join(path.dirname(file.rel), spec));
      if (![target, `${target}.js`, path.join(target, "index.js")].some((t) => selected.has(t)))
        unresolved.push(`${file.rel} -> ${spec}`);
      continue;
    }
    if (spec.startsWith("/") || /^[a-z]+:/i.test(spec)) { unresolved.push(`${file.rel} -> ${spec} (absolute/URL)`); continue; }
    const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
    if (!packages.has(pkg)) unresolved.push(`${file.rel} -> ${spec} (package not in bundle)`);
    else if (owner.workspace && !declared.has(pkg)) unresolved.push(`${file.rel} -> ${spec} (undeclared dependency of ${owner.name})`);
    else {
      const target = resolvePackageSpecifier(pkg, `.${spec.slice(pkg.length)}`, mode);
      if (!target) unresolved.push(`${file.rel} -> ${spec} (${mode}: no supported exports/main mapping)`);
      else if (!selected.has(target)) unresolved.push(`${file.rel} -> ${spec} (${mode}: ${target} is not a bundled file)`);
    }
  }
}
if (unresolved.length) fail(`import closure incomplete:\n  ${unresolved.slice(0, 20).join("\n  ")}`);

// Node's package resolution for one bundled package, using the metadata that ships (sanitized for
// workspace packages). Returns the bundle-relative file or null; unsupported shapes fail closed.
function resolvePackageSpecifier(name, subpath, mode) {
  const { manifest, workspace } = packages.get(name);
  const shipped = workspace ? files.find((f) => f.json && f.json.name === name).json : manifest;
  const root = path.join("app", "node_modules", name);
  const inPackage = (target) => {
    if (typeof target !== "string" || !target.startsWith("./")) return null;
    const segments = target.slice(2).split(/[\\/]/);
    if (segments.some((p) => p === "" || p === "." || p === ".." || p === "node_modules")) return null;
    return path.join(root, ...segments);
  };
  if (shipped.exports !== undefined) {
    let exp = shipped.exports;
    const conditional = exp !== null && typeof exp === "object" && !Array.isArray(exp);
    if (typeof exp === "string" || Array.isArray(exp) || (conditional && !Object.keys(exp).some((k) => k.startsWith("."))))
      exp = { ".": exp };
    else if (!conditional || Object.keys(exp).some((k) => !k.startsWith("."))) return null; // mixed keys are invalid
    if (Object.hasOwn(exp, subpath) && !subpath.includes("*")) return inPackage(conditionTarget(exp[subpath], mode, null) ?? null);
    let best = null;
    for (const key of Object.keys(exp)) {
      const star = key.indexOf("*");
      if (star < 0 || key.indexOf("*", star + 1) >= 0) continue;
      const [prefix, suffix] = [key.slice(0, star), key.slice(star + 1)];
      if (subpath.length < key.length || !subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
      if (!best || prefix.length > best.prefix.length || (prefix.length === best.prefix.length && key.length > best.key.length))
        best = { key, prefix, match: subpath.slice(prefix.length, subpath.length - suffix.length) };
    }
    return best ? inPackage(conditionTarget(exp[best.key], mode, best.match) ?? null) : null;
  }
  // No exports: legacy main for the package root; exact files for subpaths (require adds .js/index.js).
  const candidates = [];
  if (subpath === ".") {
    const main = typeof shipped.main === "string" ? `./${shipped.main.replace(/^\.\//, "")}` : null;
    if (main) candidates.push(main, `${main}.js`, `${main}.json`, `${main}/index.js`);
    candidates.push("./index.js");
  } else {
    candidates.push(subpath);
    if (mode === "require") candidates.push(`${subpath}.js`, `${subpath}.json`, `${subpath}/index.js`);
  }
  for (const candidate of candidates) {
    const rel = inPackage(candidate.replace(/\/+$/, ""));
    if (rel && selected.has(rel)) return rel;
  }
  return inPackage(candidates[0]) ?? null;
}

// Conditions Node 24 applies without flags. Object order decides and an unmatched nested object
// falls through (undefined); null is an explicit exclusion. Arrays take the first usable entry.
function conditionTarget(value, mode, match) {
  if (typeof value === "string") return match === null ? value : value.split("*").join(match);
  if (Array.isArray(value)) {
    for (const item of value) { const t = conditionTarget(item, mode, match); if (t) return t; }
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const active = new Set(["node", mode, "module-sync", "default"]);
  for (const [key, inner] of Object.entries(value)) {
    if (key.startsWith(".")) return null;
    if (!active.has(key)) continue;
    const t = conditionTarget(inner, mode, match);
    if (t !== undefined) return t;
  }
  return undefined;
}

function ownerOf(rel) {
  const parts = rel.split(path.sep).slice(2); // app/node_modules/...
  const name = parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
  return { name, ...packages.get(name) };
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

// --- Launch metadata: resource-relative (relocatable). No paths, secrets or accounts from this Mac.
const cliRel = path.join(HOST_REL, "app", "node_modules", "@dexter", "cli", "dist", "index.js");
if (!selected.has(path.join("app", "node_modules", "@dexter", "cli", "dist", "index.js"))) fail("CLI entry was not selected.");
const daemonEntry = path.join("app", "node_modules", "@dexter", "devices", "dist", "daemon-main.js");
if (!selected.has(daemonEntry)) fail("Mac agent daemon entry was not selected; build @dexter/devices first.");
// Separate metadata is deliberately inert: explicit trusted configuration and UI consent are required.
const macAgentLaunch = { schema: "dexter.mac-agent-launch/1", node: NODE_REL,
  daemon: path.join(HOST_REL, daemonEntry), automaticStart: false };
// Separate file keeps mac-agent-launch.json byte-compatible with older packages. Inert: no start, no identity.
const macAgentHelper = identityHelper === null ? null
  : { schema: "dexter.mac-agent-helper/1", helper: IDENTITY_HELPER_REL, automaticStart: false };
const macCuaHelper = cuaHelper === null ? null
  : { schema: "dexter.mac-cua-helper/1", helper: CUA_HELPER_REL, automaticStart: false };
const launch = { schema: SCHEMA, mode: "local-development", node: NODE_REL, cli: cliRel, port,
  enableEngines: values["enable-engines"], storeName };

const antigravityMetadata = antigravityRuntime === null ? null : {
  schema: "dexter.antigravity-runtime/1", command: `${ANTIGRAVITY_REL}/agy_acp_server.par`,
  harness: `${ANTIGRAVITY_REL}/localharness_external`, automaticStart: false,
  source: "Official Google Antigravity ACP runtime; authentication remains user-owned",
};
const totalBytes = files.reduce((sum, f) => sum + (f.src ? statSync(f.src).size : 0), 0) + statSync(node).size + (antigravityRuntime === null ? 0 : ANTIGRAVITY_FILES.reduce((sum, name) => sum + statSync(path.join(antigravityRuntime, name)).size, 0));
const summary = {
  status: values["dry-run"] ? "dry_run_validated" : "packaged",
  out, node: { version: nodeVersion, archs, linkage: "system-only", alias: `${NODE_ALIAS_REL} -> ${path.basename(NODE_REL)} (relative, inside the bundle)` },
  packages: [...packages].map(([name, p]) => `${name}@${p.manifest.version}`).sort(),
  files: files.length + 2, megabytes: Number((totalBytes / 1_048_576).toFixed(1)),
  launch, macAgentLaunch, macAgentHelper, macCuaHelper, antigravityMetadata, dataDir: `~/Library/Application Support/Dexter Local Host/${storeName} (created on first opted-in start; separate from client state)`,
  engines: (launch.enableEngines ? "ENABLED: packaged host may run selected official CLIs on the user's subscription" : "disabled")
    + "; a saved Settings choice overrides this at the next opening or with Apply Now",
  licenses: licenseFiles.length + 1, warnings, omittedFiles,
  signing: "added Helpers/Resources invalidate any existing signature; sign the output before running",
};
if (values["dry-run"]) { process.stdout.write(JSON.stringify(summary, null, 2) + "\n"); process.exit(0); }

// --- Assembly into a private sibling; renamed into place only when complete.
const partial = `${out}.partial-${process.pid}`;
if (existsSync(partial)) fail(`${partial} already exists; remove it first.`);
let created = false;
try {
  created = true; // partial did not exist above, so anything at that path is ours to remove on failure
  execFileSync("/usr/bin/ditto", [app, partial], { stdio: ["ignore", "ignore", "pipe"], timeout: 120_000 });
  const contents = path.join(partial, "Contents");
  const hostRoot = path.join(contents, HOST_REL);
  // Re-check the copy (the input could change after preflight): writes stay inside real directories.
  if (!realDirOrAbsent(contents, true) || !realDirOrAbsent(path.join(contents, "Helpers"), false)
    || !realDirOrAbsent(path.join(contents, "Resources"), false) || lexists(hostRoot) || lexists(path.join(contents, NODE_REL))
    || lexists(path.join(contents, NODE_ALIAS_REL)) || lexists(path.join(contents, IDENTITY_HELPER_REL))
    || lexists(path.join(contents, CUA_HELPER_REL)) || lexists(path.join(contents, ANTIGRAVITY_REL)))
    throw Object.assign(new Error("copied app layout changed"), { code: "ELAYOUT" });
  if (!lexists(path.join(contents, "Helpers"))) mkdirSync(path.join(contents, "Helpers"), { mode: 0o755 });
  if (!lexists(path.join(contents, "Resources"))) mkdirSync(path.join(contents, "Resources"), { mode: 0o755 });
  mkdirSync(hostRoot, { mode: 0o755 });
  copyFileSync(node, path.join(contents, NODE_REL));
  chmodSync(path.join(contents, NODE_REL), 0o755);
  // Relative sibling link: stays inside the bundle when the .app is moved; no second Node copy.
  symlinkSync(path.basename(NODE_REL), path.join(contents, NODE_ALIAS_REL));
  if (realpathSync(path.join(contents, NODE_ALIAS_REL)) !== realpathSync(path.join(contents, NODE_REL)))
    throw Object.assign(new Error("node alias does not resolve to the bundled node"), { code: "EALIAS" });
  const manifestEntries = [];
  for (const file of files) {
    const dest = path.join(hostRoot, file.rel);
    mkdirSync(path.dirname(dest), { recursive: true, mode: 0o755 });
    if (file.json) writeFileSync(dest, JSON.stringify(file.json, null, 2) + "\n", { mode: 0o644 });
    else { copyFileSync(file.src, dest); chmodSync(dest, 0o644); }
    manifestEntries.push([file.rel, sha256(dest)]);
  }
  mkdirSync(path.join(hostRoot, "licenses"), { recursive: true, mode: 0o755 });
  copyFileSync(nodeLicense, path.join(hostRoot, "licenses", "node-LICENSE"));
  writeFileSync(path.join(hostRoot, "app", "package.json"), JSON.stringify({ private: true, type: "module" }, null, 2) + "\n");
  writeFileSync(path.join(hostRoot, "launch.json"), JSON.stringify(launch, null, 2) + "\n", { mode: 0o644 });
  writeFileSync(path.join(hostRoot, "mac-agent-launch.json"), JSON.stringify(macAgentLaunch, null, 2) + "\n", { mode: 0o644 });
  if (macAgentHelper !== null) {
    copyFileSync(identityHelper, path.join(contents, IDENTITY_HELPER_REL));
    chmodSync(path.join(contents, IDENTITY_HELPER_REL), 0o755);
    writeFileSync(path.join(hostRoot, "mac-agent-helper.json"), JSON.stringify(macAgentHelper, null, 2) + "\n", { mode: 0o644 });
  }
  if (macCuaHelper !== null) {
    copyFileSync(cuaHelper, path.join(contents, CUA_HELPER_REL));
    chmodSync(path.join(contents, CUA_HELPER_REL), 0o755);
    writeFileSync(path.join(hostRoot, "mac-cua-helper.json"), JSON.stringify(macCuaHelper, null, 2) + "\n", { mode: 0o644 });
  }
  const antigravityManifest = {};
  if (antigravityMetadata !== null) {
    const target = path.join(contents, ANTIGRAVITY_REL);
    mkdirSync(target, { mode: 0o755 });
    for (const name of ANTIGRAVITY_FILES) {
      copyFileSync(path.join(antigravityRuntime, name), path.join(target, name));
      chmodSync(path.join(target, name), 0o755);
      antigravityManifest[`${ANTIGRAVITY_REL}/${name}`] = sha256(path.join(target, name));
    }
    writeFileSync(path.join(hostRoot, "antigravity-runtime.json"), JSON.stringify(antigravityMetadata, null, 2) + "\n", { mode: 0o644 });
  }
  writeFileSync(path.join(hostRoot, "manifest.json"), JSON.stringify({
    schema: "dexter.local-host-manifest/1", node: { path: NODE_REL, alias: NODE_ALIAS_REL, version: nodeVersion, archs, sha256: sha256(path.join(contents, NODE_REL)) },
    packages: summary.packages, files: Object.fromEntries(manifestEntries), omittedFiles,
    ...(antigravityRuntime === null ? {} : { antigravityRuntime: { files: antigravityManifest, automaticStart: false } }),
    ...(macAgentHelper === null ? {} : { identityHelper: { path: IDENTITY_HELPER_REL, sha256: sha256(path.join(contents, IDENTITY_HELPER_REL)) } }),
    ...(macCuaHelper === null ? {} : { cuaHelper: { path: CUA_HELPER_REL, sha256: sha256(path.join(contents, CUA_HELPER_REL)) } }),
  }, null, 2) + "\n", { mode: 0o644 });
  renameSync(partial, out);
} catch (error) {
  if (created && existsSync(partial)) rmSync(partial, { recursive: true, force: true });
  fail(`assembly failed (${error?.code ?? "error"}); partial output removed. Nothing else was changed.`);
}
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}
