import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
const ts = createRequire(import.meta.url)("typescript") as typeof import("typescript");
const text = readFileSync(resolve("packages/context/src/skill-dependencies.ts"), "utf8");
const source = await import(`data:text/javascript;base64,${Buffer.from(ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText).toString("base64")}`) as {
  readSkillDependencyMetadata(markdown: string): { state: "absent" | "valid" | "invalid"; metadata: unknown };
  projectSkillDependencies(skills: readonly { id: string; version: string; sha256: string; markdown: string }[], tools: readonly { name: string }[]): Array<{ eligible: boolean; guidanceAvailable: true; authority: "guidance_only"; missingTools: string[] }> };
const markdown = (value: unknown) => `---\ndexter_dependencies: ${JSON.stringify(value)}\n---\n# Skill\nInstructions remain available.\n`;
const skill = (body: string) => ({ id: "my_skill", version: "1.0.0", sha256: "a".repeat(64), markdown: body });

test("legacy skill remains consultable without new metadata or a grant", () => {
  assert.deepEqual(source.readSkillDependencyMetadata("# Existing skill"), { state: "absent", metadata: null });
  const projected = source.projectSkillDependencies([skill("# Existing skill")], []); assert.equal(projected[0]!.eligible, true); assert.equal(projected[0]!.guidanceAvailable, true); assert.equal(projected[0]!.authority, "guidance_only");
});

test("versioned requires_tools metadata reports missing current tools without granting or hiding guidance", () => {
  const body = markdown({ version: 1, requires_tools: ["dexter.harness.mcp.inspect", "mcp.example.read"] });
  const missing = source.projectSkillDependencies([skill(body)], [{ name: "dexter.harness.mcp.inspect" }]); assert.deepEqual(missing[0]!.missingTools, ["mcp.example.read"]); assert.equal(missing[0]!.eligible, false); assert.equal(missing[0]!.guidanceAvailable, true);
  const present = source.projectSkillDependencies([skill(body)], [{ name: "dexter.harness.mcp.inspect" }, { name: "mcp.example.read" }]); assert.equal(present[0]!.eligible, true); assert.equal(present.length, 1);
  const revoked = source.projectSkillDependencies([skill(body)], []); assert.equal(revoked[0]!.eligible, false); assert.equal(revoked[0]!.guidanceAvailable, true);
});

test("malformed metadata never echoes secret-like values or becomes an executable declaration", () => {
  for (const value of [{ version: 2, requires_tools: [] }, { version: 1, requires_tools: ["mcp.example.read", "mcp.example.read"] }, { version: 1, requires_tools: ["sk-secret-synthetic-123"] }, { version: 1, requires_tools: [], ownerId: "other" }, { version: 1, requires_tools: Array(17).fill("mcp.example.read") }]) {
    const parsed = source.readSkillDependencyMetadata(markdown(value)); assert.deepEqual(parsed, { state: "invalid", metadata: null }); const projected = source.projectSkillDependencies([skill(markdown(value))], []); assert.equal(projected[0]!.eligible, false); assert.equal(projected[0]!.guidanceAvailable, true); assert.equal(projected[0]!.missingTools.length, 0); assert(!JSON.stringify(projected).includes("sk-secret"));
  }
});

test("bounded frontmatter handles BOM/CRLF and duplicate declarations without YAML execution", () => {
  const body = '\uFEFF---\r\ndexter_dependencies: {"version":1,"requires_tools":["mcp.example.read"]}\r\n---\r\ncontent'; assert.equal(source.readSkillDependencyMetadata(body).state, "valid");
  assert.equal(source.readSkillDependencyMetadata('---\ndexter_dependencies: &reference\n---\n').state, "invalid");
  assert.equal(source.readSkillDependencyMetadata('---\ndexter_dependencies: {"version":1,"requires_tools":[]}\ndexter_dependencies: {}\n---\n').state, "invalid");
  assert.equal(source.readSkillDependencyMetadata("x".repeat(32769)).state, "invalid"); assert.equal(source.readSkillDependencyMetadata("---\ndexter_dependencies: {}\n" + "x".repeat(5000)).state, "invalid");
});

test("projection requires canonical pins and remains bounded to current scoped skills", () => {
  assert.throws(() => source.projectSkillDependencies([{ ...skill("# Skill"), sha256: "not-canonical" }], [])); assert.throws(() => source.projectSkillDependencies(Array(17).fill(skill("# Skill")), []));
  const input = [skill(markdown({ version: 1, requires_tools: ["mcp.example.read"] }))], before = JSON.stringify(input); source.projectSkillDependencies(input, []); assert.equal(JSON.stringify(input), before);
});
