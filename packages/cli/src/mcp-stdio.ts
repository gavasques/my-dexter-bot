import { lstatSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, isAbsolute, resolve } from "node:path";
import { Transform, type TransformCallback, type Readable, type Writable } from "node:stream";
import { fileURLToPath } from "node:url";

/** Counts bytes without parsing/retaining payload. Authority stays exclusively in the host gateway. */
class LineLimit extends Transform {
  private bytes = 0;
  constructor(private readonly limit: number) { super(); }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    for (let start = 0; start < chunk.length;) {
      const end = chunk.indexOf(10, start);
      this.bytes += (end < 0 ? chunk.length : end) - start;
      if (this.bytes > this.limit) { done(new Error("MCP transport failed")); return; }
      if (end < 0) break;
      this.bytes = 0; start = end + 1;
    }
    done(null, chunk);
  }
}
/** No token, gateway import, config file or credential broker. Socket path identifies one owner-local endpoint. */
export async function runMcpStdio(socketPath: string, input: Readable = process.stdin, output: Writable = process.stdout): Promise<void> {
  if (process.platform === "win32" || !process.getuid || !isAbsolute(socketPath) || resolve(socketPath) !== socketPath || Buffer.byteLength(socketPath) > 100) throw new Error("MCP transport failed");
  const parent = lstatSync(dirname(socketPath)); const endpoint = lstatSync(socketPath);
  if (!parent.isDirectory() || parent.isSymbolicLink() || !endpoint.isSocket() || endpoint.isSymbolicLink()
    || parent.uid !== process.getuid() || endpoint.uid !== process.getuid() || (parent.mode & 0o077) !== 0 || (endpoint.mode & 0o077) !== 0) throw new Error("MCP transport failed");
  const socket = createConnection(socketPath);
  const incoming = new LineLimit(256 * 1024); const outgoing = new LineLimit(8 * 1024 * 1024);
  await new Promise<void>((resolveDone, reject) => {
    let finished = false;
    const timer = setTimeout(() => fail(), 5_000);
    const finish = (failed: boolean): void => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      process.off("SIGTERM", terminated); process.off("SIGINT", terminated);
      input.unpipe(incoming); input.pause(); incoming.unpipe(socket); socket.unpipe(outgoing); outgoing.unpipe(output);
      socket.destroy(); incoming.destroy(); outgoing.destroy();
      if (failed) reject(new Error("MCP transport failed"));
      else {
        const flush = setTimeout(() => { output.destroy(); reject(new Error("MCP transport failed")); }, 1_000);
        try { output.write("", error => { clearTimeout(flush); if (error) reject(new Error("MCP transport failed")); else resolveDone(); }); }
        catch { clearTimeout(flush); reject(new Error("MCP transport failed")); }
      }
    };
    const fail = (): void => finish(true);
    const terminated = (): void => finish(false);
    process.once("SIGTERM", terminated); process.once("SIGINT", terminated);
    socket.on("error", fail); incoming.on("error", fail); outgoing.on("error", fail); input.on("error", fail); output.on("error", fail);
    socket.once("connect", () => { clearTimeout(timer); input.pipe(incoming).pipe(socket); socket.pipe(outgoing).pipe(output, { end: false }); });
    // Pipe backpressure bounds socket/stdout queues. EOF closes write side; host closes its scoped endpoint.
    socket.once("close", () => finish(false));
    outgoing.once("end", () => finish(false));
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) { process.stderr.write("MCP local transport unavailable.\n"); process.exitCode = 1; }
  else void runMcpStdio(process.argv[2]!).catch(() => { process.stderr.write("MCP local transport unavailable.\n"); process.exitCode = 1; });
}
