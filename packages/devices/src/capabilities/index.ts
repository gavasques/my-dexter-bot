import { join } from "node:path";
import { privateDirectory } from "../files.js";
import type { OperationHandler } from "../handlers.js";
import { BrowserCapability } from "./browser/capability.js";
import type { BrowserDriver } from "./browser/driver.js";
import { CuaCapability } from "./cua/capability.js";
import type { CuaTransport } from "./cua/transport.js";
import type { LocalCapabilityPolicy } from "./policy.js";
import { SelectedFilesCapability } from "./files/capability.js";
import type { SelectedFilesPolicy } from "./files/policy.js";

export interface LocalCapabilitiesOptions {
  /** The daemon's private data directory; capability state lives under `<dataDir>/capabilities`. */
  dataDir: string;
  /** Operator grants per bot/operation. Without a grant every operation refuses `not_granted`. */
  policy: LocalCapabilityPolicy;
  /** Trusted, operator-configured browser driver. Absent: no browser handler is installed. */
  browser?: { driver: BrowserDriver; closeTimeoutMs?: number };
  /** Trusted, operator-configured CUA helper. Absent: no CUA handler is installed. */
  cua?: { transport: () => CuaTransport; requestTimeoutMs?: number; consentPromptSeconds?: number };
  files?: { policy: SelectedFilesPolicy };
  clock?: () => number;
}

export interface LocalCapabilities {
  readonly handlers: ReadonlyMap<string, OperationHandler>;
  readonly browser: BrowserCapability | null;
  readonly cua: CuaCapability | null;
  /** Ends sessions, closes browsers and the helper. Call after the daemon drained its in-flight run. */
  close(): Promise<void>;
}

/**
 * Composes the G4 local capabilities for `MacDeviceDaemon`'s `handlers`. Nothing is active by default:
 * a family is installed only when its driver is configured, and each operation still needs the bot's
 * local grant (and, on the host, the bot's grant, approval and the device's paired capability).
 */
export function createLocalCapabilities(options: LocalCapabilitiesOptions): LocalCapabilities {
  privateDirectory(options.dataDir, false);
  const root = join(options.dataDir, "capabilities");
  privateDirectory(root);
  const handlers = new Map<string, OperationHandler>();
  const clock = options.clock ? { clock: options.clock } : {};
  const browser = options.browser ? new BrowserCapability({
    root: join(root, "browser"), policy: options.policy, driver: options.browser.driver, ...clock,
    ...(options.browser.closeTimeoutMs !== undefined ? { closeTimeoutMs: options.browser.closeTimeoutMs } : {}),
  }) : null;
  const cua = options.cua ? new CuaCapability({
    policy: options.policy, transport: options.cua.transport, ...clock,
    ...(options.cua.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.cua.requestTimeoutMs } : {}),
    ...(options.cua.consentPromptSeconds !== undefined ? { consentPromptSeconds: options.cua.consentPromptSeconds } : {}),
  }) : null;
  const files = options.files ? new SelectedFilesCapability({ policy: options.files.policy, ...clock }) : null;
  for (const [tool, handler] of browser?.handlers() ?? []) handlers.set(tool, handler);
  for (const [tool, handler] of cua?.handlers() ?? []) handlers.set(tool, handler);
  for (const [tool, handler] of files?.handlers() ?? []) handlers.set(tool, handler);
  return {
    handlers, browser, cua,
    // Both are always closed; the first failure (e.g. undrained browser processes) is reported after.
    close: async () => {
      const results = await Promise.allSettled([browser?.close(), cua?.close(), files?.close()]);
      for (const result of results) if (result.status === "rejected") throw result.reason;
    },
  };
}

export { LocalCapabilityPolicy, PolicyPersistenceError, LOCAL_CAPABILITY_OPERATIONS, POLICY_VERSION, normalizeOrigin, parseLocalCapabilityConfig,
  type Authorization, type LocalBotGrant, type LocalCapabilityConfig } from "./policy.js";
export { OutcomeUncertain, botKeyOf, boundText, type UntrustedText } from "./context.js";
export { SelectedFilesCapability, SELECTED_FILE_READ_BYTES, SELECTED_FILE_APPEND_BYTES, type SelectedFilesCapabilityOptions } from "./files/capability.js";
export { SelectedFilesPolicy, parseSelectedFilesPolicy, selectedFilePath, type SelectedFilesPolicyConfig, type SelectedFileGrant } from "./files/policy.js";
export { BrowserCapability, MAX_TEXT_BYTES, type BrowserCapabilityOptions } from "./browser/capability.js";
export { BrowserProfileStore, type ProfileLease } from "./browser/profiles.js";
export { ChromePipeDriver, READ_EXPRESSION, chromeArguments, type ChromeDriverOptions, type ChromeNetworkIsolation } from "./browser/chrome.js";
export { CdpPipe, MAX_CDP_MESSAGE_BYTES } from "./browser/cdp-pipe.js";
export { EgressProxy, type EgressProxyOptions } from "./browser/egress-proxy.js";
export { BrowserDriverError, type BrowserDriver, type BrowserLaunch, type BrowserSession, type NavigateResult, type PageSnapshot } from "./browser/driver.js";
export { CuaCapability, CUA_REFUSALS, SESSION_END_REASONS, CUA_CONSENT_PROMPT_SECONDS, MAX_CUA_CONSENT_PROMPT_SECONDS, type CuaCapabilityOptions } from "./cua/capability.js";
export { CuaHelperProcess, CuaTransportError, CUA_PROTOCOL_VERSION, type CuaHelperOptions, type CuaTransport } from "./cua/transport.js";
