import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { CONNECTIONS_PLATFORM_INSTALLATION_HEADER } from "@dexter/contracts";
import { ServiceError, type ConnectionsPlatformService, type ServicePrincipal } from "./service.js";

const CALLBACK_PAGE = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Dexter</title></head><body style="font:16px -apple-system,system-ui,sans-serif;margin:3rem;max-width:32rem">
<h1 style="font-size:1.4rem">Autorização recebida</h1><p>Volte ao Dexter para conferir a conta conectada. Esta página não confirma a conexão.</p></body></html>`;
const INVALID_PAGE = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Dexter</title></head>
<body style="font:16px -apple-system,system-ui,sans-serif;margin:3rem"><h1 style="font-size:1.4rem">Link inválido ou expirado</h1><p>Volte ao Dexter e comece de novo.</p></body></html>`;

function errorResponse(error: Error, c: Context): Response {
  const e = error instanceof ServiceError ? error : error.name === "ZodError" || error instanceof SyntaxError ? new ServiceError("invalid_input") : new ServiceError("outcome_unknown");
  c.header("Cache-Control", "no-store");
  // Fixed body only: never provider text, request content or capability material.
  return c.json({ error: e.code, outcome: e.outcome }, e.status as 400);
}

/**
 * HTTP surface of the trusted connections service. Every `/v1/*` route except the browser callback requires the
 * installation capability. No route returns a project key, auth config id, token, connection state value or link twice.
 */
export function createConnectionsServiceApp(service: ConnectionsPlatformService): Hono<{ Variables: { principal: ServicePrincipal } }> {
  const app = new Hono<{ Variables: { principal: ServicePrincipal } }>();
  app.onError(errorResponse);
  app.notFound(c => c.json({ error: "not_found", outcome: "not_applied" }, 404));
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store"); c.header("X-Content-Type-Options", "nosniff"); c.header("Referrer-Policy", "no-referrer");
    if (["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method) && c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json")
      return c.json({ error: "invalid_input", outcome: "not_applied" }, 415);
    await next();
  });
  const tooLarge = (c: Context) => c.json({ error: "invalid_input", outcome: "not_applied" }, 413);
  const executionBody = bodyLimit({ maxSize: 262_144, onError: tooLarge }), normalBody = bodyLimit({ maxSize: 16_384, onError: tooLarge });
  app.use("*", (c, next) => (c.req.path === "/v1/executions" ? executionBody : normalBody)(c, next));

  app.get("/health", c => c.json({ status: "ok" }));
  app.get("/v1/callback/:attemptId", c => {
    const q = c.req.query();
    const recorded = service.callback(c.req.param("attemptId"), { ...(q.state === undefined ? {} : { state: q.state }), ...(q.status === undefined ? {} : { status: q.status }),
      ...(q.connected_account_id === undefined ? {} : { connected_account_id: q.connected_account_id }) });
    c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
    return c.html(recorded ? CALLBACK_PAGE : INVALID_PAGE, recorded ? 200 : 400);
  });
  app.use("/v1/*", async (c, next) => {
    if (c.req.path.startsWith("/v1/callback/")) return next();
    c.set("principal", service.authenticate(c.req.header("authorization"), c.req.header(CONNECTIONS_PLATFORM_INSTALLATION_HEADER)));
    if (Object.keys(c.req.query()).length) throw new ServiceError("invalid_input");
    await next();
  });
  app.get("/v1/catalog", c => c.json(service.catalog()));
  app.post("/v1/authorizations", async c => {
    const result = await service.startAuthorization(c.get("principal"), await c.req.json());
    return c.json({ attempt: result.attempt, authorizationURL: result.authorizationURL }, result.created ? 201 : 200);
  });
  app.get("/v1/authorizations/:requestId", async c => c.json(await service.authorization(c.get("principal"), c.req.param("requestId"))));
  app.get("/v1/accounts/:accountRef", async c => c.json(await service.account(c.get("principal"), c.req.param("accountRef"))));
  app.post("/v1/accounts/:accountRef/disconnect", async c => c.json(await service.disconnect(c.get("principal"), c.req.param("accountRef"), await c.req.json())));
  app.post("/v1/executions", async c => c.json(await service.execute(c.get("principal"), await c.req.json())));
  return app;
}
