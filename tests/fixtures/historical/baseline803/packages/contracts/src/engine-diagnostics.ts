import { z } from 'zod';

/** Metadata only. Account readiness and per-turn attachment cannot be inferred from a catalog. */
export const EngineCatalogDiagnosticsSchema = z.strictObject({
  schemaVersion: z.literal(1), protocol: z.enum(['acp', 'msp']),
  initialization: z.enum(['not_checked', 'validated', 'failed']),
  catalog: z.enum(['not_checked', 'validated', 'failed']),
  transport: z.enum(['implemented', 'admission_blocked']),
  authentication: z.enum(['unknown', 'required']), nativeMcpAttached: z.literal('not_checked'),
  speed: z.literal('unsupported'), audio: z.literal('unsupported'),
  code: z.enum(['not_checked', 'not_installed', 'probe_disabled', 'host_excluded', 'capabilities_validated',
    'catalog_unavailable', 'admission_blocked', 'authentication_required', 'unsupported', 'protocol_error',
    'engine_unavailable', 'timeout', 'engine_failed']),
}).superRefine((value, ctx) => {
  if (value.catalog === 'validated' && value.initialization !== 'validated'
    || value.authentication === 'required' && value.code !== 'authentication_required'
    || value.code === 'capabilities_validated' && (value.catalog !== 'validated' || value.transport !== 'implemented')
    || value.code === 'admission_blocked' && value.transport !== 'admission_blocked')
    ctx.addIssue({ code: 'custom', message: 'Inconsistent engine diagnostic.' });
});
export type EngineCatalogDiagnostics = z.infer<typeof EngineCatalogDiagnosticsSchema>;
export function readEngineCatalogDiagnostics(value: unknown): EngineCatalogDiagnostics | null {
  const result = EngineCatalogDiagnosticsSchema.safeParse(value);
  return result.success ? result.data : null;
}

/** Emitted by the native adapter only at its actual validation seam; never static fixture/catalog evidence. */
export const EngineMcpAttachmentSchema = z.union([
  z.strictObject({ engine: z.literal('grok'), state: z.literal('validated'), code: z.literal('exact_session_registry') }),
  z.strictObject({ engine: z.literal('muse'), state: z.literal('unverified'), code: z.literal('required_session_configuration') }),
]);
export type EngineMcpAttachment = z.infer<typeof EngineMcpAttachmentSchema>;
