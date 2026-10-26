import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  AppendMessageSchema, ApprovalDecisionSchema, CreateBotSchema, DeviceInputSchema,
  PROTOCOL_VERSION, ToolRequestSchema, StartTurnSchema, RenameDeviceSchema, exportContracts,
  type DeviceView, type Action,
} from "@dexter/contracts";
import type { ClientDeviceRole, ClientDeviceScope, HostStore } from "./store.js";
import { HostError } from "./errors.js";
import type { ConversationRuntime } from "./runtime.js";

/** Trusted structural device seam. No TLS material or enrollment authority is accepted from HTTP bodies. */
export interface HostDevicePort {
  list(): DeviceView[];
  get(id: string): DeviceView;
  rename(id: string, input: unknown): DeviceView;
  revoke(id: string): DeviceView;
  dispatch(actionId: string): Promise<Action>;
  status(): { listening: boolean; pendingDispatches: number };
}

/** Which channel and key namespace a canonical device is bound to. `unpaired` has no active binding anywhere. */
export type HostPeerRole = "agent-mac" | ClientDeviceRole | "unpaired";
export type HostPeerView = DeviceView & { role: HostPeerRole };
/**
 * Trusted unified projection of every canonical device with paired/presence/role taken from the registry that
 * owns its binding. Revocation is canonical first and coordinated with that registry and its live sockets.
 */
export interface HostPeerPort {
  list(): HostPeerView[];
  get(id: string): HostPeerView;
  rename(id: string, input: unknown): HostPeerView;
  revoke(id: string): HostPeerView;
}
export interface HostGrantPort {
  /** Grants of one owner bot for every paired agent-mac destination/operation; absent means default deny. */
  list(botId: string): unknown;
  /** Strict compare-and-set of one grant; never creates authority for client roles. */
  put(input: unknown): unknown;
}

/**
 * Authority of one paired app client request, created exclusively by the mutual-TLS listener from the peer
 * certificate and the approved binding. It is passed as a Hono binding, never read from headers, URL or body.
 */
export interface HostRequestAuthority {
  readonly principal: "paired-client";
  readonly installationId: string;
  readonly ownerId: string;
  readonly deviceId: string;
  readonly role: ClientDeviceRole;
  readonly scopes: readonly ClientDeviceScope[];
  readonly pinGeneration: number;
  readonly bindingRevision: number;
  /** Synchronous: throws `HostError("forbidden")` unless the TLS binding, device and listener are still current. */
  assertCurrent(): void;
  /** The current request revoked its own device; the listener may answer with one minimal ACK and no data. */
  noteSelfRevoke(deviceId: string): void;
}
export interface AuthorizedHostBindings { authority: HostRequestAuthority }

const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;
/** Remote pages are smaller: every response of the app listener is buffered with a fixed Content-Length. */
const REMOTE_MAX_PAGE = 100;
const REMOTE_DEFAULT_NUMERIC_PAGE = 1;
const REMOTE_DEFAULT_PAGE = 25;
const ID_CURSOR = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

function pagination(after: string | undefined, limit: string | undefined, max = 500): [number, number] {
  if ([after, limit].some((value) => value !== undefined && !/^(0|[1-9]\d*)$/.test(value))) {
    throw new HostError("invalid_input", "Cursor and limit must be decimal integers.");
  }
  const cursor = Number(after ?? 0);
  const pageSize = Number(limit ?? (max === REMOTE_MAX_PAGE ? REMOTE_DEFAULT_NUMERIC_PAGE : 100));
  if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > max) {
    throw new HostError("invalid_input", max === 500 ? "Invalid cursor or limit (1–500)." : `Invalid cursor or limit (1–${max}).`);
  }
  return [cursor, pageSize];
}
/** Opaque id cursor over a canonical, stably ordered owner list. An unknown cursor is refused, never restarted. */
function idPage<T extends { id: string }>(items: readonly T[], after: string | undefined, limit: string | undefined): { items: T[]; nextCursor: string | null } {
  if (limit !== undefined && !/^[1-9]\d{0,2}$/.test(limit)) throw new HostError("invalid_input", "Invalid limit.");
  const size = Number(limit ?? REMOTE_DEFAULT_PAGE);
  if (size > REMOTE_MAX_PAGE) throw new HostError("invalid_input", `Invalid limit (1–${REMOTE_MAX_PAGE}).`);
  let start = 0;
  if (after !== undefined) {
    if (!ID_CURSOR.test(after)) throw new HostError("invalid_input", "Invalid cursor.");
    const index = items.findIndex((item) => item.id === after);
    if (index < 0) throw new HostError("invalid_input", "Unknown cursor.");
    start = index + 1;
  }
  const page = items.slice(start, start + size);
  return { items: page, nextCursor: start + size < items.length ? page.at(-1)!.id : null };
}

function errorResponse(error: Error, c: Context): Response {
  if (error instanceof HostError) {
    const status = error.code === "not_found" ? 404 : error.code === "forbidden" ? 403 :
      error.code === "invalid_input" ? 400 : error.code === "device_unavailable" ? 503 : 409;
    return c.json({ error: error.code, message: error.message }, status);
  }
  if (error instanceof SyntaxError || error.name === "ZodError") {
    return c.json({ error: "invalid_input", message: "Request does not match the contract." }, 400);
  }
  // Never echo exception messages or payloads into logs/responses.
  return c.json({ error: "internal_error", message: "Host operation failed." }, 500);
}

type Method = "get" | "post" | "patch" | "put";
/** Scope required on the paired-client router; `local` routes are refused there (403) before any work. */
type Access = ClientDeviceScope | "session" | "local";
interface RouteIo {
  /** Parsed JSON body. On the paired-client router the binding is re-checked synchronously after the await. */
  body(c: Context): Promise<unknown>;
  /** Executes a canonical operation in the same synchronous section as the current-authority check. */
  admit<T>(operation: () => T): T;
  remote: HostRequestAuthority | null;
}
type Handler = (c: Context, io: RouteIo) => Response | Promise<Response>;
interface Route { method: Method; path: string; access: Access; handler: Handler }

interface Controllers {
  store: HostStore;
  runtime: ConversationRuntime | undefined;
  devices: Readonly<HostDevicePort> | undefined;
}

/** Canonical controllers shared by the local development app and the authorized paired-client router. */
function sharedRoutes({ store, runtime, devices }: Controllers): Route[] {
  const notConnected = (c: Context): Response => c.json({ error: "not_connected", message: "Engine execution is disabled." }, 503);
  const legacyView = (id: string): DeviceView => ({ ...store.getDevice(id), presence: store.devicePresence(id), paired: false });
  const r = (method: Method, path: string, access: Access, handler: Handler): Route => ({ method, path, access, handler });
  return [
    r("get", "/v1/contracts", "session", (c) => c.json({ protocolVersion: PROTOCOL_VERSION, schemas: exportContracts() })),
    r("post", "/v1/bots", "chat.write", async (c, io) => {
      const input = CreateBotSchema.parse(await io.body(c));
      return c.json(io.admit(() => store.createBot(input)), 201);
    }),
    r("get", "/v1/bots/:botId", "chat.read", (c) => c.json(store.getBot(c.req.param("botId")!))),
    r("post", "/v1/bots/:botId/threads", "chat.write", (c, io) => c.json(io.admit(() => store.createThread(c.req.param("botId")!)), 201)),
    r("get", "/v1/threads/:threadId", "chat.read", (c) => c.json(store.getThread(c.req.param("threadId")!))),
    r("post", "/v1/threads/:threadId/messages", "chat.write", async (c, io) => {
      const input = AppendMessageSchema.parse(await io.body(c));
      return c.json(io.admit(() => store.appendMessage(c.req.param("threadId")!, input)), 201);
    }),
    r("get", "/v1/threads/:threadId/messages", "chat.read", (c, io) => {
      const [after, limit] = pagination(c.req.query("after"), c.req.query("limit"), io.remote ? REMOTE_MAX_PAGE : 500);
      const items = store.listMessages(c.req.param("threadId")!, after, limit);
      return c.json({ items, nextCursor: items.at(-1)?.cursor ?? after });
    }),
    r("get", "/v1/events", "chat.read", (c, io) => {
      const [after, limit] = pagination(c.req.query("after"), c.req.query("limit"), io.remote ? REMOTE_MAX_PAGE : 500);
      const items = store.listEvents(after, limit);
      return c.json({ items, nextCursor: items.at(-1)?.cursor ?? after });
    }),
    r("get", "/v1/threads/:threadId/turns", "chat.read", (c, io) => {
      const [after, limit] = pagination(c.req.query("after"), c.req.query("limit"), io.remote ? REMOTE_MAX_PAGE : 500);
      const items = store.listTurns(c.req.param("threadId")!, after, limit);
      return c.json({ items, nextCursor: items.at(-1)?.cursor ?? after });
    }),
    r("post", "/v1/threads/:threadId/turns", "chat.write", async (c, io) => {
      if (!runtime) return notConnected(c);
      const input = StartTurnSchema.parse(await io.body(c));
      const started = io.admit(() => runtime.startTurn(c.req.param("threadId")!, input));
      return c.json(started.turn, started.created ? 201 : 200);
    }),
    r("get", "/v1/turns/:turnId", "chat.read", (c) => c.json(store.getTurn(c.req.param("turnId")!))),
    r("get", "/v1/turns/:turnId/events", "chat.read", (c, io) => {
      const [after, limit] = pagination(c.req.query("after"), c.req.query("limit"), io.remote ? REMOTE_MAX_PAGE : 500);
      const items = store.listTurnEvents({ turnId: c.req.param("turnId")! }, after, limit);
      return c.json({ items, nextCursor: items.at(-1)?.cursor ?? after });
    }),
    r("post", "/v1/turns/:turnId/cancel", "chat.write", (c, io) => {
      if (!runtime) return notConnected(c);
      return c.json(io.admit(() => runtime.cancelTurn(c.req.param("turnId")!)));
    }),
    r("post", "/v1/threads/:threadId/resume-queued", "chat.write", (c, io) => {
      if (!runtime) return notConnected(c);
      return c.json({ resumed: io.admit(() => runtime.resumeQueued(c.req.param("threadId")!)) });
    }),
    // Raw action creation/dispatch can bypass the turn-owned MCP path: local development only.
    r("post", "/v1/actions", "local", async (c, io) => c.json(store.requestAction(ToolRequestSchema.parse(await io.body(c))), 201)),
    r("get", "/v1/actions/:actionId", "approvals.read", (c) => c.json(store.getAction(c.req.param("actionId")!))),
    r("post", "/v1/actions/:actionId/decisions", "approvals.decide", async (c, io) => {
      const input = ApprovalDecisionSchema.parse(await io.body(c));
      return c.json(io.admit(() => (runtime ?? store).decideAction(c.req.param("actionId")!, input)));
    }),
    // Enrollment requires an owner-approved claim; presence requires an authenticated channel.
    r("post", "/v1/devices", "local", async (c, io) => {
      if (devices) throw new HostError("forbidden", "Device enrollment requires cryptographic pairing.");
      return c.json(store.registerDevice(DeviceInputSchema.parse(await io.body(c))), 201);
    }),
    r("post", "/v1/devices/:deviceId/heartbeat", "local", (c) => {
      if (devices) throw new HostError("forbidden", "Presence requires an authenticated device poll.");
      return c.json(store.heartbeatDevice(c.req.param("deviceId")!));
    }),
    r("post", "/v1/actions/:actionId/dispatch", "local", async (c, io) => {
      const body: unknown = await io.body(c);
      if (body === null || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0)
        throw new HostError("invalid_input", "Dispatch accepts only an empty object.");
      if (!devices) throw new HostError("device_unavailable", "Device dispatch is not configured.");
      return c.json(await devices.dispatch(c.req.param("actionId")!));
    }),
    // Local device routes keep their legacy fallback; the remote router registers its own projection routes.
    r("get", "/v1/devices/:deviceId", "local", (c) =>
      c.json(devices ? devices.get(c.req.param("deviceId")!) : legacyView(c.req.param("deviceId")!))),
    r("patch", "/v1/devices/:deviceId", "local", async (c, io) => {
      const input = RenameDeviceSchema.parse(await io.body(c)), id = c.req.param("deviceId")!;
      if (devices) return c.json(devices.rename(id, input));
      store.renameDevice(id, input); return c.json(legacyView(id));
    }),
    r("post", "/v1/devices/:deviceId/revoke", "local", (c) => {
      const id = c.req.param("deviceId")!;
      if (devices) return c.json(devices.revoke(id));
      store.revokeDevice(id); return c.json(legacyView(id));
    }),
  ];
}

/** Local development API. Device enrollment here is not remote cryptographic pairing. */
export function createHostApp(store: HostStore, options: { runtime?: ConversationRuntime; devices?: Readonly<HostDevicePort> } = {}): Hono {
  const app = new Hono();
  const runtime = options.runtime;
  const devices = options.devices;
  app.use("*", async (c, next) => {
    const url = new URL(c.req.url);
    const host = c.req.header("host") ?? url.host;
    if (!LOOPBACK_HOST.test(host) || !LOOPBACK_HOST.test(url.host)) {
      return c.json({ error: "forbidden", message: "Development API accepts loopback only." }, 403);
    }
    const origin = c.req.header("origin");
    if (origin !== undefined && origin !== url.origin) {
      return c.json({ error: "forbidden", message: "Cross-origin requests are not allowed." }, 403);
    }
    if (["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method) &&
        c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      return c.json({ error: "invalid_input", message: "Use application/json." }, 415);
    }
    await next();
  });
  // 32,768 UTF-16 units may require six JSON bytes each when escaped.
  app.use("*", bodyLimit({ maxSize: 262_144, onError: (c) => c.json({ error: "invalid_input", message: "Request too large." }, 413) }));
  app.notFound((c) => c.json({ error: "not_found", message: "Route not found." }, 404));
  app.onError(errorResponse);

  app.get("/health", (c) => c.json({
    protocolVersion: PROTOCOL_VERSION, mode: "local-development", hostId: store.hostId,
    engineRouting: runtime ? "connected" : "not_connected", remotePairing: "not_implemented", state: store.summary(),
    runtime: runtime?.status() ?? null,
    deviceChannel: devices?.status() ?? { listening: false, pendingDispatches: 0 },
  }));
  app.get("/v1/bots", (c) => c.json({ items: store.listBots() }));
  app.get("/v1/actions", (c) => c.json({ items: store.listActions() }));
  const legacyView = (id: string): DeviceView => ({ ...store.getDevice(id), presence: store.devicePresence(id), paired: false });
  app.get("/v1/devices", (c) => c.json({ items: devices ? devices.list() : store.listDevices().map(device => legacyView(device.id)) }));
  const io: RouteIo = { body: (c) => c.req.json(), admit: (operation) => operation(), remote: null };
  for (const route of sharedRoutes({ store, runtime, devices })) app[route.method](route.path, (c) => route.handler(c, io));
  return app;
}

export interface AuthorizedHostRouterOptions {
  runtime?: ConversationRuntime;
  /** Unified device projection; without it device routes answer 503. */
  peers?: Readonly<HostPeerPort>;
  /** Agent-mac grant administration; without it grant routes answer 503. */
  grants?: Readonly<HostGrantPort>;
}

/**
 * Router for paired app clients. It has no loopback/Host/Origin trust: authority arrives only as the
 * `authority` binding supplied by the mutual-TLS listener, and every route checks an exact approved scope.
 * Body-carrying routes re-check the binding synchronously after reading JSON, immediately before the
 * canonical operation, with no await in between. It never rewrites a request into the local app.
 */
export function createAuthorizedHostRouter(store: HostStore, options: AuthorizedHostRouterOptions = {}): Hono<{ Bindings: AuthorizedHostBindings }> {
  const app = new Hono<{ Bindings: AuthorizedHostBindings }>();
  const { runtime, peers, grants } = options;
  const authority = (c: Context): HostRequestAuthority => {
    const value = (c.env as Partial<AuthorizedHostBindings> | undefined)?.authority;
    if (!value || value.principal !== "paired-client" || typeof value.assertCurrent !== "function"
      || value.installationId !== store.hostId || value.ownerId !== store.ownerId) throw new HostError("forbidden", "Paired client authority required.");
    value.assertCurrent();
    return value;
  };
  const gate = (c: Context, access: Access): HostRequestAuthority => {
    const current = authority(c);
    if (access === "local") throw new HostError("forbidden", "Route is not available to paired clients.");
    if (access !== "session" && !current.scopes.includes(access)) throw new HostError("forbidden", "Missing approved client scope.");
    return current;
  };
  app.use("*", bodyLimit({ maxSize: 65_536, onError: (c) => c.json({ error: "invalid_input", message: "Request too large." }, 413) }));
  app.notFound((c) => c.json({ error: "not_found", message: "Route not found." }, 404));
  app.onError(errorResponse);
  const route = (method: Method, path: string, access: Access, handler: Handler): void => {
    app[method](path, (c) => {
      const current = gate(c, access);
      const io: RouteIo = {
        remote: current,
        admit: (operation) => { current.assertCurrent(); return operation(); },
        body: async (ctx) => { const value: unknown = await ctx.req.json(); current.assertCurrent(); return value; },
      };
      return handler(c, io);
    });
  };
  route("get", "/health", "session", (c, io) => {
    const a = io.remote!;
    return c.json({
      protocolVersion: PROTOCOL_VERSION, mode: "paired-client", remotePairing: "implemented",
      installationId: store.hostId, engineRouting: runtime ? "connected" : "not_connected",
      client: { deviceId: a.deviceId, role: a.role, scopes: [...a.scopes], pinGeneration: a.pinGeneration, bindingRevision: a.bindingRevision },
    });
  });
  route("get", "/v1/bots", "chat.read", (c) => c.json(idPage(store.listBots(), c.req.query("after"), c.req.query("limit"))));
  route("get", "/v1/actions", "approvals.read", (c) => c.json(idPage(store.listActions(), c.req.query("after"), c.req.query("limit"))));
  const peerPort = (): Readonly<HostPeerPort> => {
    if (!peers) throw new HostError("device_unavailable", "Device projection is not configured.");
    return peers;
  };
  route("get", "/v1/devices", "devices.read", (c) => c.json(idPage(peerPort().list(), c.req.query("after"), c.req.query("limit"))));
  const projected = new Set(["get /v1/devices/:deviceId", "patch /v1/devices/:deviceId", "post /v1/devices/:deviceId/revoke"]);
  for (const shared of sharedRoutes({ store, runtime, devices: undefined })) {
    // Device views come from the unified projection below; other local-only routes are registered as 403.
    if (!projected.has(`${shared.method} ${shared.path}`)) route(shared.method, shared.path, shared.access, shared.handler);
  }
  route("get", "/v1/devices/:deviceId", "devices.read", (c) => c.json(peerPort().get(c.req.param("deviceId")!)));
  route("patch", "/v1/devices/:deviceId", "devices.manage", async (c, io) => {
    const input = RenameDeviceSchema.parse(await io.body(c));
    return c.json(io.admit(() => peerPort().rename(c.req.param("deviceId")!, input)));
  });
  route("post", "/v1/devices/:deviceId/revoke", "devices.manage", (c, io) => {
    const id = c.req.param("deviceId")!;
    const view = io.admit(() => peerPort().revoke(id));
    if (id === io.remote!.deviceId) io.remote!.noteSelfRevoke(id);
    return c.json(view);
  });
  const grantPort = (): Readonly<HostGrantPort> => {
    if (!grants) throw new HostError("device_unavailable", "Device grants are not configured.");
    return grants;
  };
  route("get", "/v1/device-grants", "grants.read", (c) => {
    const botId = c.req.query("botId");
    if (botId === undefined || !ID_CURSOR.test(botId)) throw new HostError("invalid_input", "botId is required.");
    return c.json(grantPort().list(botId));
  });
  route("put", "/v1/device-grants", "grants.manage", async (c, io) => {
    const input = await io.body(c);
    return c.json(io.admit(() => grantPort().put(input)));
  });
  return app;
}
