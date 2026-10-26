export { DeviceError, type DeviceErrorCode } from "./errors.js";
export {
  DEVICE_PROTOCOL, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, MAX_RESULT_BYTES, certificateFingerprint, fingerprintDer,
  type DeviceJob, type DeviceReceipt, type ReceiptStatus,
} from "./wire.js";
export { TlsIdentity, loadIdentity, privateDirectory } from "./files.js";
export {
  DEVICE_OPERATIONS, UNSUPPORTED_DEVICE_CAPABILITIES, FILE_READ, FILE_APPEND, PROCESS_PROBE, checkCapabilities, checkOperationArgs,
  BROWSER_NAVIGATE, BROWSER_READ, BROWSER_CLOSE, CUA_OBSERVE, CUA_CONTROL, CUA_STATUS, CUA_ACTIONS, MAX_BROWSER_READ_CHARS, MAX_CUA_NODES, MAX_URL_LENGTH,
  operationFor, deviceOperationSchemaHash, DEVICE_OPERATION_VERSION,
  type DeviceOperation, type DeviceOperationInputSchema, type DeviceArgumentSchema,
} from "./operations.js";
export {
  DevicePairingRegistry, DEVICES_DATABASE_FILE,
  type PairingOffer, type PendingClaim, type ClaimStatus, type DeviceCertificate, type LateReceipt, type DeviceRegistryOptions,
} from "./registry.js";
export { DeviceHostServer, type DeviceHostOptions, type PairingBundle } from "./host-server.js";
export { DaemonJournal, JOURNAL_DATABASE_FILE, type JournalBinding } from "./journal.js";
export {
  createFixtureHandlers, HandlerRefusal, PROBE_SCRIPT, type OperationHandler, type HandlerContext, type TrustedJobContext, type FixtureHandlerOptions,
} from "./handlers.js";
export {
  DeviceClient, MacDeviceDaemon, pairDevice, readBinding, BINDING_FILE,
  type HostTrust, type DeviceBinding, type PairOptions, type DaemonOptions,
} from "./daemon.js";
export { generateSyntheticIdentity } from "./lab.js";
export * from "./capabilities/index.js";
export {
  ClientPairingRegistry, APP_CLIENTS_DATABASE_FILE, APP_CLIENT_NAMESPACE, APP_CLIENT_ROLES, clientScopes,
  type ClientOfferInput, type ClientPairingOffer, type ClientPendingClaim, type ClientClaimState, type ClientClaimStatus, type ClientClaimRecord,
  type ClientBinding, type ClientRegistryOptions,
} from "./client-registry.js";

export { createLabTlsIdentity, LabTlsMaterial, type LabCertificateOptions } from "./lab-pki.js";
