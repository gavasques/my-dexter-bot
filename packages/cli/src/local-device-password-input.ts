import { fstatSync, readSync } from "node:fs";
import { readOperatorPrivateFd, SealedCustodyError } from "./operator-sealed-custody.js";

/**
 * Explicit desktop serve password channel only. FD0 is accepted ONLY as an owner-owned inherited POSIX
 * FIFO (Swift Process/Pipe), never terminal, socket, file or console fallback. Parent must write once,
 * close to EOF and enforce its deadline. Other explicit FD>=3 preserves the existing operator reader.
 * Caller owns/zeros the returned buffer. No argv/env/file value, output or raw IO error.
 */
export function readLocalDevicePasswordFd(fd: number): Buffer {
  if (!Number.isSafeInteger(fd) || (fd !== 0 && fd < 3)) throw new SealedCustodyError("invalid_input");
  if (fd >= 3) return readOperatorPrivateFd(fd);
  const temporary = Buffer.alloc(1025);
  try {
    const st = fstatSync(0);
    if (!process.getuid || st.uid !== process.getuid() || !st.isFIFO()) throw new SealedCustodyError("private_path_required");
    let offset = 0;
    while (offset < temporary.length) {
      const count = readSync(0, temporary, offset, temporary.length - offset, null);
      if (!count) break;
      offset += count;
    }
    if (offset > 1024) throw new SealedCustodyError("invalid_input");
    return Buffer.from(temporary.subarray(0, offset));
  } catch (error) {
    if (error instanceof SealedCustodyError) throw error;
    throw new SealedCustodyError("unavailable");
  } finally { temporary.fill(0); }
}
