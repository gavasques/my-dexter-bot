import DexterHostClient
import Foundation

/// Host identity observed in the current `/health` response. Readiness facts are only valid for this identity.
public struct OnboardingHostIdentity: Equatable, Sendable {
    public enum Mode: Equatable, Sendable { case localDevelopment, pairedClient }
    public let hostID: String
    public let mode: Mode
    /// This app's own device on a paired host. It is a client, never the executor Mac.
    public let clientDeviceID: String?

    public init(hostID: String, mode: Mode, clientDeviceID: String?) {
        self.hostID = hostID
        self.mode = mode
        self.clientDeviceID = clientDeviceID
    }
}

public enum OnboardingHostFact: Equatable, Sendable {
    case fixture
    case unconfigured
    /// A remote address without pairing, or a saved loopback on a physical iPhone.
    case pairingUnavailable
    case checking
    case offline
    /// This app could not validate the host's protocol, pairing or trusted connection (`contractMismatch`).
    /// The check can fail locally (expired client certificate, pin refusal) before any host reply, so this never claims the host answered.
    case validationFailed
    case online(OnboardingHostIdentity)
}

/// What `/health` says about engine routing. Routing is not sign-in.
public enum OnboardingEngineRouting: Equatable, Sendable {
    case unknown
    case notConnected
    /// `nil` when the response does not list driver keys (paired health).
    case connected(routedEngines: Set<EngineID>?)
}

public enum OnboardingEngineAuthentication: Equatable, Sendable {
    case unknown
    case required
    /// Only an explicit read-only metadata source may report this; the current app never infers it.
    case authenticated
}

public struct OnboardingEngineObservation: Equatable, Sendable {
    public var authentication: OnboardingEngineAuthentication
    public var unavailable: Bool
    /// `updatedAt` of the turn that produced this observation; older turns cannot overwrite it.
    public var observedAt: Int64

    public init(authentication: OnboardingEngineAuthentication = .unknown, unavailable: Bool = false, observedAt: Int64 = .min) {
        self.authentication = authentication
        self.unavailable = unavailable
        self.observedAt = observedAt
    }

    /// Folds a terminal turn into the observation. Only structured codes count; success clears to unknown, not authenticated.
    public func observing(_ turn: Turn) -> OnboardingEngineObservation {
        guard turn.state.isTerminal, turn.updatedAt > observedAt else { return self }
        switch (turn.state, turn.code) {
        case (.failed, "authentication_required"):
            return OnboardingEngineObservation(authentication: .required, unavailable: false, observedAt: turn.updatedAt)
        case (.failed, "not_installed"), (.failed, "engine_unavailable"), (.failed, "no_driver"):
            return OnboardingEngineObservation(authentication: .unknown, unavailable: true, observedAt: turn.updatedAt)
        case (.completed, _):
            return OnboardingEngineObservation(authentication: .unknown, unavailable: false, observedAt: turn.updatedAt)
        default:
            return self
        }
    }
}

public enum OnboardingDevicesFact: Equatable, Sendable {
    case notLoaded
    case failed
    case loaded([DeviceView])
}

/// Catalog metadata does not confirm authentication or native voice. A fresh successful lookup can supersede
/// an older "engine unavailable" turn; a newer turn remains an observation of the actual request's failure.
public struct OnboardingEngineCatalog: Equatable, Sendable {
    public let entries: [EngineCatalogEntry]
    public let observedAt: Int64
    public init(entries: [EngineCatalogEntry], observedAt: Int64) {
        self.entries = entries; self.observedAt = observedAt
    }
}

/// macOS permission state for one executor capability. Nothing in the app probes TCC; missing means unknown.
public enum OnboardingPermission: Equatable, Sendable {
    case unknown
    case pending
    case denied
    case granted
}

/// A capability requested from a specific device by a host action (`request.destination`/`request.tool`).
public struct OnboardingCapabilityRequest: Equatable, Hashable, Sendable {
    public let deviceID: String
    public let capability: String

    public init(deviceID: String, capability: String) {
        self.deviceID = deviceID
        self.capability = capability
    }
}

public struct OnboardingReadinessInput: Equatable, Sendable {
    public var host: OnboardingHostFact
    public var routing: OnboardingEngineRouting
    public var selectedEngine: EngineID?
    /// True while `selectedEngine` is only the bot default standing in for a conversation selection not read yet.
    /// A provisional engine never blocks the conversation; its non-blocking facts are still shown.
    public var selectedEngineIsProvisional: Bool
    public var engines: [EngineID: OnboardingEngineObservation]
    public var catalog: OnboardingEngineCatalog?
    public var devices: OnboardingDevicesFact
    public var capabilityRequests: [OnboardingCapabilityRequest]
    public var permissions: [OnboardingCapabilityRequest: OnboardingPermission]

    public init(
        host: OnboardingHostFact,
        routing: OnboardingEngineRouting = .unknown,
        selectedEngine: EngineID? = nil,
        selectedEngineIsProvisional: Bool = false,
        engines: [EngineID: OnboardingEngineObservation] = [:],
        catalog: OnboardingEngineCatalog? = nil,
        devices: OnboardingDevicesFact = .notLoaded,
        capabilityRequests: [OnboardingCapabilityRequest] = [],
        permissions: [OnboardingCapabilityRequest: OnboardingPermission] = [:]
    ) {
        self.host = host
        self.routing = routing
        self.selectedEngine = selectedEngine
        self.selectedEngineIsProvisional = selectedEngineIsProvisional
        self.engines = engines
        self.catalog = catalog
        self.devices = devices
        self.capabilityRequests = capabilityRequests
        self.permissions = permissions
    }
}

public enum OnboardingExecutorStatus: Equatable, Sendable {
    case unknown
    case notPaired
    case revoked
    case offline
    case online(deviceID: String)
}

public enum OnboardingAction: String, CaseIterable, Sendable {
    /// Re-read `/health`, `/v1/engines/catalog` and projection lists from the current host. No sign-in or inference.
    case retryHost
    /// Re-read `/v1/devices` from the current host.
    case refreshDevices
}

public enum OnboardingStep: Equatable, Hashable, Sendable {
    public enum Kind: String, CaseIterable, Sendable {
        case hostUnconfigured, hostPairingUnavailable, hostChecking, hostOffline, hostValidationFailed
        case engineRoutingOff, engineUnavailable, engineLoginRequired, engineLoginUnknown
        case executorNotPaired, executorRevoked, executorOffline, executorUnknown
        case capabilityNotOffered, permissionPending, permissionDenied, permissionUnknown
    }

    case hostUnconfigured, hostPairingUnavailable, hostChecking, hostOffline, hostValidationFailed
    case engineRoutingOff
    case engineUnavailable(EngineID)
    case engineLoginRequired(EngineID)
    case engineLoginUnknown(EngineID)
    case executorNotPaired, executorRevoked, executorOffline, executorUnknown
    case capabilityNotOffered(String)
    case permissionPending(String)
    case permissionDenied(String)
    case permissionUnknown(String)

    public var kind: Kind {
        switch self {
        case .hostUnconfigured: .hostUnconfigured
        case .hostPairingUnavailable: .hostPairingUnavailable
        case .hostChecking: .hostChecking
        case .hostOffline: .hostOffline
        case .hostValidationFailed: .hostValidationFailed
        case .engineRoutingOff: .engineRoutingOff
        case .engineUnavailable: .engineUnavailable
        case .engineLoginRequired: .engineLoginRequired
        case .engineLoginUnknown: .engineLoginUnknown
        case .executorNotPaired: .executorNotPaired
        case .executorRevoked: .executorRevoked
        case .executorOffline: .executorOffline
        case .executorUnknown: .executorUnknown
        case .capabilityNotOffered: .capabilityNotOffered
        case .permissionPending: .permissionPending
        case .permissionDenied: .permissionDenied
        case .permissionUnknown: .permissionUnknown
        }
    }

    /// The single string argument substituted into `%@` in this step's copy, if any.
    public var argument: String? {
        switch self {
        case .engineUnavailable(let engine), .engineLoginRequired(let engine), .engineLoginUnknown(let engine):
            engine.displayName
        case .capabilityNotOffered(let capability), .permissionPending(let capability),
             .permissionDenied(let capability), .permissionUnknown(let capability):
            capability
        default:
            nil
        }
    }

    /// Host and engine facts belong to "can I talk?"; Mac agent and permission facts belong to Este Mac.
    public var concernsConversation: Bool {
        switch kind {
        case .hostUnconfigured, .hostPairingUnavailable, .hostChecking, .hostOffline, .hostValidationFailed,
             .engineRoutingOff, .engineUnavailable, .engineLoginRequired, .engineLoginUnknown: true
        default: false
        }
    }

    /// Only host and engine problems stop text conversation; Mac tools and permissions never do.
    public var blocksConversation: Bool {
        switch kind {
        case .hostUnconfigured, .hostPairingUnavailable, .hostOffline, .hostValidationFailed, .engineRoutingOff, .engineUnavailable, .engineLoginRequired: true
        default: false
        }
    }

    /// Existing app actions only. Engine sign-in and macOS permissions are completed outside Dexter.
    public var action: OnboardingAction? {
        switch kind {
        case .hostOffline, .hostValidationFailed, .engineRoutingOff, .engineUnavailable, .engineLoginRequired: .retryHost
        case .executorNotPaired, .executorRevoked, .executorOffline, .executorUnknown: .refreshDevices
        default: nil
        }
    }
}

public enum OnboardingConversationStatus: Equatable, Sendable {
    case fixture
    case blocked
    /// Nothing known blocks it, but engine sign-in has not been confirmed.
    case unconfirmed
    case ready
}

public struct OnboardingReadiness: Equatable, Sendable {
    public let steps: [OnboardingStep]
    public let conversation: OnboardingConversationStatus
    public let executor: OnboardingExecutorStatus

    public init(_ input: OnboardingReadinessInput) {
        var steps: [OnboardingStep] = []
        switch input.host {
        case .fixture:
            self.steps = []; conversation = .fixture; executor = .unknown; return
        case .unconfigured: steps.append(.hostUnconfigured)
        case .pairingUnavailable: steps.append(.hostPairingUnavailable)
        case .checking: steps.append(.hostChecking)
        case .offline: steps.append(.hostOffline)
        case .validationFailed: steps.append(.hostValidationFailed)
        case .online: break
        }
        guard case .online(let identity) = input.host else {
            // Nothing from a previous or unreachable host is reported as current.
            self.steps = steps
            conversation = .blocked
            executor = .unknown
            return
        }

        var engineConfirmed = false
        if input.routing == .notConnected {
            steps.append(.engineRoutingOff)
        } else if let engine = input.selectedEngine {
            let observation = input.engines[engine] ?? OnboardingEngineObservation()
            let catalogEntry = input.catalog?.entries.first { $0.id == engine.rawValue }
            let catalogIsNewer = input.catalog.map { $0.observedAt >= observation.observedAt } ?? false
            let catalogUnavailable = catalogEntry.map { !EngineReadiness(entry: $0).canRun } ?? false
            if case .connected(let routed?) = input.routing, !routed.contains(engine) {
                steps.append(.engineUnavailable(engine))
            } else if catalogIsNewer && catalogUnavailable {
                steps.append(.engineUnavailable(engine))
            } else if observation.unavailable && !catalogIsNewer {
                steps.append(.engineUnavailable(engine))
            } else {
                switch observation.authentication {
                case .required: steps.append(.engineLoginRequired(engine))
                case .unknown: steps.append(.engineLoginUnknown(engine))
                case .authenticated: engineConfirmed = { if case .connected = input.routing { true } else { false } }()
                }
            }
        }

        if input.selectedEngineIsProvisional, let last = steps.last, last.blocksConversation,
           [.engineUnavailable, .engineLoginRequired].contains(last.kind) {
            steps.removeLast()
        }

        let executor = Self.executor(input.devices, excluding: identity.clientDeviceID)
        switch executor {
        case .unknown: steps.append(.executorUnknown)
        case .notPaired: steps.append(.executorNotPaired)
        case .revoked: steps.append(.executorRevoked)
        case .offline: steps.append(.executorOffline)
        case .online: break
        }

        if case .online(let executorID) = executor, case .loaded(let devices) = input.devices,
           let device = devices.first(where: { $0.id == executorID }) {
            var seen = Set<OnboardingCapabilityRequest>()
            for request in input.capabilityRequests where request.deviceID == executorID && seen.insert(request).inserted {
                guard device.capabilities.contains(request.capability) else {
                    steps.append(.capabilityNotOffered(request.capability)); continue
                }
                switch input.permissions[request] ?? .unknown {
                case .granted: break
                case .pending: steps.append(.permissionPending(request.capability))
                case .denied: steps.append(.permissionDenied(request.capability))
                case .unknown: steps.append(.permissionUnknown(request.capability))
                }
            }
        }

        self.steps = steps
        self.executor = executor
        if steps.contains(where: \.blocksConversation) { conversation = .blocked }
        else if engineConfirmed { conversation = .ready }
        else { conversation = .unconfirmed }
    }

    /// What Settings › Geral shows under "Estado": the conversation's own facts, never Mac agent steps.
    public var conversationSteps: [OnboardingStep] { steps.filter(\.concernsConversation) }
    /// Mac agent and macOS permission facts, shown in Settings › Este Mac. They never block text.
    public var macSteps: [OnboardingStep] { steps.filter { !$0.concernsConversation } }

    /// Executor = a paired, non-revoked `agent-mac`. A client Mac (including this app) never qualifies.
    static func executor(_ fact: OnboardingDevicesFact, excluding clientDeviceID: String?) -> OnboardingExecutorStatus {
        guard case .loaded(let all) = fact else { return .unknown }
        let macs = all.filter { $0.platform == .macos && $0.id != clientDeviceID }
        func revoked(_ device: DeviceView) -> Bool { device.presence == .revoked || device.revokedAt != nil }
        let agents = macs.filter { $0.role == "agent-mac" }
        let activeAgents = agents.filter { $0.paired && !revoked($0) }
        if let online = activeAgents.first(where: { $0.presence == .online }) { return .online(deviceID: online.id) }
        if !activeAgents.isEmpty { return .offline }
        // Without a role the host did not say whether a paired Mac is a client or an executor.
        if macs.contains(where: { $0.role == nil && $0.paired && !revoked($0) }) { return .unknown }
        if macs.contains(where: { ($0.role == "agent-mac" || $0.role == nil) && revoked($0) }) { return .revoked }
        return .notPaired
    }
}

/// The engine that answers the conversation on screen. The thread's own selection wins over the bot default; a
/// presented thread whose selection was not read yet is `.loading`, never silently the bot default.
public enum EffectiveConversationEngine: Equatable, Sendable {
    public enum Source: Equatable, Sendable { case conversation, botDefault }
    case none
    case loading(botDefault: EngineID)
    case known(EngineID, source: Source, botDefault: EngineID)

    public var engine: EngineID? {
        if case .known(let engine, _, _) = self { return engine }
        return nil
    }

    /// For Settings readiness: the known engine, or the bot default as a provisional stand-in while loading.
    public var readinessEngine: EngineID? {
        switch self {
        case .none: nil
        case .loading(let botDefault): botDefault
        case .known(let engine, _, _): engine
        }
    }

    public var isProvisional: Bool { if case .loading = self { return true }; return false }
}

/// What the chat says about the effective engine, above the composer. Each state is distinct and offers at most
/// one main action; nothing here switches engines, signs in or starts inference by itself.
public struct ConversationEngineStatus: Equatable, Sendable {
    public enum State: Equatable, Sendable {
        /// Nothing known stops this engine (sign-in is still unconfirmed; that is never claimed).
        case clear
        case checking(EngineID)
        /// The host did not answer the catalog lookup; nothing is claimed about the engine.
        case notReported(EngineID)
        case routingOff
        /// `alternative` is only an engine the current catalog reports as runnable on this host.
        case unavailable(EngineID, alternative: EngineID?)
        case loginRequired(EngineID)
    }

    public let state: State

    /// Offline and unconfigured hosts are the chat's own connection line, not an engine fact.
    public init(engine: EffectiveConversationEngine, hostOnline: Bool, routing: OnboardingEngineRouting,
                observation: OnboardingEngineObservation?, catalog: OnboardingEngineCatalog?, lookup: EngineCatalogLookup) {
        guard hostOnline else { state = .clear; return }
        if routing == .notConnected { state = .routingOff; return }
        guard let engine = engine.engine else { state = .clear; return }
        let observation = observation ?? OnboardingEngineObservation()
        let entry = catalog?.entries.first { $0.id == engine.rawValue }
        let catalogIsNewer = catalog.map { $0.observedAt >= observation.observedAt } ?? false
        let alternative = lookup == .loaded ? Self.alternative(to: engine, catalog: catalog?.entries ?? [], routing: routing) : nil
        if case .connected(let routed?) = routing, !routed.contains(engine) {
            state = .unavailable(engine, alternative: alternative); return
        }
        switch lookup {
        case .loading:
            state = observation.authentication == .required ? .loginRequired(engine) : .checking(engine)
        case .loaded:
            if let entry, catalogIsNewer, !EngineReadiness(entry: entry).canRun { state = .unavailable(engine, alternative: alternative) }
            else if observation.unavailable && !catalogIsNewer { state = .unavailable(engine, alternative: alternative) }
            else if observation.authentication == .required { state = .loginRequired(engine) }
            else if entry == nil { state = .notReported(engine) }
            else { state = .clear }
        case .failed:
            if observation.unavailable { state = .unavailable(engine, alternative: nil) }
            else if observation.authentication == .required { state = .loginRequired(engine) }
            else { state = .notReported(engine) }
        case .notLoaded:
            if observation.unavailable { state = .unavailable(engine, alternative: nil) }
            else if observation.authentication == .required { state = .loginRequired(engine) }
            else { state = .clear }
        }
    }

    /// First engine the current catalog reports runnable (Claude, then Codex, then the rest), other than `engine`.
    public static func alternative(to engine: EngineID, catalog: [EngineCatalogEntry], routing: OnboardingEngineRouting) -> EngineID? {
        EngineID.allCases.first { candidate in
            guard candidate != engine, EngineReadiness(entry: catalog.first { $0.id == candidate.rawValue }).canRun else { return false }
            if case .connected(let routed?) = routing { return routed.contains(candidate) }
            return true
        }
    }
}

/// English source keys for the onboarding copy; pt-BR lives in SharedApp's `Localizable.xcstrings`.
public enum OnboardingCopy {
    public static func title(_ kind: OnboardingStep.Kind) -> String {
        switch kind {
        case .hostUnconfigured: "Choose a host"
        case .hostPairingUnavailable: "Pair with your host"
        case .hostChecking: "Checking the host"
        case .hostOffline: "Host offline"
        case .hostValidationFailed: "Couldn't verify the host"
        case .engineRoutingOff: "Engines are off on the host"
        case .engineUnavailable: "%@ is unavailable on the host"
        case .engineLoginRequired: "Sign in to %@ on the host"
        case .engineLoginUnknown: "%@ sign-in not confirmed"
        case .executorNotPaired: "No Mac agent paired"
        case .executorRevoked: "Mac agent revoked"
        case .executorOffline: "Mac agent offline"
        case .executorUnknown: "Mac agent status unknown"
        case .capabilityNotOffered: "%@ isn't offered by the Mac agent"
        case .permissionPending: "%@ is waiting for macOS permission"
        case .permissionDenied: "%@ was denied macOS permission"
        case .permissionUnknown: "%@ permission not checked"
        }
    }

    public static func detail(_ kind: OnboardingStep.Kind) -> String {
        switch kind {
        case .hostUnconfigured: "Apply a local host or import a trusted pairing offer below. Your host keeps state and runs the engines."
        case .hostPairingUnavailable: "This address needs a trusted pairing offer. Import one below; the relay never runs the engines."
        case .hostChecking: "Waiting for the host to answer."
        case .hostOffline: "Dexter can't reach the host. Start it, or check the connection, then retry."
        case .hostValidationFailed: "This app couldn't validate the host's protocol, pairing or trusted connection. This can fail on this device before the host replies. Update Dexter or the host, or pair again, then retry."
        case .engineRoutingOff: "The host answered but isn't routing engines. Start it with engines enabled, then retry."
        case .engineUnavailable: "The host reported this engine as missing or unavailable. Install or enable it on the host, then retry."
        case .engineLoginRequired: "The host reported that sign-in is required. Sign in with the official CLI on the host; Dexter never asks for engine credentials."
        case .engineLoginUnknown: "The host reports routing only, not sign-in. A sign-in problem appears here if a conversation reports it."
        case .executorNotPaired: "Mac tools like the browser and files need a paired Mac agent."
        case .executorRevoked: "This Mac agent can't run tools anymore. Pair it again from the host to use Mac tools."
        case .executorOffline: "Mac tools wait until the Mac agent reconnects."
        case .executorUnknown: "Dexter couldn't confirm a Mac agent from the host's device list."
        case .capabilityNotOffered: "A pending action needs a tool this Mac agent doesn't offer."
        case .permissionPending: "Allow it in System Settings on the Mac agent. Only this tool waits."
        case .permissionDenied: "Allow it in System Settings on the Mac agent to use this tool. Only this tool is affected."
        case .permissionUnknown: "Dexter doesn't check macOS permissions from here. The Mac agent asks when this tool runs."
        }
    }

    public static func action(_ action: OnboardingAction) -> String {
        switch action {
        case .retryHost: "Retry"
        case .refreshDevices: "Refresh devices"
        }
    }

    public static func conversation(_ status: OnboardingConversationStatus) -> String {
        switch status {
        case .fixture: "Demo fixture: no host or engine"
        case .blocked: "Conversation blocked"
        case .unconfirmed: "Conversation available; engine sign-in not confirmed"
        case .ready: "Ready to converse"
        }
    }

    public static let sectionTitle = "Setup"
}
