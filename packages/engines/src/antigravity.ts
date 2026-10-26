import { lstatSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { AcpEngineDriver, type AcpDriverOptions, type AcpProvider, privateAcpHome } from './acp.js';
import { EngineError, object } from './process.js';

export interface AntigravityDriverOptions extends AcpDriverOptions {
  /** Host-owned persistent private root for a future official sign-in; never copy a native account. */
  profileHome?: string;
  /** Trusted vendor companion. Defaults to localharness_external adjacent to the official ACP executable. */
  harnessPath?: string;
}
export const ANTIGRAVITY_ADMISSION_BLOCKED = 'Antigravity ACP 1.3.0 cannot verify a Dexter-only tool registry before inference. Its native core tools and implicit configuration are not safely scoped to Dexter grants.';
function companion(command: string, supplied?: string): string {
  const path = supplied ?? resolve(dirname(command), 'localharness_external');
  if (!isAbsolute(path) || resolve(path) !== path || /[\u0000-\u001f\u007f]/.test(path)) throw new EngineError('protocol_error');
  return path;
}
function checkCompanion(path: string): void {
  try { const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || process.getuid && stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0 || (stat.mode & 0o111) === 0) throw new Error(); }
  catch { throw new EngineError('not_installed'); }
}

/**
 * Google's actual ACP runtime, distinct from the agy headless CLI. Discovery/initialize work,
 * but execution fails before session/new: Google's documented consumer ACP lacks the required
 * effective native-tool admission handshake. A synthetic fixture is not permission to enable it.
 * Source: Google AI Developers Forum /186726, response 2026-10-05. The SDK alternative requires
 * separate Gemini API/Vertex credentials and is not a transparent consumer-subscription adapter.
 */
export class AntigravityAcpDriver extends AcpEngineDriver {
  constructor(supplied: AntigravityDriverOptions = {}) {
    const command = supplied.command ?? 'agy_acp_server.par';
    const home = privateAcpHome('Antigravity', supplied, supplied.profileHome);
    const helper = companion(command, supplied.harnessPath);
    const provider: AcpProvider = {
      id: 'antigravity', providerID: 'google', providerLabel: 'Antigravity', command,
      runtime: { AGY_ACP_FORCE_FILE_STORAGE: '1', PYTHONUNBUFFERED: '1', BROWSER: '/usr/bin/false', GEMINI_HOME: home, ANTIGRAVITY_HARNESS_PATH: helper },
      beforeLaunch: () => checkCompanion(helper),
      args: () => process.platform === 'linux' ? ['--uid='] : [], statusViaInitialize: true,
      admissionBlockedReason: ANTIGRAVITY_ADMISSION_BLOCKED, allowResume: () => false,
      validateInitialize: result => { const info = object(result.agentInfo); if (info.name !== 'antigravity-acp' || info.version !== '1.3.0') throw new EngineError('unsupported'); },
      catalogState: () => ({}), sessionParameters: () => ({}),
      configure: async () => { throw new EngineError('unsupported'); },
    };
    super(provider, { ...supplied, command, env: Object.freeze({ ...supplied.env, HOME: home }) });
  }
}
