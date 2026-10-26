import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { createRequire } from "node:module";
import {APP_CONFIGURATION_GUIDE_VERSION,DEXTER_HARNESS_GUIDE,readAppConfigurationGuidePage,readHarnessGuideTopic,type AppConfigurationGuidePage} from "@dexter/context";
import { CompleteConnectionWorkflowSchema, RespondMcpPrivateInputSchema } from "@dexter/contracts";

// Read/transpile this exact author source without rebuilding another worker's artifacts.
const ts = createRequire(import.meta.url)("typescript") as typeof import("typescript");
const source = readFileSync(resolve("packages/context/src/mcp-complete-configuration-guide.ts"), "utf8");
type GuideInput = Pick<AppConfigurationGuidePage, "id" | "title" | "scope" | "availability" | "sourcePaths" | "notes" | "fields">;
const authored = await import(`data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText).toString("base64")}`) as {
  MCP_COMPLETE_GUIDE_PAGES: readonly GuideInput[]; applyMcpCompleteGuideOverlay(input: GuideInput): GuideInput };
const required = ["purpose", "scope", "read", "change", "approval", "result", "recovery", "availability"] as const;
const pages = authored.MCP_COMPLETE_GUIDE_PAGES;

test("all MCP controls ship eight operational fields and stable progressive page IDs", () => {
  assert.deepEqual(pages.map(page => page.id), ["connection-setup", "mcp-gateway", "mcp-private-input", "mcp-result-artifacts"]);
  for (const page of pages) { assert(page.fields.length > 0); assert.equal(new Set(page.fields.map(field => field.id)).size, page.fields.length); for (const field of page.fields) for (const key of required) assert(typeof field[key] === "string" && field[key].length > (key === "availability" ? 0 : 10), `${page.id}/${field.id}/${key}`); }
});

test("setup/form documentation matches strict live DTOs and actual HTTP/harness operations", () => {
  CompleteConnectionWorkflowSchema.parse({ expectedHostID: "host", clientRequestId: randomUUID(), expectedRevision: 1, selections: [{ connectionId: "connection", expectedRevision: 2, tools: [{ name: "mcp.example.read", manifestHash: "a".repeat(64) }] }] });
  RespondMcpPrivateInputSchema.parse({ expectedHostID: "host", clientRequestId: randomUUID(), expectedRevision: 1, actionId: "act_example", requestHash: "a".repeat(64), approval: "approve_exact_input", responses: { name: { action: "accept", content: { name: "Ada" } } } });
  const routes = readFileSync(resolve("packages/hub/src/http-routes.ts"), "utf8"), surface = readFileSync(resolve("packages/cli/src/harness-operation-surface.ts"), "utf8");
  for (const path of ["/v1/connections/setup-requests/:id/choices", "/v1/connections/setup-requests/:id/complete", "/v1/connections/setup-requests/:id/cancel", "/v1/mcp/input-requests/:id/respond"]) assert(routes.includes(`"${path}"`));
  for (const name of ["connections.catalog", "connections.request_status", "connections.request", "results.artifact.read", "results.artifact.remove"]) assert(surface.includes(`name:"${name}"`) || surface.includes(`name: "${name}"`));
  const setup = pages.find(page => page.id === "connection-setup")!; assert(setup.fields.find(field => field.id === "connections.setup.request")!.approval.includes("exact_owner")); assert(setup.fields.find(field => field.id === "connections.setup.continue")!.change.includes("1..5"));
});

test("guide preserves existing IDs while replacing blanket owner-only and next-turn claims precisely", () => {
  const base = { id: "connections", title: "Existing", scope: "base", availability: "human_only", sourcePaths: [], notes: ["old blanket"], fields: [{ id: "connections.account.status", title: "Account", purpose: "Read account", scope: "base", read: "GET owner-local", change: "none", approval: "Pareados recebem 403", result: "facts", recovery: "GET", availability: "read_only", readOperation: "GET owner-local /v1/connections/accounts", changeOperation: null }, { id: "connections.platform-credential", title: "Private credential", purpose: "Custody", scope: "owner", read: "owner-local", change: "private pipe", approval: "owner-only", result: "custody", recovery: "GET", availability: "human_only", readOperation: null, changeOperation: "private pipe" }] } as Pick<AppConfigurationGuidePage, "id" | "title" | "scope" | "availability" | "sourcePaths" | "notes" | "fields">;
  const revised = authored.applyMcpCompleteGuideOverlay(base);
  assert.deepEqual(revised.fields.slice(0,base.fields.length).map(field => field.id), base.fields.map(field => field.id)); assert(revised.fields[0]!.readOperation!.includes("connections.read")); assert(revised.fields[0]!.approval.includes("connections.manage")); assert.equal(revised.fields[1]!.approval, "owner-only");
  assert(revised.fields.some(field=>field.id==='connections.home.search'));
  assert(revised.fields.some(field=>field.id==='connections.setup-request.review'));
  assert(revised.notes.includes('old blanket'), 'the overlay preserves inherited operational notes');
  const native = authored.applyMcpCompleteGuideOverlay({ ...base, id: "bot-settings-mcp", fields: [{ ...base.fields[0]!, id: "selection", result: "Novas tools próximo turno." }] }); assert(native.fields[0]!.result.includes("workflow")); assert(!native.fields[0]!.result.includes("Novas tools próximo turno."));
});
test('final progressive guide preserves multi-account and identity rules, real navigation and secret prohibition',()=>{
  const connections=readAppConfigurationGuidePage('connections'),notes=connections.notes.join('\n');
  for(const text of ['Várias contas','identity_mismatch','Reconectar cria uma conta NOVA','revogação local primeiro','Composio'])assert(notes.includes(text),text);
  const native=readAppConfigurationGuidePage('bot-settings-mcp').fields.find(f=>f.id==='bot-settings.mcp.global')!;
  assert(native.change.includes('McpConnectionsView'));assert(native.change.includes('Ajustes › Conexões'));
  const mcp=readHarnessGuideTopic('mcp').markdown;
  for(const text of ['Nunca peça API key, senha, token','arquivo de autenticação ou cookie','memória/skills','argumentos','na abertura desta lease','novos grants'])assert(mcp.includes(text),text);
});

test("paired access and native custody remain different boundaries", () => {
  const all = JSON.stringify(pages); for (const scope of ["connections.read", "connections.manage", "mcp.read", "mcp.manage"]) assert(all.includes(scope));
  assert(all.includes("iPhone não executa")); assert(all.includes("owner-local do executor")); assert(all.includes("pareamento antigo não herda"));
  const forms = pages.find(page => page.id === "mcp-private-input")!; assert(forms.notes.some(note => note.includes("requestState") || note.includes("estado upstream"))); assert(forms.notes.some(note => note.includes("sem autoresposta"))); assert(!forms.fields.some(field => field.changeOperation?.startsWith("dexter.harness")));
});

test("budget, output and artifact guides track concrete source limits without inference proof", () => {
  const gateway = JSON.stringify(pages.find(page => page.id === "mcp-gateway")); for (const budget of ["16000", "12000", "6000", "4000"]) assert(gateway.includes(budget)); assert(gateway.includes("Claude/Codex")); assert(gateway.includes("default legacy")); assert(gateway.includes("protocolMode auto"));
  const artifacts = JSON.stringify(pages.find(page => page.id === "mcp-result-artifacts")); for (const value of ["1MiB", "16MiB", "128", "TTL1h", "8192", "fora do checkpoint", "nenhum resultado entra automaticamente"]) assert(artifacts.includes(value));
});

test("bounded native validation and correctable private-answer recovery remain explicit", () => {
  const gateway=pages.find(page=>page.id==="mcp-gateway")!.notes.join("\n");
  for(const text of ["Thompson NFA", "8 milhões", "32 programas", "1024 estados", "antes de MRTR/outputSchema", "output_schema_invalid/possible", "validation_resource_limit", "owner_check_server_limits", "pre_dispatch/none", "validation/possible", "unknown", "YOUR_/example-/dummy-/synthetic-"]) assert(gateway.includes(text),text);
  const forms=pages.find(page=>page.id==="mcp-private-input")!,respond=forms.fields.find(field=>field.id==="mcp.input.respond")!;
  for(const text of ["HTTP400", "no-store", "pending", "novo gesto humano/clientRequestId", "outcome_unknown", "upstream original"]) assert(respond.recovery.includes(text),text);
  for(const text of ["additionalProperties", "enumNames", "oneOf", "16 campos", "32KiB", "senha/passwd/pwd/pin/cvv/cookie"]) assert(forms.notes.join("\n").includes(text),text);
});

test("private form pages distinguish summaries from actionable detail and retain private authority", () => {
  const page = pages.find(candidate => candidate.id === "mcp-private-input")!;
  const text = page.notes.join("\n");
  for (const term of ["version2", "até100", "unverifiedRequestCount", "append-only", "Poda de retenção durável não foi implementada", "1.052.672", "528.384", "256KiB", "64KiB"])
    assert(text.includes(term), term);
  const summaries = page.fields.find(field => field.id === "mcp.private-inputs.summaries")!;
  assert(summaries.read.includes("detailState:not_loaded"));
  assert(summaries.read.includes("sem requests"));
  assert(summaries.read.includes("invalidRequestCount"));
  assert(summaries.result.includes("não pode ser enviado"));
  for (const id of ["mcp.private-inputs.history", "mcp.private-inputs.refresh", "mcp.private-inputs.more", "mcp.private-inputs.open.<id>"]) {
    const field = page.fields.find(candidate => candidate.id === id)!;
    assert(field, id);
    for (const key of required) assert(field[key].length > (key === "availability" ? 0 : 10), `${id}/${key}`);
    assert.equal(field.availability, "human_only");
    assert.equal(field.changeOperation, null);
  }
  const open = page.fields.find(field => field.id === "mcp.private-inputs.open.<id>")!;
  assert(open.approval.includes("mcp.read") && open.approval.includes("mcp.manage"));
  assert(open.recovery.includes("mesmo ID"));
  assert(open.recovery.includes("revisão"));
  assert(page.fields.find(field => field.id === "mcp.input.respond")!.recovery.includes("sem reenvio automático"));
});

test("progressive catalog includes new pages after final overlays; main turn instructions retain their bound", () => {
  const app = readFileSync(resolve("packages/context/src/app-configuration-guide.ts"), "utf8"), guide = readFileSync(resolve("packages/context/src/harness-guide.ts"), "utf8");
  assert(app.includes(`APP_CONFIGURATION_GUIDE_VERSION = "${APP_CONFIGURATION_GUIDE_VERSION}"`)); assert(app.includes("...MCP_COMPLETE_GUIDE_PAGES")); assert(app.includes(".map(applyMcpCompleteGuideOverlay).map(augmentMcpAppleControls).map(applyAssistantFirstRunGuideOverlay).map(applyAudioMacPreparationGuideOverlay).map(applyIOSQRPairingGuideOverlay).map(freezePage)"));
  const main = /const markdown = `([\s\S]*?)`;\n\nexport const DEXTER_HARNESS_GUIDE/.exec(guide)![1]!; assert(main.length < 6144); assert(main.includes("connection-setup")); assert(!main.includes("POST /v1/mcp/input-requests"));
  assert.equal(DEXTER_HARNESS_GUIDE.version,APP_CONFIGURATION_GUIDE_VERSION); assert(guide.includes(`const version = "${DEXTER_HARNESS_GUIDE.version}"`)); assert.match(createHash("sha256").update(source).digest("hex"), /^[a-f0-9]{64}$/);
});
