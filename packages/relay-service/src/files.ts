import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";

/**
 * Reads a trusted operator file: absolute canonical path, no symlink (O_NOFOLLOW), regular file owned by this
 * UID, no group/other bits, bounded size. Throws a fixed Error("untrusted_file") without echoing the path.
 */
export function readPrivateFile(path: string, maximumBytes: number): Buffer {
  const fail = (): never => { throw new Error("untrusted_file"); };
  if (typeof path !== "string" || path.length > 4096 || !isAbsolute(path) || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1) fail();
  let canonical: string;
  try { canonical = realpathSync(path); } catch { return fail(); }
  if (canonical !== path) fail();
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return fail(); }
  try {
    const s = fstatSync(fd), uid = process.getuid?.();
    if (uid === undefined || !s.isFile() || s.uid !== uid || (s.mode & 0o077) !== 0 || s.size < 1 || s.size > maximumBytes) fail();
    const out = Buffer.alloc(s.size);
    let read = 0;
    while (read < s.size) { const n = readSync(fd, out, read, s.size - read, read); if (n === 0) break; read += n; }
    if (read !== s.size) fail();
    return out;
  } finally { closeSync(fd); }
}
