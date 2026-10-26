// Private bounded observation. Only allowlisted categories leave this helper, never raw stderr.
import type { ChildProcess } from "node:child_process";
export interface ChildObservation { exitCode: number | null; signal: NodeJS.Signals | null; stderr: {category: string; bytes: number; truncated: boolean} }
export function observeChild(child: ChildProcess): {closed: Promise<ChildObservation>} {
  const chunks: Buffer[] = []; let bytes = 0, stored = 0, spawnError = false;
  child.once("error", () => { spawnError = true; });
  child.stderr?.on("data", (value: Buffer) => {
    bytes += value.length; if (stored < 16384) { const b=Buffer.from(value.subarray(0,16384-stored)); chunks.push(b); stored += b.length; }
  });
  const closed = new Promise<ChildObservation>(resolve => child.once("close", (exitCode, signal) => {
    const bounded=Buffer.concat(chunks), text=bounded.toString("utf8");
    const category = spawnError ? "spawn_error" : bytes > 16384 ? "overflow" : /disk I\/O error|ERR_SQLITE_ERROR/.test(text) ? "sqlite_io"
      : /memory IPC/.test(text) ? "memory_ipc" : /ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/.test(text) ? "module_resolution"
      : /ERR_TLS|CERT_HAS_EXPIRED|invalid lab certificate profile/.test(text) ? "tls_identity" : bytes ? "unknown" : "none";
    bounded.fill(0); for(const b of chunks)b.fill(0);
    resolve({exitCode,signal,stderr:{category,bytes,truncated:bytes>16384}});
  }));
  return {closed};
}
export function childExitError(observation: ChildObservation): Error { return Error(`child exited: ${JSON.stringify(observation)}`); }
