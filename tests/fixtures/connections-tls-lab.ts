import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkServerIdentity } from "node:tls";
import type { TestContext } from "node:test";
import { getRequestListener } from "@hono/node-server";
import type { FetchLike } from "@dexter/connectors";
import { createLabTlsIdentity } from "@dexter/devices";
import { ConnectionsPlatformService, createConnectionsServiceApp, type ServicePrincipal } from "../../packages/connections-service/src/index.js";
import { CATALOG, COMPOSIO_KEY, COMPOSIO_ORIGIN, FakeComposio, LINK_ORIGIN, remapFetch, SERVICE_ORIGIN } from "./connections-lab.js";

/**
 * The trusted connections service over REAL synthetic TLS: a laboratory CA, a leaf whose only SAN is the origin's DNS
 * name (`connections.dexter.test`), HTTPS on a random 127.0.0.1 port (never 4317/4318). The host's fetch keeps the exact
 * https origin, connects to the socket, presents that SNI and verifies the chain against the lab CA and the hostname.
 * Every request is recorded (method, path, whether an Authorization header arrived and its exact value).
 */
export interface TlsServiceLab {
  url: string; ca: string; issue(principal: ServicePrincipal): string;
  seen: Array<{ method: string; path: string; authorization: string | null; installation: string | null }>;
  fetch: FetchLike;
}
export async function tlsServiceLab(t: TestContext): Promise<TlsServiceLab> {
  const composio = new FakeComposio(); await composio.start();
  const dir = mkdtempSync(join(tmpdir(), "dx-connections-tls-service-"));
  const capabilities = new Map<string, ServicePrincipal>();
  const service = new ConnectionsPlatformService({ dataDir: dir, publicOrigin: SERVICE_ORIGIN, catalog: CATALOG,
    composio: { fetch: remapFetch({ [COMPOSIO_ORIGIN]: composio.url }), apiKey: () => COMPOSIO_KEY, authorizationOrigins: [LINK_ORIGIN], limits: { timeoutMs: 5_000 } },
    installations: { resolve: capability => capabilities.get(capability) ?? null } });
  const ca = createLabTlsIdentity({ profile: "ca", name: "dexter-synthetic-connections-ca" });
  const leaf = createLabTlsIdentity({ profile: "host", name: "dexter-synthetic-connections", san: [`DNS:${new URL(SERVICE_ORIGIN).hostname}`], issuer: ca });
  const seen: TlsServiceLab["seen"] = [];
  const listener = getRequestListener(createConnectionsServiceApp(service).fetch);
  const server: Server = createServer({ key: leaf.identity.keyPem, cert: leaf.identity.certPem, minVersion: "TLSv1.2" }, (req, res) => {
    const auth = req.headers.authorization, installation = req.headers["x-dexter-installation"];
    seen.push({ method: req.method ?? "", path: req.url ?? "", authorization: typeof auth === "string" ? auth : null,
      installation: typeof installation === "string" ? installation : null });
    void listener(req, res);
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", () => done()));
  const port = (server.address() as AddressInfo).port;
  if (port === 4317 || port === 4318) throw new Error("product port");
  const caPem = ca.identity.certPem;
  const fetch: FetchLike = (url, init) => new Promise<Response>((resolve, reject) => {
    const target = new URL(url);
    if (target.origin !== SERVICE_ORIGIN) { reject(new Error("unmapped synthetic origin")); return; }
    const headers = { ...(init.headers as Record<string, string>), host: target.host };
    const req = request({ host: "127.0.0.1", port, method: init.method ?? "GET", path: target.pathname + target.search, headers, ca: [caPem],
      servername: target.hostname, checkServerIdentity: (_host, cert) => checkServerIdentity(target.hostname, cert), agent: false,
      ...(init.signal ? { signal: init.signal } : {}) }, res => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const out = new Headers();
        for (const [name, value] of Object.entries(res.headers)) if (typeof value === "string") out.set(name, value);
        resolve(new Response(res.statusCode === 204 ? null : Buffer.concat(chunks), { status: res.statusCode ?? 502, headers: out }));
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(typeof init.body === "string" ? init.body : undefined);
  });
  t.after(async () => {
    await new Promise<void>(done => { server.closeAllConnections?.(); server.close(() => done()); });
    service.close(); await composio.close(); rmSync(dir, { recursive: true, force: true });
  });
  return { url: `https://127.0.0.1:${port}`, ca: caPem, seen, fetch,
    issue: principal => { const capability = randomBytes(32).toString("base64url"); capabilities.set(capability, principal); return capability; } };
}
