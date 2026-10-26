import { nativeMemorySpawn } from "./native-memory-spawn.js";
import { receiveMemoryIdentity } from "./device-memory-custody.js";
import { readFileSync } from "node:fs";
const identity = await receiveMemoryIdentity();
const i = process.argv.indexOf("--config"), config = JSON.parse(readFileSync(process.argv[i + 1]!, "utf8")) as {client:{executable:string}};
nativeMemorySpawn(config.client.executable, () => identity);
