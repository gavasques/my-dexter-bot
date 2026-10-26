import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { connect, isIP, type Socket } from "node:net";
import type { Duplex } from "node:stream";

const MAX_CONNECTIONS = 64;
const HOP_BY_HOP = new Set(["proxy-connection", "proxy-authorization", "connection", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade"]);

export interface EgressProxyOptions {
  /** Same predicate as request interception: the bot's current origin grant. */
  allow(url: string): boolean;
  /** Lab/proof: refuse any upstream that is not a loopback address, even when granted. */
  loopbackOnly: boolean;
}

/**
 * Network-level egress filter for one bot's browser, listening on 127.0.0.1 only. The browser is started
 * with it as its only proxy (loopback included), so every connection — documents, subresources,
 * WebSockets, anything DevTools request interception does not see — must pass the bot's origin grant.
 * `CONNECT host:port` (TLS and tunneled WebSockets) is allowed when `https://host:port` or
 * `http://host:port` is granted. Refusals are counted, never logged with URLs. It is not a DevTools
 * endpoint and carries nothing but the browser's own traffic; another local process of the same owner
 * could use it to reach the same granted origins, which that owner can reach anyway.
 */
export class EgressProxy {
  #blocked = 0;
  readonly #sockets = new Set<Socket | Duplex>();

  private constructor(private readonly server: Server, readonly port: number) {}

  static async start(options: EgressProxyOptions): Promise<EgressProxy> {
    const server = createServer();
    server.maxConnections = MAX_CONNECTIONS;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const address = server.address();
    if (address === null || typeof address === "string") { server.close(); throw new Error("proxy_unavailable"); }
    const proxy = new EgressProxy(server, address.port);
    proxy.install(options);
    return proxy;
  }

  get blocked(): number { return this.#blocked; }

  close(): Promise<void> {
    return new Promise((resolve) => {
      for (const socket of this.#sockets) socket.destroy();
      this.server.close(() => { resolve(); });
      this.server.closeAllConnections();
    });
  }

  private install(options: EgressProxyOptions): void {
    const upstreamAllowed = (host: string): boolean => {
      if (!options.loopbackOnly) return true;
      const bare = host.startsWith("[") ? host.slice(1, -1) : host;
      return bare === "localhost" || (isIP(bare) === 4 && bare.startsWith("127.")) || bare === "::1";
    };
    const permitted = (url: URL): boolean => {
      try { return upstreamAllowed(url.hostname) && options.allow(url.href); } catch { return false; }
    };
    const track = (socket: Socket | Duplex): void => {
      this.#sockets.add(socket);
      socket.once("close", () => { this.#sockets.delete(socket); });
      socket.on("error", () => { socket.destroy(); });
    };
    this.server.on("connection", track);

    // Plain HTTP through the proxy: absolute-form request target.
    this.server.on("request", (req: IncomingMessage, res) => {
      const url = absolute(req.url);
      if (!url || url.protocol !== "http:" || !permitted(url)) {
        this.#blocked += 1;
        res.writeHead(403, { "content-type": "text/plain", connection: "close" }).end();
        return;
      }
      const upstream = httpRequest({
        host: url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname, port: url.port || 80, method: req.method,
        path: `${url.pathname}${url.search}`, headers: forwardHeaders(req), agent: false,
      }, (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      });
      upstream.on("error", () => { if (!res.headersSent) res.writeHead(502).end(); else res.destroy(); });
      req.pipe(upstream);
    });

    // TLS and tunneled WebSockets.
    this.server.on("connect", (req: IncomingMessage, client: Duplex, head: Buffer) => {
      track(client);
      const target = authority(req.url);
      const granted = target !== null && (permitted(new URL(`https://${target.host}:${target.port}/`)) || permitted(new URL(`http://${target.host}:${target.port}/`)));
      if (!target || !granted) {
        this.#blocked += 1;
        client.end("HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n");
        return;
      }
      const upstream = connect({ host: target.host, port: target.port }, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      track(upstream);
      upstream.on("close", () => { client.destroy(); });
      client.on("close", () => { upstream.destroy(); });
    });

    // Plain ws:// sent in absolute form with an Upgrade header.
    this.server.on("upgrade", (req: IncomingMessage, client: Duplex, head: Buffer) => {
      track(client);
      const url = absolute(req.url);
      const http = url && (url.protocol === "ws:" || url.protocol === "http:") ? new URL(`http://${url.host}${url.pathname}${url.search}`) : null;
      if (!http || !permitted(http)) {
        this.#blocked += 1;
        client.end("HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n");
        return;
      }
      const upstream = connect({ host: http.hostname, port: Number(http.port || 80) }, () => {
        const lines = [`${req.method ?? "GET"} ${http.pathname}${http.search} HTTP/1.1`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          const name = req.rawHeaders[i]!;
          if (!name.toLowerCase().startsWith("proxy-")) lines.push(`${name}: ${req.rawHeaders[i + 1]!}`);
        }
        upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      track(upstream);
      upstream.on("close", () => { client.destroy(); });
      client.on("close", () => { upstream.destroy(); });
    });
  }
}

function absolute(target: string | undefined): URL | null {
  if (!target) return null;
  try {
    const url = new URL(target);
    return url.username || url.password ? null : url;
  } catch { return null; }
}
function authority(target: string | undefined): { host: string; port: number } | null {
  if (!target) return null;
  const match = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+):([0-9]{1,5})$/.exec(target);
  if (!match) return null;
  const port = Number(match[2]);
  if (port < 1 || port > 65535) return null;
  const host = match[1]!.startsWith("[") ? match[1]!.slice(1, -1) : match[1]!;
  return { host, port };
}
function forwardHeaders(req: IncomingMessage): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(req.headers)) if (value !== undefined && !HOP_BY_HOP.has(name)) out[name] = value;
  return out;
}
