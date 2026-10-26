import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { HostError } from "@dexter/hub";
import { OpCliSecretReader, onePasswordMcpCustody, type NativeMcpRuntimeOptions } from "@dexter/connectors";

/** Public operator configuration: no account tokens, environment values or secret references. */
export interface NativeMcpOnePasswordConfig {
  command: string;
  vault: string;
  account?: string;
}

/** Pure construction. No `op` subprocess or vault read until an explicit unlock/discovery. */
export function nativeMcpOnePassword(config: NativeMcpOnePasswordConfig): NonNullable<NativeMcpRuntimeOptions["credentials"]> {
  try {
    if (!isAbsolute(config.command) || /[\u0000-\u001f\u007f]/.test(config.command)) throw new Error();
    // Closed desktop environment: no inherited OP_SESSION, service token, shell or personal CLI variables.
    const reader = new OpCliSecretReader({ command: config.command, env: { HOME: homedir() },
      ...(config.account === undefined ? {} : { account: config.account }) });
    return Object.freeze({ custody: onePasswordMcpCustody({ reader, vault: config.vault }) });
  } catch { throw new HostError("invalid_input", "Invalid native MCP 1Password configuration."); }
}
