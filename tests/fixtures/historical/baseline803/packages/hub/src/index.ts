export { HostError, type ErrorCode } from "./errors.js";
export {
  HostStore, SCHEMA_VERSION, DATABASE_FILE, ACTIVATION_MARKER_FILE, ACTIVATION_RESERVATION_SUFFIX, activationReservationPath, canonicalJson, hashRequest,
  type TrustedApprovalEligibility, type HostStoreOptions, type HostSummary, type HostLease, type ActionState, type ActionReason, type UnknownReason,
  type DevicePresence, CLIENT_DEVICE_SCOPES, type ClientDeviceScope, type ClientDeviceRole,
  type ClientDeviceClaimKey, type ClientDeviceClaimInput, type ClientDeviceEnrollment,
  type HostAuthorityState, type HostAuthorityProvenance, type HostAuthorityStatus, type HostAuthorityCheckpoint,
  type HostAuthorityActivation, type HostAuthorityActivationReport, type ExistingHostIdentity,
} from "./store.js";
export { dispatchAction, type ToolExecutor, type ToolExecutionContext } from "./dispatcher.js";
export {
  ConversationRuntime, ShutdownIncompleteError, type RuntimeOptions, type ShutdownOptions, type RuntimeNotice, type RuntimeStatus,
  type RuntimePending,
} from "./runtime.js";
export {
  TURN_STATES, TURN_EVENT_KINDS, TURN_CODES, TERMINAL_TURN_STATES, MAX_TURN_OUTPUT_CHARS, MAX_TOOL_REQUESTS_PER_TURN,
  normalizeTurnCode,
  type Turn, type TurnState, type TurnEvent, type TurnEventKind, type TurnCode, type TurnCounts, type ThreadSession,
  type StartTurnInput, type StartedTurn, type RuntimeDriver, type RuntimeSession, type RuntimeEngineEvent,
  type RuntimeSessionReuse, type RuntimeOpenContext,
} from "./turns.js";

export { BotDelegationRuntime } from './bot-delegation.js';
export type { HostSkillsPort } from './skills-port.js';
export type { HostBotDocumentsPort, BotDocuments, SetBotDocuments } from './bot-documents-port.js';
export type { HostTeamsPort } from './teams-port.js';

export { validatePng } from "./image-codec.js";

export { assertBotExecutionAccessData } from "./store.js";

export { assertApprovalPreferencesData } from "./approval-preferences-data.js";
