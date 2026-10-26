// Explicit trusted test preload; no production flags or fallbacks are introduced.
import { memoryCustody, receiveMemoryIdentity } from "./device-memory-custody.js";
import { readFileSync } from "node:fs";
const identity = await receiveMemoryIdentity();
const i = process.argv.indexOf("--config"), app = process.argv.indexOf("--app-client-identity-dir");
const dir = i >= 0 ? (JSON.parse(readFileSync(process.argv[i + 1]!, "utf8")) as {identityDir?: string}).identityDir : app >= 0 ? process.argv[app + 1] : undefined;
if (!dir) throw Error("missing lab memory directory");
memoryCustody(dir, identity);
