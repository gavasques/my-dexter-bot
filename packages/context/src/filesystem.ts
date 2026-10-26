import { lstatSync, type Stats } from "node:fs";
import { ContextError } from "./types.js";

/** lstat observes dangling links; only an absent entry is safe to create. */
export function entry(path: string): Stats | undefined {
  try { return lstatSync(path); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw new ContextError("tampered");
  }
}
export function rejectSymlink(path: string): Stats | undefined {
  const stat = entry(path);
  if (stat?.isSymbolicLink()) throw new ContextError("tampered");
  return stat;
}
