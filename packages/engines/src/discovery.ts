import { accessSync, constants, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import type { EngineCatalogEntry, EngineId } from '@dexter/contracts';
import { ClaudeCliDriver } from './claude.js';
import { CodexAppServerDriver } from './codex.js';
import { probe } from './process.js';
import { GrokAcpDriver } from './grok.js';
import { AntigravityAcpDriver } from './antigravity.js';
import { nativeCatalogDiagnostics } from './diagnostics.js';
import { MuseMspDriver } from './muse.js';

export interface EngineDiscoveryOptions {
  /** An explicit map limits runnable engine selection exactly to its supplied keys. */
  commands?: Readonly<Partial<Record<EngineId, string>>>;
  path?: string;
  home?: string;
  directories?: readonly string[];
  requestTimeoutMs?: number;
  /** Version probes execute only a discovered CLI, never a shell. Defaults to metadata only. */
  probeVersions?: boolean;
}
export interface DiscoveredNativeEngine {
  id: string;
  installed: boolean;
  /** Host startup metadata only; do not send executable paths to app clients. */
  command?: string;
  version?: string;
  adapterSupported: boolean;
  selected: boolean;
}
const ENGINES = [
  { id: 'codex', names: ['codex'], providerID: 'openai', providerLabel: 'OpenAI', adapterSupported: true },
  { id: 'claude', names: ['claude'], providerID: 'anthropic', providerLabel: 'Anthropic', adapterSupported: true },
  { id: 'grok', names: ['grok'], providerID: 'xai', providerLabel: 'xAI', adapterSupported: true },
  { id: 'muse', names: ['muse'], providerID: 'meta', providerLabel: 'Meta', adapterSupported: true },
  { id: 'antigravity', names: ['agy_acp_server.par'], detectionNames: ['agy', 'antigravity'], providerID: 'google', providerLabel: 'Google', adapterSupported: true },
] as const;

/** No login shell, aliases, config reads, recursive scans or process launches for discovery. */
function executable(value: string): string | undefined {
  if (!isAbsolute(value) || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value) || resolve(value) !== value) return undefined;
  try {
    const real = realpathSync(value);
    if (!isAbsolute(real) || real.length > 1024 || /[\u0000-\u001f\u007f]/.test(real) || !statSync(real).isFile()) return undefined;
    accessSync(real, constants.X_OK);
    return real;
  } catch { return undefined; }
}
function discoveryDirectories(options: EngineDiscoveryOptions): string[] {
  const home = options.home ?? homedir();
  const paths = (options.path ?? process.env.PATH ?? '').split(delimiter).slice(0, 64);
  paths.push(...['.local/bin', '.npm-global/bin', '.grok/bin', '.opencode/bin', '.claude/local',
    '.volta/bin', '.bun/bin', '.asdf/shims', '.local/share/mise/shims', '.deno/bin', 'bin'].map(path => join(home, path)),
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin');
  // Node manager binaries may be absent from non-interactive GUI PATH. Inspect names only.
  try {
    const nvm = join(home, '.nvm/versions/node');
    const versions = readdirSync(nvm).filter(name => /^v\d+\.\d+\.\d+$/.test(name)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).slice(0, 16);
    paths.push(...versions.map(version => join(nvm, version, 'bin')));
  } catch { /* NVM is optional. */ }
  paths.push(...(options.directories ?? []).slice(0, 32));
  return [...new Set(paths.filter(value => isAbsolute(value) && value.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(value)).map(value => resolve(value)))];
}

export function discoverNativeEngineFiles(options: EngineDiscoveryOptions = {}): DiscoveredNativeEngine[] {
  const directories = discoveryDirectories(options);
  return ENGINES.map(spec => {
    const explicit = options.commands?.[spec.id as EngineId];
    let command = explicit === undefined ? undefined : executable(explicit);
    if (explicit === undefined) {
      for (const directory of directories) {
        if (command) break;
        for (const name of spec.names) { command = executable(join(directory, name)); if (command) break; }
      }
    }
    const detected = command !== undefined || ('detectionNames' in spec && directories.some(directory => spec.detectionNames.some(name => executable(join(directory, name)) !== undefined)));
    const entry: DiscoveredNativeEngine = { id: spec.id, installed: detected, adapterSupported: spec.adapterSupported, selected: command !== undefined && spec.adapterSupported && (options.commands === undefined || explicit !== undefined), ...(command ? { command } : {}) };
    return entry;
  });
}

export async function discoverNativeEngines(options: EngineDiscoveryOptions = {}): Promise<DiscoveredNativeEngine[]> {
  const entries = discoverNativeEngineFiles(options);
  if (!options.probeVersions) return entries;
  return Promise.all(entries.map(async entry => {
    // New adapters own their private profile policy and version handshake. Never launch their
    // public wrapper against the ambient HOME just to repeat catalog's version observation.
    if (entry.command && entry.selected && (entry.id === 'claude' || entry.id === 'codex')) {
      try {
        const version = await probe({ requestTimeoutMs: Math.min(options.requestTimeoutMs ?? 3000, 3000) }, entry.command, ['--version']);
        const value = version.exitCode === 0 ? version.text.match(/\b\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?\b/)?.[0] : undefined;
        if (value) entry.version = value;
      } catch { /* Installed file remains distinct from successful CLI probing. */ }
    }
    return entry;
  }));
}

/** Capability discovery uses official protocol metadata in adapter-owned profiles, without inference. */
export async function discoverEngineCatalog(options: EngineDiscoveryOptions = {}): Promise<EngineCatalogEntry[]> {
  const discovered = await discoverNativeEngines(options);
  return Promise.all(discovered.map(async entry => {
    const spec = ENGINES.find(candidate => candidate.id === entry.id)!;
    const provider = { providerID: spec.providerID, providerLabel: spec.providerLabel };
    if (entry.selected && entry.command && options.probeVersions !== false) {
      const driverOptions = { command: entry.command, requestTimeoutMs: Math.min(options.requestTimeoutMs ?? 3000, 3000) };
      if (entry.id === 'codex') return { ...await new CodexAppServerDriver(driverOptions).catalog(), ...provider, catalogSource: 'native_model_list' };
      if (entry.id === 'claude') return { ...await new ClaudeCliDriver(driverOptions).catalog(), ...provider };
      if (entry.id === 'grok') return { ...await new GrokAcpDriver(driverOptions).catalog(), ...provider, installed: entry.installed };
      if (entry.id === 'muse') return { ...await new MuseMspDriver(driverOptions).catalog(), ...provider, installed: entry.installed };
      if (entry.id === 'antigravity') return { ...await new AntigravityAcpDriver(driverOptions).catalog(), ...provider, installed: entry.installed };
    }
    const diagnostics = ['grok', 'muse', 'antigravity'].includes(entry.id) ? nativeCatalogDiagnostics(entry.id === 'muse' ? 'msp' : 'acp', entry.id === 'antigravity') : undefined;
    if (diagnostics) diagnostics.code = !entry.installed ? 'not_installed' : !entry.selected ? 'host_excluded' : 'probe_disabled';
    return { id: entry.id, ...provider, ...(diagnostics ? { diagnostics } : {}), installed: entry.installed, ...(entry.version ? { version: entry.version } : {}), adapterSupported: entry.adapterSupported, available: false, models: [], defaultModel: null, reasoningEfforts: [], speeds: [], unavailableReason: !entry.installed ? 'CLI not installed.' : !entry.adapterSupported ? 'CLI detected. Dexter has no isolated native adapter for this engine yet.' : !entry.command && entry.id === 'antigravity' ? 'Antigravity CLI detected. Install or select the official Antigravity ACP runtime to use Dexter.' : !entry.selected ? 'Engine excluded by host command selection.' : 'Capability probing is disabled.' } satisfies EngineCatalogEntry;
  }));
}
