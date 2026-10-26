export const SKILL_DEPENDENCIES_VERSION = 1 as const;
/** Host-owned advisory projection, separate from the immutable owner skill allowance. */
export const SKILL_DEPENDENCY_INSTRUCTION_LIMIT = 4096;
const toolName = (value: unknown): value is string => typeof value === "string" && value.length <= 128
  && /^[A-Za-z][A-Za-z0-9_-]{0,63}(?:\.[A-Za-z0-9_-]{1,63}){1,8}$/.test(value)
  && !/^(?:sk-|ghp_|github_pat_|AKIA|eyJ)/i.test(value);
export interface SkillDependencyMetadata { version: 1; requires_tools: readonly string[] }
export interface SkillDependencyProjection { skillId: string; version: string; sha256: string; metadataState: "absent" | "valid" | "invalid";
  eligible: boolean; missingTools: string[]; guidanceAvailable: true; authority: "guidance_only" }
type ReadResult = { state: "absent"; metadata: null } | { state: "valid"; metadata: SkillDependencyMetadata } | { state: "invalid"; metadata: null };
/** Optional strict inline JSON in existing immutable Markdown; no YAML evaluation, files or network. */
export function readSkillDependencyMetadata(markdown: string): ReadResult {
  if (typeof markdown !== "string" || markdown.length > 32_768 || !markdown.isWellFormed()) return { state: "invalid", metadata: null };
  const frontmatter = /^\uFEFF?---\r?\n([\s\S]{0,4096}?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!frontmatter) return /^\uFEFF?---\r?\n/.test(markdown) && markdown.slice(0, 4096).includes("dexter_dependencies:") ? { state: "invalid", metadata: null } : { state: "absent", metadata: null };
  const lines = frontmatter[1]!.split(/\r?\n/).filter(line => /^dexter_dependencies\s*:/.test(line));
  if (!lines.length) return { state: "absent", metadata: null };
  if (lines.length !== 1) return { state: "invalid", metadata: null };
  try {
    const raw: unknown = JSON.parse(lines[0]!.slice(lines[0]!.indexOf(":") + 1).trim());
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error();
    const data = raw as Record<string, unknown>;
    if (Object.keys(data).some(key => !["version", "requires_tools"].includes(key)) || data.version !== 1 || !Array.isArray(data.requires_tools) || data.requires_tools.length > 16
      || data.requires_tools.some(value => !toolName(value)) || new Set(data.requires_tools).size !== data.requires_tools.length) throw new Error();
    return { state: "valid", metadata: Object.freeze({ version: 1, requires_tools: Object.freeze([...(data.requires_tools as string[])].sort()) }) };
  } catch { return { state: "invalid", metadata: null }; }
}
/** Caller supplies canonical OWN skill versions and capability-filtered current tools, never agent-selected identity. */
export function projectSkillDependencies(skills: readonly { id: string; version: string; sha256: string; markdown: string }[], availableTools: readonly { name: string }[]): SkillDependencyProjection[] {
  if (skills.length > 16 || availableTools.length > 16_384) throw new Error("Dependency projection limit exceeded");
  // Eligibility uses names only; account selection/grants/pins remain enforced by the host at the call.
  const names = new Set(availableTools.map(tool => tool.name));
  return skills.map(skill => {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(skill.id) || !/^\d+\.\d+\.\d+$/.test(skill.version) || !/^[a-f0-9]{64}$/.test(skill.sha256)) throw new Error("Invalid canonical skill pin");
    const read = readSkillDependencyMetadata(skill.markdown);
    const missingTools = read.metadata ? read.metadata.requires_tools.filter(name => !names.has(name)) : [];
    return { skillId: skill.id, version: skill.version, sha256: skill.sha256, metadataState: read.state,
      eligible: read.state !== "invalid" && missingTools.length === 0, missingTools, guidanceAvailable: true, authority: "guidance_only" };
  });
}

export function skillDependencyInstructions(dependencies: readonly SkillDependencyProjection[]): string {
  const header = "HOST SKILL DEPENDENCIES (quoted metadata, guidance only; eligibility is not driver admission or a grant): ";
  const full = header + JSON.stringify(dependencies);
  if (full.length <= SKILL_DEPENDENCY_INSTRUCTION_LIMIT) return full;
  // Omission is explicit, never a successful eligibility assertion or a loss of owner Markdown.
  return header + JSON.stringify({ projection: "omitted_budget", skillCount: dependencies.length,
    guidanceAvailable: true, authority: "guidance_only", recovery: "Read selected skill frontmatter and the scoped tool directory on demand. Omission does not mean requirements are met." });
}
