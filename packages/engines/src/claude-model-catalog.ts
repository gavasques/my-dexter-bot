import type { EngineCatalogModel } from '@dexter/contracts';

/** Reviewed 2026-10-10. This is CLI compatibility metadata, never account entitlement. */
export const CLAUDE_CATALOG_SOURCE = 'https://code.claude.com/docs/en/model-config';
const T3_CATALOG_SOURCE = 'https://github.com/pingdotgg/t3code/blob/7e8071f1f1566220fb52cbfaaf97a2bc4e93a193/apps/server/src/provider/model-manifest.json';
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
interface OfficialModel { id: string; label: string; minCliVersion: string; source: string }
const OFFICIAL_MODELS: readonly OfficialModel[] = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', minCliVersion: '2.1.280', source: CLAUDE_CATALOG_SOURCE },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', minCliVersion: '2.1.284', source: CLAUDE_CATALOG_SOURCE },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', minCliVersion: '2.1.257', source: CLAUDE_CATALOG_SOURCE },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', minCliVersion: '2.1.293', source: CLAUDE_CATALOG_SOURCE },
  { id: 'claude-opus-5', label: 'Claude Opus 5', minCliVersion: '2.1.219', source: CLAUDE_CATALOG_SOURCE },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', minCliVersion: '2.1.197', source: CLAUDE_CATALOG_SOURCE },
  { id: 'claude-fable-5', label: 'Claude Fable 5', minCliVersion: '2.1.169', source: T3_CATALOG_SOURCE },
];

function atLeast(version: string | undefined, floor: string): boolean {
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) return false;
  const actual = version.split('.').map(Number), required = floor.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    if (actual[index]! > required[index]!) return true;
    if (actual[index]! < required[index]!) return false;
  }
  return true;
}

/** Versioned official rows intersect the installed CLI's advertised effort flag values. */
export function claudeModelCatalog(version: string | undefined, aliases: readonly string[], cliEfforts: readonly string[], supportsModel: boolean): EngineCatalogModel[] {
  if (!supportsModel) return [];
  const rows: EngineCatalogModel[] = OFFICIAL_MODELS.filter(model => atLeast(version, model.minCliVersion)).map(model => ({
    ...model, reasoningEfforts: EFFORTS.filter(effort => cliEfforts.includes(effort)), speeds: [],
  }));
  // Keep CLI aliases selectable for saved unit110 selections and old/unknown CLI versions.
  // Help examples are a partial list; they never replace the versioned official catalog.
  const seen = new Set(rows.map(model => model.id));
  for (const id of aliases) {
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push({ id, label: id, reasoningEfforts: [...cliEfforts], speeds: [], source: 'installed_cli_help' });
  }
  return rows;
}
