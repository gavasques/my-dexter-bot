import { id, type ContextScope } from "./types.js";

/** The caller derives these IDs from the live host turn, never from tool input.
 * Team membership alone does not publish private bot or owner-global knowledge.
 * Existing owner-global pages remain explicitly shared across private bot turns.
 */
export function turnMemoryScopes(botId: string, teamId: string | null, confidential = false): ContextScope[] {
  id(botId);
  if (teamId !== null) return [{ kind: "team", teamId: id(teamId) }];
  return [{ kind: "global" }, { kind: "bot", botId },
    ...(confidential ? [{ kind: "confidential" as const, botId }] : [])];
}
