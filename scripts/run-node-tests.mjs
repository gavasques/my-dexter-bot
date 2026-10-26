#!/usr/bin/env node
// Test-only source builds. No production Keychain executable is ever selected.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const verification = process.argv.slice(2);
if (verification.length > 1 || (verification.length && !['--verify-assets', '--prepare-assets', '--verify-capabilities'].includes(verification[0]))) {
  throw new Error('Usage: node scripts/run-node-tests.mjs [--verify-assets|--prepare-assets|--verify-capabilities]; default runs every emitted Node test at concurrency 4.');
}
if (process.platform !== 'darwin') throw new Error('Node tests require macOS with the selected Xcode Swift toolchain; native cases cannot be skipped.');
if (!/^v24\./.test(process.version) || Number(process.version.split('.')[1]) < 14) throw new Error('Use Node 24 (the package engine); the runner uses process.execPath.');
const work = fs.mkdtempSync(path.join('/private/tmp', 'dexter-tests-'));
fs.chmodSync(work, 0o700);
const source = path.join(work, 'source');
const logs = path.join(work, 'logs');
for (const dir of ['logs', 'home', 'tmp', 'cache', 'config', 'security']) fs.mkdirSync(path.join(work, dir));
const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: path.join(work, 'home'), TMPDIR: `${path.join(work, 'tmp')}/`, NODE_NO_WARNINGS: '1', CLANG_MODULE_CACHE_PATH: path.join(work, 'cache', 'clang') };
const records = [];
let preflight;
let handleAudit;
let browserAsset;
let defaultSelection;
let sourceCopyPins;
let sourceCopyAudit = { status: 'not_captured' };
const capabilityMode = !verification.length || verification[0] === '--verify-capabilities';
const sha = value => createHash('sha256').update(value).digest('hex');
const excluded = new Set(['node_modules', '.git', 'dist', '.test-dist', '.build', '.swiftpm']);
function copy(from, to) {
  const stat = fs.lstatSync(from);
  if (stat.isSymbolicLink()) throw new Error(`Source symlink refused: ${from}`);
  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from)) {
      if (!excluded.has(entry) && !entry.endsWith('.tsbuildinfo')) copy(path.join(from, entry), path.join(to, entry));
    }
  } else if (stat.isFile()) fs.copyFileSync(from, to);
}
// Retain evidence of the bytes actually executed before the owned copy is removed.
// Dependencies/build outputs are separate inputs; never traverse their symlinks here.
function snapshotSourcePins() {
  const files = {};
  const visit = directory => {
    for (const entry of fs.readdirSync(directory).sort()) {
      if (excluded.has(entry) || entry.endsWith('.tsbuildinfo')) continue;
      const file = path.join(directory, entry), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error('Unexpected symlink in copied source.');
      if (stat.isDirectory()) visit(file);
      else if (stat.isFile()) files[path.relative(source, file)] = sha(fs.readFileSync(file));
      else throw new Error('Unexpected special file in copied source.');
    }
  };
  visit(source);
  return files;
}
function dependencies(at) {
  const packageNames = fs.readdirSync(path.join(at, 'packages')).filter(name => fs.lstatSync(path.join(at, 'packages', name)).isDirectory());
  const bind = (from, to) => {
    fs.mkdirSync(to);
    if (fs.existsSync(from)) for (const entry of fs.readdirSync(from)) {
      if (entry === '@dexter' || entry === '.bin') continue;
      fs.symlinkSync(path.join(from, entry), path.join(to, entry));
    }
    fs.mkdirSync(path.join(to, '@dexter'));
    for (const name of packageNames) {
      fs.symlinkSync(path.join(at, 'packages', name), path.join(to, '@dexter', name));
    }
  };
  bind(path.join(root, 'node_modules'), path.join(at, 'node_modules'));
  for (const name of packageNames) {
    bind(path.join(root, 'packages', name, 'node_modules'), path.join(at, 'packages', name, 'node_modules'));
  }
}
function processRows() {
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,lstart=,command='], { env, encoding: 'utf8', timeout: 5000 });
  if (result.status !== 0) throw new Error('Cannot audit test descendants with ps.');
  return result.stdout.trim().split('\n').map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.*)$/.exec(line);
    return match && { pid: Number(match[1]), parent: Number(match[2]), identity: `${match[3]} ${match[4]}`, command: match[4] };
  }).filter(Boolean);
}
const active = new Map();
let interrupted;
for (const name of ['SIGINT', 'SIGTERM']) process.on(name, () => { interrupted = name; process.exitCode = 1; for (const item of active.values()) item.abort(name); });
async function run(label, command, args, cwd = source, seconds = 120) {
  if (interrupted) throw new Error(`Test runner interrupted by ${interrupted}.`);
  const logfile = path.join(logs, `${label}.log`);
  const fd = fs.openSync(logfile, 'wx', 0o600);
  const startedAt = new Date().toISOString();
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', fd, fd] });

  const descendants = new Map(); let expired = false; let spawnError; let abortReason; let abortTimer;
  const scan = () => {
    const rows = processRows(); const parents = new Set([child.pid, ...descendants.keys()]);
    let changed = true;
    while (changed) { changed = false; for (const row of rows) if (parents.has(row.parent) && !parents.has(row.pid)) { parents.add(row.pid); descendants.set(row.pid, row.identity); changed = true; } }
    return rows;
  };
  const signal = sig => {
    if (child.pid) { try { process.kill(-child.pid, sig); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    for (const row of scan()) if (descendants.get(row.pid) === row.identity) { try { process.kill(row.pid, sig); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
  };
  if (child.pid) active.set(child.pid, { abort: reason => { abortReason = reason; expired = true; signal('SIGTERM'); abortTimer = setTimeout(() => signal('SIGKILL'), 3000); } });
  const watcher = setInterval(() => { try { scan(); } catch { expired = true; signal('SIGTERM'); } }, 500);
  const timer = setTimeout(() => { expired = true; signal('SIGTERM'); }, seconds * 1000);
  const killer = setTimeout(() => { if (expired) signal('SIGKILL'); }, seconds * 1000 + 3000);
  child.on('error', error => { spawnError = error.code || 'SPAWN_ERROR'; });
  const exit = await new Promise(resolve => child.once('close', (code, sig) => resolve({ code, signal: sig })));
  clearInterval(watcher); clearTimeout(timer); clearTimeout(killer); clearTimeout(abortTimer);
  // Drain independently detached descendants too, using PID/start/command identity.
  signal('SIGTERM');
  for (let i = 0; i < 30; i++) {
    const survivors = scan().filter(row => descendants.get(row.pid) === row.identity);
    if (!survivors.length) break;
    if (i === 10) signal('SIGKILL');
    await new Promise(resolve => setTimeout(resolve, 100));
    if (i === 29) throw new Error(`Descendants failed to drain in ${label}.`);
  }
  active.delete(child.pid); fs.closeSync(fd);
  const bytes = fs.readFileSync(logfile);
  const record = { label, pid: child.pid ?? null, command: [command, ...args], cwd, startedAt, completedAt: new Date().toISOString(), timeoutSeconds: seconds, exit: exit.code, signal: exit.signal, expired, abortReason, spawnError, logBytes: bytes.length, logSha256: sha(bytes) };
  records.push(record); fs.writeFileSync(path.join(work, 'commands.json'), JSON.stringify(records, null, 2));
  if (expired || spawnError || exit.code !== 0) throw new Error(`${label} failed (${abortReason || (expired ? 'timeout' : spawnError || exit.code)}).${label.startsWith('find-') || label.startsWith('swift-') || label === 'xcode-select' ? ' Install/select an available Xcode Swift toolchain with xcode-select; native tests are required.' : ''} Private log: ${logfile}`);
  console.log(`${label}: passed`);
  return bytes.toString('utf8').trim();
}
// Validate the final Node TAP, including nested plans, rather than trusting exit 0.
function validateFinalTap(output, label, expectedTests, expectedNames) {
  const refuse = reason => { throw new Error(`${label}: invalid final TAP (${reason}).`); };
  const scopes = new Map([[0, { count: 0, plan: null }]]);
  const counters = new Map();
  const names = [];
  let header = false; let diagnostic; let pending; let suites = 0;
  const closeChildren = indent => {
    for (const [depth, scope] of scopes) if (depth > indent) {
      if (scope.plan === null || scope.plan !== scope.count) refuse('incomplete nested plan');
      scopes.delete(depth);
    }
  };
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (!header) {
      if (line !== 'TAP version 13') refuse('missing TAP version 13');
      header = true; continue;
    }
    if (diagnostic !== undefined) {
      if (line === `${' '.repeat(diagnostic)}...`) {
        if (!pending?.type) refuse('missing result type');
        if (pending.type === 'suite') suites++;
        else names.push(pending.name);
        diagnostic = undefined; pending = undefined;
      } else {
        const type = /^\s+type: '(test|suite)'$/.exec(line);
        if (type) {
          if (pending.type) refuse('ambiguous result type');
          pending.type = type[1];
        }
      }
      continue;
    }
    if (pending) {
      if (line !== `${' '.repeat(pending.indent + 2)}---`) refuse('missing result diagnostics');
      diagnostic = pending.indent + 2; continue;
    }
    if (/^\s*TAP version\b/.test(line)) refuse('ambiguous TAP header');
    const result = /^( *)(ok|not ok) (\d+) - (.+)$/.exec(line);
    if (result) {
      const indent = result[1].length;
      if (indent % 4 || counters.size) refuse('unexpected result position');
      closeChildren(indent);
      // Node prints children before their parent result, so open every ancestor scope.
      for (let depth = 0; depth < indent; depth += 4) {
        if (!scopes.has(depth)) scopes.set(depth, { count: 0, plan: null });
        if (scopes.get(depth).plan !== null) refuse('unexpected result position');
      }
      if (!scopes.has(indent)) scopes.set(indent, { count: 0, plan: null });
      const scope = scopes.get(indent);
      if (scope.plan !== null || Number(result[3]) !== scope.count + 1) refuse('nonsequential result or result after plan');
      if (result[2] !== 'ok' || /\s+#\s*(?:SKIP|TODO)\b/i.test(result[4])) refuse('non-passing result');
      scope.count++;
      pending = { indent, name: result[4], type: null }; continue;
    }
    const plan = /^( *)1\.\.(\d+)$/.exec(line);
    if (plan) {
      const indent = plan[1].length;
      if (indent % 4 || counters.size) refuse('unexpected plan position');
      closeChildren(indent);
      const scope = scopes.get(indent);
      const count = Number(plan[2]);
      if (!scope || scope.plan !== null || !Number.isSafeInteger(count) || count === 0 || count !== scope.count) refuse('empty, ambiguous or mismatched plan');
      scope.plan = count; continue;
    }
    const counter = /^# (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$/.exec(line);
    if (counter) {
      if (scopes.size !== 1 || scopes.get(0).plan === null || counters.has(counter[1])) refuse('ambiguous or premature counters');
      const value = Number(counter[2]);
      if (!Number.isSafeInteger(value)) refuse('invalid counter');
      counters.set(counter[1], value); continue;
    }
    if (/^\s*(?:1\.\.|ok\b|not ok\b|Bail out!|# (?:tests|suites|pass|fail|cancelled|skipped|todo)\b)/.test(line)) refuse('malformed TAP field');
  }
  if (!header || diagnostic !== undefined || pending || scopes.size !== 1 || scopes.get(0).plan === null || counters.size !== 7) refuse('incomplete final summary');
  const counts = Object.fromEntries(counters);
  if (!names.length || counts.tests !== names.length || counts.suites !== suites || counts.pass !== counts.tests || ['fail', 'cancelled', 'skipped', 'todo'].some(key => counts[key] !== 0)) refuse('empty or inconsistent counts, or non-passing tests');
  if (expectedTests !== undefined && counts.tests !== expectedTests) refuse(`expected ${expectedTests} cases, observed ${counts.tests}`);
  if (expectedNames && (names.length !== expectedNames.length || expectedNames.some(name => names.filter(actual => actual === name).length !== 1))) refuse('capability case titles do not match the explicit contract');
  return { ...counts, topLevelPlan: scopes.get(0).plan };
}
async function runTests(label, args, seconds, expectedTests, expectedNames) {
  const output = await run(label, process.execPath, args, source, seconds);
  // run() has already retained the log and drained the phase before this gate.
  records.at(-1).tap = validateFinalTap(output, label, expectedTests, expectedNames);
  fs.writeFileSync(path.join(work, 'commands.json'), JSON.stringify(records, null, 2));
}
function requirePath(value, label) {
  if (!path.isAbsolute(value) || !fs.existsSync(value)) throw new Error(`Selected ${label} unavailable; select an installed Xcode toolchain with xcode-select.`);
  return value;
}
function configuredBrowser() {
  const value = process.env.DEXTER_REAL_BROWSER;
  const instruction = 'Set DEXTER_REAL_BROWSER to an explicit absolute installed Chrome for Testing executable; optionally set DEXTER_REAL_BROWSER_SHA256. No browser is downloaded or discovered and native cases cannot skip.';
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(instruction);
  let resolved;
  try {
    resolved = fs.realpathSync(value);
    if (!fs.statSync(resolved).isFile()) throw new Error();
    fs.accessSync(resolved, fs.constants.X_OK);
  } catch { throw new Error(`Configured browser is not an executable file. ${instruction}`); }
  const actual = sha(fs.readFileSync(resolved));
  const expected = process.env.DEXTER_REAL_BROWSER_SHA256;
  if (expected !== undefined && (!/^[a-f0-9]{64}$/.test(expected) || expected !== actual)) throw new Error(`Configured browser SHA256 pin mismatch. ${instruction}`);
  return { executable: resolved, sha256: actual, pinConfigured: expected !== undefined };
}
async function main() {
  const capacity = fs.statfsSync(work);
  if (capacity.bavail * capacity.bsize < 600 * 1024 * 1024) throw new Error('At least 600 MiB free space is required.');
  const sentinel = path.join(work, 'preflight.public'); const fd = fs.openSync(sentinel, 'wx', 0o600);
  try { fs.writeFileSync(fd, Buffer.alloc(8 * 1024 * 1024, 0x5a)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const db = new DatabaseSync(path.join(work, 'tmp', 'preflight.sqlite'));
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE canary(value INTEGER); INSERT INTO canary VALUES(1)');
    if (db.prepare('PRAGMA journal_mode').get().journal_mode !== 'wal' || db.prepare('PRAGMA synchronous').get().synchronous !== 2 || db.prepare('SELECT value FROM canary').get().value !== 1) throw new Error('SQLite WAL/FULL preflight failed.');
  } finally { db.close(); }
  preflight = { fsyncBytes: 8388608, sqliteWalFull: true, availableBytes: capacity.bavail * capacity.bsize, minimumBytes: 600 * 1024 * 1024 };
  if (capabilityMode) { browserAsset = configuredBrowser(); env.DEXTER_REAL_BROWSER = browserAsset.executable; }
  env.DEVELOPER_DIR = requirePath(await run('xcode-select', '/usr/bin/xcode-select', ['-p'], root, 15), 'developer directory');
  const swift = requirePath(await run('find-swift', '/usr/bin/xcrun', ['--find', 'swift'], root, 15), 'Swift');
  const swiftc = requirePath(await run('find-swiftc', '/usr/bin/xcrun', ['--find', 'swiftc'], root, 15), 'Swift compiler');
  const sdk = requirePath(await run('find-sdk', '/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-path'], root, 15), 'macOS SDK');
  fs.mkdirSync(source);
  for (const name of ['packages', 'tests', 'apps/apple']) copy(path.join(root, name), path.join(source, name));
  for (const name of ['package.json', 'tsconfig.json', 'tsconfig.base.json', 'tsconfig.tests.json']) copy(path.join(root, name), path.join(source, name));
  fs.chmodSync(source, 0o700);
  const { readReviewedBrowserSource } = await import(path.join(source, 'tests/fixtures/current-reviewed-browser-source.mjs'));
  readReviewedBrowserSource(source); // Check exact approved bytes, owner and private-directory rules before setting env.
  env.DEXTER_REVIEWED_BROWSER_TEST_SOURCE = source;
  dependencies(source);
  const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  await run('build-force', process.execPath, [tsc, '-b', '--force']);
  await run('strict-typecheck', process.execPath, [tsc, '-p', 'tsconfig.tests.json', '--noEmit']);
  await run('test-emit', process.execPath, [tsc, '-p', 'tsconfig.tests.json']);
  // tsc does not emit disk-loaded .mjs fixtures. Preserve every fixture byte.
  for (const name of fs.readdirSync(path.join(source, 'tests', 'fixtures'))) if (name.endsWith('.mjs')) {
    fs.copyFileSync(path.join(source, 'tests', 'fixtures', name), path.join(source, '.test-dist', 'tests', 'fixtures', name));
  }
  const swiftPackage = path.join(work, 'swift-package'); copy(path.join(source, 'apps/apple/DeviceIdentity'), swiftPackage);
  copy(path.join(source, 'apps/apple/KeychainRuntime'), path.join(work, 'KeychainRuntime'));
  fs.copyFileSync(path.join(swiftPackage, 'fixtures/cli-forwarding-laboratory-storage.swift'), path.join(swiftPackage, 'Sources/DexterDeviceIdentity/KeychainStorage.swift'));
  if (sha(fs.readFileSync(path.join(swiftPackage, 'Sources/DexterDeviceIdentityCLI/Main.swift'))) !== sha(fs.readFileSync(path.join(source, 'apps/apple/DeviceIdentity/Sources/DexterDeviceIdentityCLI/Main.swift')))) throw new Error('Actual Swift Main changed during fixture preparation.');
  const flags = ['--build-system', 'native', '--package-path', swiftPackage, '--scratch-path', path.join(work, 'swift-scratch'), '--cache-path', path.join(work, 'cache'), '--config-path', path.join(work, 'config'), '--security-path', path.join(work, 'security')];
  await run('swift-cli', swift, ['build', ...flags, '--product', 'dexter-device-identity', '--jobs', '2', '-Xswiftc', '-strict-concurrency=complete', '-Xswiftc', '-warnings-as-errors', '-Xswiftc', '-j2'], swiftPackage, 180);
  const binOutput = await run('swift-bin-path', swift, ['build', ...flags, '--show-bin-path'], swiftPackage, 30);
  // Swift 27 prints a native-build-system deprecation notice before the path.
  // Accept exactly one existing directory inside this runner's own scratch tree.
  const binPaths = binOutput.split(/\r?\n/).filter(value => path.isAbsolute(value)
    && value.startsWith(`${path.join(work, 'swift-scratch')}/`) && fs.existsSync(value)
    && fs.lstatSync(value).isDirectory() && fs.realpathSync(value) === value);
  if (binPaths.length !== 1) throw new Error('Swift output directory is not bound to owned scratch.');
  const bin = binPaths[0];
  env.DEXTER_SWIFT_CLI_LAB_EXECUTABLE = requirePath(path.join(bin, 'dexter-device-identity'), 'memory-only CLI fixture');
  const library = path.join(source, 'apps/apple/DeviceIdentity/Sources/DexterDeviceIdentity');
  const native = path.join(work, 'native-client-laboratory');
  const keychainObjects = path.join(bin, 'DexterKeychainRuntime.build');
  await run('swift-native', swiftc, ['-sdk', sdk, '-parse-as-library', '-strict-concurrency=complete', '-warnings-as-errors', '-j2', '-I', path.join(bin, 'Modules'), ...fs.readdirSync(keychainObjects).filter(name => name.endsWith('.o')).sort().map(name => path.join(keychainObjects, name)), ...fs.readdirSync(library).filter(name => name.endsWith('.swift')).sort().map(name => path.join(library, name)), path.join(source, 'apps/apple/DeviceIdentity/fixtures/native-client-laboratory.swift'), '-o', native], source, 180);
  fs.copyFileSync(path.join(source, 'apps/apple/DeviceIdentity/fixtures/native-client-laboratory-pipe.py'), path.join(work, 'native-client-laboratory-pipe.py'));
  fs.chmodSync(native, 0o700); env.DEXTER_SWIFT_LAB_EXECUTABLE = native;
  if (capabilityMode) {
    const cuaPackage = path.join(source, 'apps/apple/MacCapabilities');
    const cuaFlags = ['--package-path', cuaPackage, '--scratch-path', path.join(work, 'cua-scratch'), '--cache-path', path.join(work, 'cache'), '--config-path', path.join(work, 'config'), '--security-path', path.join(work, 'security')];
    // No DEXTER_CUA_FIXTURES=1: existing tests explicitly select fixture mode, never AX/screen/input.
    await run('swift-cua-helper', swift, ['build', ...cuaFlags, '--product', 'dexter-cua-helper', '--jobs', '2', '-Xswiftc', '-strict-concurrency=complete', '-Xswiftc', '-warnings-as-errors', '-Xswiftc', '-j2'], cuaPackage, 180);
    const cuaBin = await run('swift-cua-bin-path', swift, ['build', ...cuaFlags, '--show-bin-path'], cuaPackage, 30);
    env.DEXTER_CUA_HELPER = requirePath(path.join(cuaBin, 'dexter-cua-helper'), 'runner-built CUA fixture helper');
  }
  const capsule = path.join(root, 'tests/fixtures/historical/legacy-hub-v3');
  const manifestBytes = fs.readFileSync(path.join(capsule, 'source-manifest.json'));
  if (sha(manifestBytes) !== 'e92b05919c958e7de32ffcecba9b43d6a9e57c67f0ff37c4651881dff1f048b9') throw new Error('Legacy capsule manifest pin mismatch; restore the versioned source fixture.');
  const capsuleRecord = JSON.parse(manifestBytes.toString('utf8'));
  if (capsuleRecord.classification !== 'EXACT_HISTORICAL_HUB_V3_SOURCE_FIXTURE' || capsuleRecord.sourceFiles !== 15 || capsuleRecord.outputsCopied !== false) throw new Error('Unexpected legacy source capsule classification.');
  const manifest = capsuleRecord.files;
  if (Object.keys(manifest).length !== 15) throw new Error('Expected the 15-file versioned old Hub v3 source capsule.');
  const legacy = path.join(work, 'legacy'); fs.mkdirSync(legacy);
  for (const [name, expected] of Object.entries(manifest)) {
    if (path.isAbsolute(name) || name.split('/').includes('..') || /(?:dist|node_modules|\.git)/.test(name)) throw new Error('Invalid legacy source manifest path.');
    const from = path.join(capsule, name); if (sha(fs.readFileSync(from)) !== expected) throw new Error(`Legacy capsule hash mismatch: ${name}`);
    const to = path.join(legacy, name); fs.mkdirSync(path.dirname(to), { recursive: true }); copy(from, to);
  }
  dependencies(legacy);
  await run('legacy-build-force', process.execPath, [tsc, '-b', 'packages/hub', '--force'], legacy);
  env.G8_BASE_HUB_DIST = path.join(legacy, 'packages/hub/dist/index.js'); requirePath(env.G8_BASE_HUB_DIST, 'old Hub v3 output');
  const { prepareHistoricalBaseline, prepareNativeCampaignProbes } = await import(path.join(source, 'tests/fixtures/portable-campaign-assets.mjs'));
  env.DEXTER_BASELINE803_TEST_SOURCE = await prepareHistoricalBaseline({ scratch: work, sourceRoot: source, dependencyRoot: root, run });
  env.DEXTER_SYNTHETIC_SDK_PROBE_DIR = await prepareNativeCampaignProbes({ scratch: work, sourceRoot: source, run, swift });
  sourceCopyPins = snapshotSourcePins();
  fs.writeFileSync(path.join(work, 'source-copy-before.json'), JSON.stringify(sourceCopyPins, null, 2), { mode: 0o600 });
  if (verification[0] === '--prepare-assets') {
    console.log('Assets prepared; this explicit mode does not execute tests.');
  } else if (verification[0] === '--verify-capabilities') {
    const names = [
      'real helper (fixture mode): status acquires the approved surface end to end; silent lock states refuse',
      'native helper in fixture mode: consent, indicator, lock, permission, stop and takeover',
      'real Chromium: per-bot profile, pipe only, cross-origin requests blocked, persistence and clean exit'
    ];
    const escaped = names.map(name => [...name].map(char => '.^$*+?()[]{}|\\'.includes(char) ? `\\${char}` : char).join(''));
    await runTests('capabilities-3', ['--test', '--test-concurrency=4', '--test-reporter=tap', `--test-name-pattern=^(?:${escaped.join('|')})$`, '.test-dist/tests/device-cua-status.test.js', '.test-dist/tests/device-local-capabilities.test.js'], 120, 3, names);
    await runTests('mjs-capabilities-sources', ['--test', '--test-concurrency=4', '--test-reporter=tap', 'tests/current-native-memory-pipe.test.mjs', 'tests/current-reviewed-browser-source.test.mjs', 'tests/native-swift-memory-pipe.test.mjs'], 120, 26);
  } else if (verification.length) {
    await runTests('native-chain-6', ['--test', '--test-concurrency=4', '--test-reporter=tap', 'tests/native-bridge-honest-laboratory.test.mjs'], 120, 6);
    await runTests('native-cli-10', ['--test', '--test-concurrency=4', '--test-reporter=tap', '.test-dist/tests/device-native-cli-forwarding.test.js', '.test-dist/tests/device-native-swift-chain.test.js'], 120, 10);
    await runTests('legacy-rollback-1', ['--test', '--test-concurrency=4', '--test-reporter=tap', '--test-name-pattern=^legacy upgrade and rollback against the real old Hub code$', '.test-dist/tests/operations-authority.test.js'], 120, 1);
    await runTests('portable-campaigns-30', ['--test', '--test-concurrency=4', '--test-reporter=tap', 'tests/memory-final-operations.test.mjs', 'tests/groups-completion-r2.test.mjs', 'tests/groups-conversation-r1.test.mjs', 'tests/native-voice-runtime.test.mjs'], 180, 30);
  } else {
    const tests = fs.readdirSync(path.join(source, '.test-dist/tests')).filter(name => name.endsWith('.test.js')).sort().map(name => `.test-dist/tests/${name}`);
    if (!tests.length) throw new Error('No emitted Node tests found.');
    const mjs = fs.readdirSync(path.join(source, 'tests')).filter(name => name.endsWith('.test.mjs')).sort().map(name => `tests/${name}`);
    defaultSelection = { emittedTsFiles: tests.length, mjsFiles: mjs.length, files: [...tests, ...mjs] };
    await runTests('node-aggregate', ['--test', '--test-concurrency=4', '--test-reporter=tap', ...tests, ...mjs], 600);
  }
}
let passed = false;
try { await main(); passed = true; } catch (error) { console.error(error.message); process.exitCode = 1; }
finally {
  for (const [pid] of active) { try { process.kill(-pid, 'SIGKILL'); } catch {} }
  const survivors = processRows().filter(row => row.pid !== process.pid && row.command.includes(`${work}/`));
  const handles = spawnSync('/usr/sbin/lsof', ['-nP', '+D', work], { env, encoding: 'utf8', timeout: 15000 });
  handleAudit = { exit: handles.status, openHandles: handles.status === 1 ? 0 : null, logSha256: sha(`${handles.stdout || ''}${handles.stderr || ''}`) };
  fs.writeFileSync(path.join(logs, 'handle-audit.log'), `${handles.stdout || ''}${handles.stderr || ''}`, { mode: 0o600 });
  if (sourceCopyPins) {
    try {
      const after = snapshotSourcePins();
      fs.writeFileSync(path.join(work, 'source-copy-after.json'), JSON.stringify(after, null, 2), { mode: 0o600 });
      const changed = [...new Set([...Object.keys(sourceCopyPins), ...Object.keys(after)])].sort()
        .filter(file => sourceCopyPins[file] !== after[file]);
      sourceCopyAudit = { status: changed.length ? 'changed' : 'matched', files: Object.keys(sourceCopyPins).length,
        beforeSha256: sha(fs.readFileSync(path.join(work, 'source-copy-before.json'))),
        afterSha256: sha(fs.readFileSync(path.join(work, 'source-copy-after.json'))), changed };
      if (changed.length) { console.error('Executed source copy changed; see retained pin manifests.'); process.exitCode = 1; }
    } catch {
      sourceCopyAudit = { status: 'audit_failed' }; process.exitCode = 1;
      console.error('Could not audit the executed source copy; no stability claim.');
    }
  }
  if (survivors.length || handles.status !== 1) { console.error('Owned descendants remain; outputs retained for inspection.'); process.exitCode = 1; }
  else for (const name of ['source', 'swift-package', 'KeychainRuntime', 'swift-scratch', 'cua-scratch', 'legacy', 'baseline803', 'campaign-sdk', 'cache', 'config', 'security', 'home', 'tmp', 'native-client-laboratory', 'native-client-laboratory-pipe.py', 'preflight.public']) fs.rmSync(path.join(work, name), { recursive: true, force: true });
  fs.writeFileSync(path.join(work, 'result.json'), JSON.stringify({ passed: passed && !process.exitCode, completedAt: new Date().toISOString(), survivingProcesses: survivors.length, handleAudit, sourceCopyAudit, preflight, browserAsset, defaultSelection, mode: verification[0] || 'aggregate', fullAggregateExecuted: !verification.length, records }, null, 2));
  console.log(`Private evidence retained: ${work}`);
}
