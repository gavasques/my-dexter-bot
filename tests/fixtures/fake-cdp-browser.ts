// Synthetic Chromium stand-in for tests/device-local-capabilities.test.ts. The real ChromePipeDriver spawns
// it; it speaks the DevTools protocol on fds 3/4 (NUL-framed JSON) with no network and no real browser.
// The test copies the compiled file into a private temp dir with a `#!<node>` line; its "web" is
// `site.json` in that dir and it records what it saw in `log.jsonl` there.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// `driftTo`: after loading, the target silently ends up at that URL (stands in for an in-page move the driver
// did not see). `scriptUrl`: what page script claims `location.href` is, regardless of the real target URL.
interface Page { title?: string; text?: string; redirect?: string; subresources?: string[]; popup?: boolean; hangLoad?: boolean; crash?: boolean; setCookie?: string; more?: boolean; driftTo?: string; scriptUrl?: string }
// `targetInfoErrors`: the next N `Target.getTargetInfo` calls fail with a remote error. `targetInfoEmpty`: the
// next N answer successfully with `url: ""` (what Chromium 153 does while a navigation has not committed).
// `staleErrorLoad`: like Chromium, a refused navigation leaves an error page whose own `load` lifecycle event
// is delivered only after the next `Page.navigate` was sent. `helper`: a child process in the browser's
// process group that outlives the main process: `linger` ignores SIGTERM and only ends on SIGKILL; `flush`
// writes `helper-flushed` in this dir shortly after the main process exited, then exits (a network service
// finishing its cookie write).
interface Site {
  pages: Record<string, Page>; popupUrl?: string; ignoreClose?: boolean; targetInfoErrors?: number; targetInfoEmpty?: number;
  staleErrorLoad?: boolean; helper?: "linger" | "flush";
}
interface Target { targetId: string; type: string; url: string; intercept: boolean; waiting: boolean; sessionId: string | null; history: string[]; opener?: string }
type Message = { id: number; method: string; params?: Record<string, unknown>; sessionId?: string };

const here = dirname(fileURLToPath(import.meta.url));
const site = JSON.parse(readFileSync(join(here, "site.json"), "utf8")) as Site;
const log = (entry: Record<string, unknown>): void => { appendFileSync(join(here, "log.jsonl"), `${JSON.stringify({ pid: process.pid, ...entry })}\n`); };
const profileArg = process.argv.find((a) => a.startsWith("--user-data-dir="));
const profile = profileArg ? profileArg.slice("--user-data-dir=".length) : null;
const statePath = profile ? join(profile, "fake-state.json") : null;
const state = (statePath && existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { cookies: {} }) as { cookies: Record<string, string> };
const saveState = (): void => { if (statePath) writeFileSync(statePath, JSON.stringify(state)); };
log({ event: "launch", argv: process.argv.slice(2), home: process.env.HOME ?? null, envKeys: Object.keys(process.env).sort() });

// Sockets, not fs streams: a blocking fs read on a pipe would keep a crashed fixture from exiting.
const input = new Socket({ fd: 3, readable: true, writable: false });
const output = new Socket({ fd: 4, readable: false, writable: true });
const send = (message: Record<string, unknown>): void => { output.write(`${JSON.stringify(message)}\0`); };
const event = (method: string, params: Record<string, unknown>, sessionId?: string | null): void => { send(sessionId ? { method, params, sessionId } : { method, params }); };

let autoAttachRoot = false;
let targetInfoErrors = site.targetInfoErrors ?? 0;
let targetInfoEmpty = site.targetInfoEmpty ?? 0;
let staleLoader: string | null = null;
let nextTarget = 0;
let nextRequest = 0;
const targets = new Map<string, Target>();
const sessions = new Map<string, string>();
const paused = new Map<string, (decision: string) => void>();

function createTarget(type: string, url: string, waiting: boolean): Target {
  const target: Target = { targetId: `T${++nextTarget}`, type, url, intercept: false, waiting, sessionId: null, history: [url] };
  targets.set(target.targetId, target);
  if (autoAttachRoot) attach(target);
  return target;
}
function attach(target: Target): void {
  target.sessionId = `S${target.targetId}`;
  sessions.set(target.sessionId, target.targetId);
  event("Target.attachedToTarget", { sessionId: target.sessionId, targetInfo: { targetId: target.targetId, type: target.type, url: target.url, attached: true }, waitingForDebugger: target.waiting });
}
/** Every request of a target goes through interception when enabled; otherwise it is logged as unintercepted. */
function request(target: Target, url: string): Promise<string> {
  if (!target.intercept) { log({ event: "unintercepted", target: target.targetId, url }); return Promise.resolve("continue"); }
  const requestId = `R${++nextRequest}`;
  return new Promise((resolve) => {
    paused.set(requestId, (decision) => { log({ event: "request", target: target.targetId, url, decision }); resolve(decision); });
    event("Fetch.requestPaused", { requestId, request: { url, method: "GET" }, resourceType: "Document" }, target.sessionId);
  });
}

async function navigate(target: Target, url: string, id: number): Promise<void> {
  let current = url;
  for (let hops = 0; hops < 5; hops++) {
    const decision = await request(target, current);
    if (decision !== "continue") {
      send({ id, sessionId: target.sessionId, result: { frameId: target.targetId, loaderId: `L${id}`, errorText: "net::ERR_BLOCKED_BY_CLIENT" } });
      if (site.staleErrorLoad) staleLoader = `L${id}`;
      return;
    }
    const next = site.pages[current]?.redirect;
    if (!next) break;
    current = next;
  }
  const page = site.pages[current] ?? { title: "404", text: "missing" };
  target.url = current;
  target.history.push(current);
  if (page.setCookie) { state.cookies[new URL(current).origin] = page.setCookie; saveState(); }
  if (page.crash) { log({ event: "crash" }); process.exit(9); }
  send({ id, sessionId: target.sessionId, result: { frameId: target.targetId, loaderId: `L${id}` } });
  event("Page.frameNavigated", { frame: { id: target.targetId, loaderId: `L${id}`, url: current } }, target.sessionId);
  for (const sub of page.subresources ?? []) await request(target, sub);
  if (page.popup) {
    const popup = createTarget("page", "", true);
    popup.opener = target.targetId;
    log({ event: "popup_created", target: popup.targetId });
  }
  if (page.hangLoad) { log({ event: "hang", url: current }); return; }
  event("Page.lifecycleEvent", { frameId: target.targetId, loaderId: `L${id}`, name: "load", timestamp: 1 }, target.sessionId);
  event("Page.loadEventFired", { timestamp: 1 }, target.sessionId);
  if (page.driftTo) target.url = page.driftTo;
}

function handle(message: Message): void {
  const { id, method, sessionId } = message;
  const params = message.params ?? {};
  const ok = (result: Record<string, unknown> = {}): void => { send({ id, result, ...(sessionId ? { sessionId } : {}) }); };
  const target = sessionId ? targets.get(sessions.get(sessionId) ?? "") ?? null : null;
  log({ event: "command", method, session: sessionId ?? null, ...(method === "Runtime.evaluate" ? { expression: params.expression } : {}) });
  switch (method) {
    case "Browser.getVersion": ok({ product: "FakeChrome/1.0" }); return;
    case "Browser.setDownloadBehavior": case "Page.enable": case "Page.setLifecycleEventsEnabled": ok(); return;
    case "Target.setAutoAttach":
      ok();
      if (!sessionId) { autoAttachRoot = true; for (const t of targets.values()) if (!t.sessionId) attach(t); }
      return;
    case "Target.createTarget": { const t = createTarget("page", String(params.url), true); ok({ targetId: t.targetId }); return; }
    case "Target.closeTarget": {
      const t = targets.get(String(params.targetId));
      if (t) {
        targets.delete(t.targetId);
        log({ event: "closed_target", target: t.targetId });
        if (t.sessionId) event("Target.detachedFromTarget", { sessionId: t.sessionId, targetId: t.targetId });
      }
      ok({ success: Boolean(t) });
      return;
    }
    case "Fetch.enable": if (target) target.intercept = true; ok(); return;
    case "Fetch.continueRequest": case "Fetch.failRequest": {
      const resolve = paused.get(String(params.requestId));
      paused.delete(String(params.requestId));
      resolve?.(method === "Fetch.continueRequest" ? "continue" : "blocked");
      ok();
      return;
    }
    case "Runtime.runIfWaitingForDebugger":
      if (target) {
        target.waiting = false;
        if (target.opener && site.popupUrl) void request(target, site.popupUrl);
      }
      ok();
      return;
    case "Page.navigate":
      if (target && staleLoader !== null) {
        // The error page of the refused navigation finishes loading now, after the new navigation was sent.
        event("Page.lifecycleEvent", { frameId: target.targetId, loaderId: staleLoader, name: "load", timestamp: 1 }, target.sessionId);
        event("Page.loadEventFired", { timestamp: 1 }, target.sessionId);
        log({ event: "stale_load", loader: staleLoader });
        staleLoader = null;
      }
      if (target) void navigate(target, String(params.url), id); else ok();
      return;
    case "Target.getTargetInfo": {
      if (targetInfoErrors > 0) { targetInfoErrors -= 1; log({ event: "target_info_error" }); send({ id, error: { code: -32000, message: "fake: transient" } }); return; }
      const t = targets.get(String(params.targetId));
      if (!t) { send({ id, error: { code: -32602, message: "fake: no target" } }); return; }
      const empty = targetInfoEmpty > 0;
      if (empty) { targetInfoEmpty -= 1; log({ event: "target_info_empty" }); }
      ok({ targetInfo: { targetId: t.targetId, type: t.type, url: empty ? "" : t.url, attached: Boolean(t.sessionId) } });
      return;
    }
    case "Page.getNavigationHistory": ok({ currentIndex: (target?.history.length ?? 1) - 1, entries: (target?.history ?? ["about:blank"]).map((url) => ({ url })) }); return;
    case "Runtime.evaluate": {
      const url = target?.url ?? "about:blank";
      const page = site.pages[url] ?? { title: "", text: "" };
      const origin = url.startsWith("http") ? new URL(url).origin : "";
      const text = (page.text ?? "").replace("{{cookie}}", state.cookies[origin] ?? "none");
      ok({ result: { type: "object", value: { title: page.title ?? "", url: page.scriptUrl ?? url, text, more: page.more === true } } });
      return;
    }
    case "Browser.close":
      log({ event: "browser_close" });
      ok();
      if (site.ignoreClose) return;
      saveState();
      setImmediate(() => { process.exit(0); });
      return;
    default: send({ id, error: { code: -32601, message: `fake: ${method} not supported` } });
  }
}

let buffer = Buffer.alloc(0);
input.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk as Buffer]);
  for (;;) {
    const end = buffer.indexOf(0);
    if (end < 0) break;
    const frame = buffer.subarray(0, end).toString("utf8");
    buffer = buffer.subarray(end + 1);
    handle(JSON.parse(frame) as Message);
  }
});
// Like Chromium with --remote-debugging-pipe: when the controlling process goes away, the browser exits.
input.on("end", () => { log({ event: "pipe_closed" }); if (!site.ignoreClose) process.exit(0); });
createTarget("page", "about:blank", false);

if (site.helper) {
  const marker = join(here, "helper-flushed");
  const script = site.helper === "linger"
    ? `process.on("SIGTERM", () => {}); setInterval(() => {}, 1 << 30);`
    // Finishes its "write" only after the main process is gone (its stdin pipe closed).
    : `process.stdin.on("data", () => {}); process.stdin.on("end", () => { setTimeout(() => { require("node:fs").writeFileSync(${JSON.stringify(marker)}, "1"); process.exit(0); }, 150); });`;
  const helper = spawn(process.execPath, ["-e", script], { stdio: ["pipe", "ignore", "ignore"] });
  log({ event: "helper", helperPid: helper.pid ?? null, kind: site.helper });
}
