#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runOperatorHost } from "./operator-host-server.js";

/** Dedicated static executable `dexter-operator-host`: unlocks an EXISTING sealed custody file from an inherited FD>=3 and
 * serves the normal host until SIGINT/SIGTERM. Never loaded by engine/HTTP/MCP; no env, module path or remote command. */
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  process.exitCode = await runOperatorHost(process.argv.slice(2), { write: line => { process.stdout.write(`${line}\n`); }, signals: process });
}
