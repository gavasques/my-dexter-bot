const cliURL = new URL("../../packages/relay-service/src/cli.js", import.meta.url).href;
const filesURL = new URL("./relay-service-cli-memory-files.js", import.meta.url).href;

export function resolve(specifier: string, context: { parentURL?: string }, nextResolve: (specifier: string, context: unknown) => unknown): unknown {
  if (specifier === "./files.js" && context.parentURL === cliURL) return { url: filesURL, shortCircuit: true };
  return nextResolve(specifier, context);
}
