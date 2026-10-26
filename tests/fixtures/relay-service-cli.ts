// Same two lines as packages/relay-service/src/bin.ts, compiled with the tests so the CLI runs as its own process.
import { runCli } from "../../packages/relay-service/src/cli.js";

void runCli(process.argv.slice(2));
