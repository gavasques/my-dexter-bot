// Test-only frozen source and synthetic loopback SDK assets. Never install or
// select a production helper, credential store, microphone or CUA surface.
import { after } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const emittedRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repository = path.basename(emittedRoot) === '.test-dist' ? path.dirname(emittedRoot) : emittedRoot;
const BASELINE_PIN = 'f0b0f9a7860decadc5f07a74482aa5ad0f4ef53767ff13de28a24465867fcef3';
const PROBE_PIN = '5c9756505f52f20a743db2b5c65a3b08ad27de55096da74a896f96de79ae8a03';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const owned = new Set();
after(() => { for (const dir of owned) fs.rmSync(dir, { recursive: true, force: true }); });
export function campaignLab(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), `dexter-synthetic-${prefix}-`)));
  fs.chmodSync(dir, 0o700); owned.add(dir); return dir;
}
export function campaignEvidence(label, evidence) {
  // Node's TAP reporter retains this synthetic evidence in the runner's private
  // log; no sibling fixtures/logs directory or personal path is created.
  after(() => console.log(`Campaign evidence ${label}: ${JSON.stringify(evidence)}`));
}
function regular(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Regular source file required: ${file}`);
  return fs.readFileSync(file);
}
function verifyCapsule(dir, pin, classification) {
  const bytes = regular(path.join(dir, 'source-manifest.json'));
  if (sha(bytes) !== pin) throw new Error('Pinned test source manifest changed.');
  const manifest = JSON.parse(bytes);
  if (manifest.classification !== classification || manifest.outputsCopied !== false) throw new Error('Unexpected test capsule classification.');
  for (const [name, hash] of Object.entries(manifest.files)) {
    if (path.isAbsolute(name) || name.split('/').includes('..') || name.split('/').some(piece => ['dist', 'node_modules', '.git', '.build'].includes(piece))) throw new Error('Invalid test capsule path.');
    if (sha(regular(path.join(dir, name))) !== hash) throw new Error(`Pinned test source mismatch: ${name}`);
  }
  if (manifest.sourceFiles !== undefined && Object.keys(manifest.files).length !== manifest.sourceFiles) throw new Error('Historical capsule source count mismatch.');
  return manifest;
}
function privateDirectory(dir) {
  if (!path.isAbsolute(dir)) throw new Error('Absolute private asset directory required.');
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.uid !== process.getuid()) throw new Error('Test assets must be in an owned private directory.');
}
function copy(from, to) {
  const stat = fs.lstatSync(from);
  if (stat.isSymbolicLink()) throw new Error(`Source symlink refused: ${from}`);
  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from)) if (!['node_modules', '.git', 'dist', '.test-dist', '.build', '.swiftpm'].includes(entry) && !entry.endsWith('.tsbuildinfo')) copy(path.join(from, entry), path.join(to, entry));
  } else if (stat.isFile()) fs.copyFileSync(from, to);
}
function bindDependencies(dir, dependencyRoot, packages) {
  const modules = path.join(dir, 'node_modules'); fs.mkdirSync(modules);
  for (const entry of fs.readdirSync(path.join(dependencyRoot, 'node_modules'))) {
    if (entry === '@dexter' || entry === '.bin') continue;
    fs.symlinkSync(path.join(dependencyRoot, 'node_modules', entry), path.join(modules, entry));
  }
  fs.mkdirSync(path.join(modules, '@dexter'));
  for (const name of packages) fs.symlinkSync(path.join(dir, 'packages', name), path.join(modules, '@dexter', name));
}
function command(label, executable, args, cwd, seconds = 180) {
  const result = spawnSync(executable, args, { cwd, timeout: seconds * 1000, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${label} failed: ${result.error?.message ?? result.status}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  return (result.stdout ?? '').trim();
}
function outputReceipt(dir, pin, outputs) {
  fs.writeFileSync(path.join(dir, 'build-receipt.json'), JSON.stringify({ manifestSha256: pin, outputs: Object.fromEntries(outputs.map(name => [name, sha(regular(path.join(dir, name)))])) }) + '\n', { mode: 0o600 });
}
function verifyOutputs(dir, pin) {
  privateDirectory(dir);
  const receipt = JSON.parse(regular(path.join(dir, 'build-receipt.json')));
  if (receipt.manifestSha256 !== pin) throw new Error('Test asset build manifest mismatch.');
  for (const [name, hash] of Object.entries(receipt.outputs)) {
    if (path.isAbsolute(name) || name.split('/').includes('..') || sha(regular(path.join(dir, name))) !== hash) throw new Error('Test asset output receipt mismatch.');
  }
}
export async function prepareHistoricalBaseline({ scratch, sourceRoot = repository, dependencyRoot = repository, run = command }) {
  const capsule = path.join(sourceRoot, 'tests/fixtures/historical/baseline803');
  const manifest = verifyCapsule(capsule, BASELINE_PIN, 'EXACT_HISTORICAL_BASELINE803_HUB14_CONTEXT3_SOURCE_FIXTURE');
  const dir = path.join(scratch, 'baseline803'); fs.mkdirSync(dir, { mode: 0o700 });
  for (const name of Object.keys(manifest.files)) {
    const to = path.join(dir, name); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(path.join(capsule, name), to);
  }
  // Bind all @dexter references to historical packages, never live workspace
  // modules; installed external dependencies are reused without installation.
  bindDependencies(dir, dependencyRoot, manifest.packages);
  const tsc = path.join(dependencyRoot, 'node_modules/typescript/bin/tsc');
  await run('baseline803-build-force', process.execPath, [tsc, '-b', ...manifest.buildTargets, '--force'], dir, 180);
  const emitted = [];
  function collect(at) { for (const entry of fs.readdirSync(at, { withFileTypes: true })) { const file = path.join(at, entry.name); if (entry.isDirectory()) collect(file); else if (entry.isFile() && file.endsWith('.js')) emitted.push(path.relative(dir, file)); } }
  for (const name of manifest.packages) collect(path.join(dir, 'packages', name, 'dist'));
  outputReceipt(dir, BASELINE_PIN, emitted); return dir;
}
let historical;
export async function historicalBaseline() {
  historical ??= (async () => {
    const dir = process.env.DEXTER_BASELINE803_TEST_SOURCE ?? await prepareHistoricalBaseline({ scratch: campaignLab('historical-source') });
    verifyOutputs(dir, BASELINE_PIN);
    const manifest = verifyCapsule(path.join(repository, 'tests/fixtures/historical/baseline803'), BASELINE_PIN, 'EXACT_HISTORICAL_BASELINE803_HUB14_CONTEXT3_SOURCE_FIXTURE');
    for (const [name, hash] of Object.entries(manifest.files)) if (sha(regular(path.join(dir, name))) !== hash) throw new Error('Historical build source changed after compilation.');
    for (const name of manifest.packages) if (fs.realpathSync(path.join(dir, 'node_modules/@dexter', name)) !== fs.realpathSync(path.join(dir, 'packages', name))) throw new Error('Historical workspace dependency escaped its frozen copy.');
    for (const name of ['hub', 'context', 'operations']) if (!fs.existsSync(path.join(dir, `packages/${name}/dist/index.js`))) throw new Error('Incomplete historical source build.');
    const hub = await import(pathToFileURL(path.join(dir, 'packages/hub/dist/index.js')));
    if (hub.SCHEMA_VERSION !== 14) throw new Error('Migration requires actual historical Hub14.');
    return { hub, context: await import(pathToFileURL(path.join(dir, 'packages/context/dist/index.js'))), operations: await import(pathToFileURL(path.join(dir, 'packages/operations/dist/index.js'))) };
  })();
  return historical;
}
export async function prepareNativeCampaignProbes({ scratch, sourceRoot = repository, run = command, swift = '/usr/bin/xcrun' }) {
  const probe = path.join(sourceRoot, 'tests/fixtures/native-sdk-probes');
  verifyCapsule(probe, PROBE_PIN, 'SYNTHETIC_LOOPBACK_CURRENT_SDK_PROBES');
  const dir = path.join(scratch, 'campaign-sdk'); fs.mkdirSync(dir, { mode: 0o700 });
  const source = path.join(dir, 'source'); fs.mkdirSync(source);
  // SDK probes compile against the current SDK copied into private scratch.
  copy(path.join(sourceRoot, 'apps/apple'), path.join(source, 'apps/apple'));
  const pkg = path.join(source, 'tests/fixtures/native-sdk-probes'); copy(probe, pkg);
  const flags = ['--package-path', pkg, '--scratch-path', path.join(dir, 'build'), '--cache-path', path.join(dir, 'cache'), '--config-path', path.join(dir, 'config'), '--security-path', path.join(dir, 'security')];
  const prefix = swift === '/usr/bin/xcrun' ? ['swift'] : [];
  await run('swift-campaign-sdk', swift, [...prefix, 'build', ...flags, '--jobs', '2', '-Xswiftc', '-strict-concurrency=complete', '-Xswiftc', '-warnings-as-errors', '-Xswiftc', '-j2'], pkg, 300);
  const bin = await run('swift-campaign-sdk-bin', swift, [...prefix, 'build', ...flags, '--show-bin-path'], pkg, 30);
  const outputs = [];
  for (const name of ['GroupsSDKProbe', 'NativeVoiceSDKProbe']) { fs.copyFileSync(path.join(bin.trim(), name), path.join(dir, name)); fs.chmodSync(path.join(dir, name), 0o700); outputs.push(name); }
  outputReceipt(dir, PROBE_PIN, outputs); return dir;
}
let native;
export async function campaignSDKProbe(name) {
  if (!['GroupsSDKProbe', 'NativeVoiceSDKProbe'].includes(name)) throw new Error('Unknown synthetic SDK probe.');
  native ??= (async () => process.env.DEXTER_SYNTHETIC_SDK_PROBE_DIR ?? await prepareNativeCampaignProbes({ scratch: campaignLab('native-sdk') }))();
  const dir = await native; verifyOutputs(dir, PROBE_PIN); return path.join(dir, name);
}
