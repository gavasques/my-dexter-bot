#!/usr/bin/env node
import { runCli } from "./cli.js";
import { UNAVAILABLE_CUSTODY } from "./custody.js";

// The shipped operator binary: no custody provider is configured, so commands that need the snapshot key or the
// owner signer fail closed. Production custody (Keychain or remote) is an external gate.
process.exitCode = await runCli(process.argv.slice(2), { write: (line) => process.stdout.write(`${line}\n`), custody: UNAVAILABLE_CUSTODY });
