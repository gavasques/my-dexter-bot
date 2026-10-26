import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { createRequire } from "node:module";
import type { AppConfigurationGuideField, AppConfigurationGuidePage } from "@dexter/context";

// Read/transpile the exact author sources (type-only imports) without rebuilding another worker's artifacts.
const ts = createRequire(import.meta.url)("typescript") as typeof import("typescript");
type GuideInput = Pick<AppConfigurationGuidePage, "id" | "title" | "scope" | "availability" | "sourcePaths" | "notes" | "fields">;
async function authored<T>(path: string): Promise<T> {
  const output = ts.transpileModule(readFileSync(resolve(path), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText;
  return await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`) as T;
}
const apple = await authored<{ MCP_APPLE_CONTROL_GUIDE_VERSION: string; MCP_APPLE_CONTROL_GUIDE_FIELDS: Readonly<Record<string, readonly AppConfigurationGuideField[]>>;
  MCP_APPLE_CONTROL_LOGICAL_AX: Readonly<Record<string, string>>; augmentMcpAppleControls(page: GuideInput): GuideInput }>("packages/context/src/mcp-apple-control-guide.ts");
const mcp = await authored<{ MCP_COMPLETE_GUIDE_PAGES: readonly GuideInput[]; applyMcpCompleteGuideOverlay(input: GuideInput): GuideInput }>("packages/context/src/mcp-complete-configuration-guide.ts");

// `<accountId>` in a record ID and `\(account.id)` in Swift are the same dynamic segment.
const pattern = (id: string): string => id.replace(/<[A-Za-z]+>/g, "*");
function swiftIdentifiers(file: string): Set<string> {
  const source = readFileSync(resolve("apps/apple/SharedApp/Sources", file), "utf8");
  const ids = new Set<string>();
  for (const match of source.matchAll(/accessibilityIdentifier\("((?:[^"\\]|\\\((?:[^()]|\([^()]*\))*\))*)"\)/g)) ids.add(match[1]!.replace(/\\\((?:[^()]|\([^()]*\))*\)/g, "*"));
  return ids;
}
const views = swiftIdentifiers("ManagedConnectAppsViews.swift");
// The row view builds `identifier`, `.facts`, `.primary` and `.inspect` by concatenation for these two prefixes.
for (const row of ["settings.connections.account.*", "settings.connections.native.*"]) for (const suffix of ["", ".facts", ".primary", ".inspect"]) views.add(row + suffix);
const manager = swiftIdentifiers("McpConnectionsView.swift");
const pairing = new Set([...swiftIdentifiers("ConnectOtherBaseSheet.swift"), ...swiftIdentifiers("OwnerPairingOfferViews.swift")]);
// Presentation-only containers of the connections views: no gesture of their own.
const containers = new Set(["settings.connections.accounts", "settings.connections.accounts.empty", "settings.connections.requests", "settings.connections.account.*",
  "settings.connections.account.*.facts", "settings.connections.native.*", "settings.connections.native.*.facts", "settings.connections.reconnect-review",
  "settings.connections.authorization", "settings.connections.notice", "settings.connections.paired", "settings.connections.platform", "settings.connections.unconfigured",
  "settings.connections.unavailable", "settings.connections.requirements", "settings.connections.requirements.list", "settings.connections.service.*", "connections.fact.*",
  "connections.inspector", "connections.inspector.facts", "connections.inspector.access", "connections.inspector.bot.*.tools",
  "connections.inspector.bot.*.current", "connections.request.*", "connections.request-review", "connections.request-review.notice", "connections.request-review.pins-unavailable",
  "connections.request-review.native-no-tools", "connections.remote", "connections.remote.no-scope", "connections.remote.offline", "connections.remote.notice",
  "connections.remote.native.*", "chat.connection-requests", "chat.mcp-private-inputs", "chat.mcp-private-inputs.notice", "mcp.private-input.*", "mcp.private-input.*.review",
  ]);
const managerInteractive = ["mcp.discover-confirm", "mcp.oauth-read-tools-after-login", "mcp.setup-request.allow", "mcp.setup-request.decline", "mcp.setup-request.check"];
const pairingInteractive = ["pairing-offer.scope.*", "owner-pairing-offer.scope.*"];
// Containers Root asked to document as controls of their own (they present cards and a GET).
const requiredContainers = ["chat.connection-requests", "chat.mcp-private-inputs", "mcp.setup-request"];

const records = Object.entries(apple.MCP_APPLE_CONTROL_GUIDE_FIELDS).flatMap(([page, fields]) => fields.map(field => ({ page, field })));
const byPattern = new Map(records.map(value => [pattern(value.field.id), value]));
const coverage = new Map<string, string>([...records.map(value => [pattern(value.field.id), value.page] as const), ...Object.entries(apple.MCP_APPLE_CONTROL_LOGICAL_AX)]);
const required = [...[...views].filter(id => !containers.has(id)), ...managerInteractive, ...pairingInteractive, ...requiredContainers];
const keys = ["id", "title", "purpose", "scope", "read", "change", "approval", "result", "recovery", "availability", "readOperation", "changeOperation"];

test("every interactive Apple accessibility identifier has its own control record on a guide page", () => {
  assert(views.size > 90, "the scan found the connections views' identifiers");
  for (const id of [...managerInteractive, "mcp.setup-request"]) assert(manager.has(id), `manager identifier is real: ${id}`);
  for (const id of pairingInteractive) assert(pairing.has(id), `pairing identifier is real: ${id}`);
  const missing = required.filter(id => !coverage.has(id));
  assert.deepEqual(missing, [], "interactive identifiers without a record");
  // No phantom record: every record is a real identifier of the Apple views.
  const real = new Set([...views, ...manager, ...pairing]);
  assert.deepEqual(records.map(value => pattern(value.field.id)).filter(id => !real.has(id)), []);
  assert.equal(byPattern.size, records.length, "one record per AX pattern");
});

test("apple-ux §5 interactive rows are all covered by records (not only by markdown mentions)", () => {
  const doc = readFileSync(resolve("tests/fixtures/mcp-apple-ux-inventory.md"), "utf8");
  const inventory = doc.slice(doc.indexOf("## 5."), doc.indexOf("## 6."));
  const interactive = inventory.split("\n").filter(line => /^\| .* \| I \|/.test(line))
    .flatMap(line => [...line.split(" | ")[0]!.matchAll(/`([^`]+)`/g)].map(match => match[1]!));
  assert(interactive.length > 70, "the §5 inventory lists the interactive identifiers");
  assert.deepEqual(interactive.filter(id => !coverage.has(id)), []);
});

test("each record ships the eight operational fields plus its actual operation and logical control", () => {
  const routes = readFileSync(resolve("packages/hub/src/http-routes.ts"), "utf8");
  const routed = (operation: string): boolean => {
    const [method, path] = operation.split(" ");
    return routes.includes(`app.${method!.toLowerCase()}("${path}"`) || routes.includes(`route("${method!.toLowerCase()}","${path}"`);
  };
  for (const { page, field } of records) {
    const where = `${page}/${field.id}`;
    assert.deepEqual(Object.keys(field).sort(), [...keys].sort(), where);
    assert(Object.isFrozen(field), where);
    assert.match(field.id, /^[a-z][a-z0-9.-]*(?:<[A-Za-z]+>[a-z0-9.-]*)*$/, where);
    for (const key of ["title", "purpose", "scope", "read", "change", "approval", "result", "recovery"] as const) assert(field[key].length > 10 || (key === "title" && field[key].length > 3), `${where}/${key}`);
    assert(["harness_when_exposed", "ui_only", "human_only", "read_only", "unavailable"].includes(field.availability), where);
    assert(field.purpose.includes("Controle lógico: "), where);
    for (const operation of [field.readOperation, field.changeOperation]) if (operation) assert(routed(operation), `${where}: ${operation} is a real hub route`);
    assert(!field.readOperation?.startsWith("dexter.harness") && !field.changeOperation?.startsWith("dexter.harness"), `${where}: no bot tool is implied`);
    if (field.changeOperation) {
      assert.equal(field.availability, "human_only", where);
      assert(field.change.includes(field.changeOperation.split(" ")[1]!), `${where}: change names its route`);
      assert(/nada é reenviado automaticamente/.test(field.recovery), `${where}: uncertain results are read back, never resubmitted`);
      assert(/Gesto humano/.test(field.approval), where);
    }
  }
});

test("close/back stay navigation, presets/toggles stay local and Conferir is GET-only without resubmission", () => {
  const navigation = records.filter(({ field }) => /\.(close|done|back|dismiss)$/.test(field.id));
  assert(navigation.length >= 8);
  for (const { field } of navigation) { assert.equal(field.availability, "ui_only", field.id); assert.equal(field.changeOperation, null, field.id); assert(field.change.includes("Somente navegação"), field.id); }
  const local = records.filter(({ field }) => /\.(presets\.<connectionId>|tool\.<[A-Za-z]+>(\.<toolName>)?|field\.<fieldName>|account\.<accountId>|connection\.<connectionId>|review-button|rename\.field)$/.test(field.id)
    && !field.id.startsWith("connections.remote."));
  assert(local.length >= 8);
  for (const { field } of local) { assert.equal(field.changeOperation, null, field.id); assert(field.change.includes("nada é enviado"), field.id); }
  const checks = records.filter(({ field }) => /(\.check|access-check|\.reload|\.refresh)$/.test(field.id));
  assert(checks.length >= 15);
  for (const { field } of checks) {
    assert.equal(field.availability, "read_only", field.id); assert.equal(field.changeOperation, null, field.id);
    assert(field.readOperation?.startsWith("GET "), field.id); assert(field.change.includes("Nunca reenvia POST/PATCH"), field.id);
  }
  const presets = byPattern.get("connections.request-review.presets.*")!.field; assert(presets.change.includes("Só leitura") && presets.result.includes("nunca salva"));
});

test("access records state terminal receipts honestly and allow only a new human request", () => {
  for (const id of ["settings.connections.access.check", "connections.inspector.access.check", "connections.request-review.access-check", "connections.inspector.bot.*.save",
    "connections.inspector.bot.*.revoke", "connections.request-review.allow"]) {
    const field = byPattern.get(id)!.field, text = `${field.result} ${field.recovery}`;
    for (const value of ["not_applied", "superseded", "nunca \"acesso salvo\"", "novo clientRequestId", "nenhum PATCH é repetido automaticamente"]) assert(text.includes(value), `${id}: ${value}`);
  }
  const save = byPattern.get("connections.inspector.bot.*.save")!.field; assert(save.change.includes("toolNames") && save.changeOperation === "PATCH /v1/connections/accounts/:accountId/access");
  const allow = byPattern.get("connections.request-review.allow")!.field; assert(allow.change.includes("1..5") && allow.result.includes("uma continuação canônica"));
  const send = byPattern.get("mcp.private-input.*.send")!.field; assert(send.change.includes("approve_exact_input") && send.approval.includes("nunca há autoresposta"));
  for (const id of ["mcp.private-input.*.decline", "mcp.private-input.*.cancel"]) assert(byPattern.get(id)!.field.change.includes("sem conteúdo nem approval"), id);
  const resume = byPattern.get("connections.request.*.resume")!.field; assert(resume.change.includes("Nunca cria link novo") && resume.changeOperation === null);
  const rename = byPattern.get("connections.inspector.rename.save")!.field; assert(rename.change.includes("settings.connections.label.save"));
  for (const id of pairingInteractive) { const field = byPattern.get(id)!.field; assert(field.change.includes("manage não implica read") && field.recovery.includes("não herda")); }
});

test("augment keeps stable logical IDs, appends records once and leaves other pages untouched", () => {
  const stub = (id: string): GuideInput => ({ id, title: id, scope: "base", availability: "human_only", sourcePaths: ["existing.ts"], notes: ["existing"],
    fields: [Object.freeze({ id: "existing.control", title: "Existing", purpose: "Existing purpose.", scope: "base", read: "GET existing", change: "none", approval: "owner",
      result: "facts", recovery: "GET", availability: "read_only" as const, readOperation: null, changeOperation: null })] });
  for (const page of [...Object.keys(apple.MCP_APPLE_CONTROL_GUIDE_FIELDS), "mcp-authentication"]) {
    const base = mcp.MCP_COMPLETE_GUIDE_PAGES.find(value => value.id === page) ?? stub(page);
    const overlaid = mcp.applyMcpCompleteGuideOverlay(base), composed = apple.augmentMcpAppleControls(overlaid);
    assert.deepEqual(composed.fields.slice(0, overlaid.fields.length), overlaid.fields, `${page}: existing fields first and unchanged`);
    const ids = new Set(composed.fields.map(field => field.id));
    for (const [id, where] of coverage) if (where === page) assert([...ids].some(value => pattern(value) === id), `${page} contains ${id}`);
    assert.equal(ids.size, composed.fields.length, `${page}: unique IDs`);
    const twice = apple.augmentMcpAppleControls(composed);
    assert.equal(twice.fields.length, composed.fields.length); assert.equal(twice.notes.length, composed.notes.length);
    if (apple.MCP_APPLE_CONTROL_GUIDE_FIELDS[page]) assert(composed.sourcePaths.includes("apps/apple/SharedApp/Sources/ManagedConnectAppsViews.swift"), page);
  }
  const kept = stub("connections"), own = { ...kept.fields[0]!, id: "connections.inspector.close", title: "Logical owner text" };
  const composed = apple.augmentMcpAppleControls({ ...kept, fields: [own] });
  assert.equal(composed.fields.find(field => field.id === "connections.inspector.close")!.title, "Logical owner text", "existing record wins");
  const other = stub("skills"); assert.equal(apple.augmentMcpAppleControls(other), other);
  assert.match(apple.MCP_APPLE_CONTROL_GUIDE_VERSION, /^\d+\.\d+\.\d+$/);
});

test("final composed catalog pages contain every Apple control (Root's final overlay)", async () => {
  const app = readFileSync(resolve("packages/context/src/app-configuration-guide.ts"), "utf8");
  assert(app.includes("augmentMcpAppleControls"), "compose augmentMcpAppleControls at the final overlay of app-configuration-guide.ts");
  const { readAppConfigurationGuidePage, APP_CONFIGURATION_GUIDE_PAGES } = await import("@dexter/context");
  for (const [id, page] of coverage) {
    const composed = readAppConfigurationGuidePage(page);
    const field = composed.fields.find(value => pattern(value.id) === id);
    assert(field, `${page} composes ${id}`);
    assert(composed.markdown.includes(`ID do controle: ${field.id}\n- Propósito: ${field.purpose}`), `${page} renders ${id} as a control, not a mention`);
    assert(APP_CONFIGURATION_GUIDE_PAGES.find(value => value.id === page)!.fields.some(value => value.id === field.id), `${page} index lists ${id}`);
  }
});
