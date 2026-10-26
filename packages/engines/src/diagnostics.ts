import type { EngineCatalogDiagnostics } from '@dexter/contracts';
import { codeOf } from './process.js';

export function nativeCatalogDiagnostics(protocol: 'acp' | 'msp', blocked = false): EngineCatalogDiagnostics {
  return { schemaVersion: 1, protocol, initialization: 'not_checked', catalog: 'not_checked',
    transport: blocked ? 'admission_blocked' : 'implemented', authentication: 'unknown',
    nativeMcpAttached: 'not_checked', speed: 'unsupported', audio: 'unsupported', code: 'not_checked' };
}
export function catalogFailure(diagnostic: EngineCatalogDiagnostics, error: unknown): void {
  const code = codeOf(error);
  diagnostic.code = ['authentication_required', 'unsupported', 'protocol_error', 'engine_unavailable', 'timeout'].includes(code)
    ? code as EngineCatalogDiagnostics['code'] : 'engine_failed';
  diagnostic.authentication = code === 'authentication_required' ? 'required' : 'unknown';
  if (diagnostic.initialization !== 'validated') diagnostic.initialization = 'failed';
  else diagnostic.catalog = 'failed';
}
