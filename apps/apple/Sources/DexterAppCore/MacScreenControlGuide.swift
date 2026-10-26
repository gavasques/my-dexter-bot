#if os(macOS)
import DexterHostClient
import Foundation

/// Host-side access of one bot to one screen-control operation on THIS Mac. Same closed vocabulary and precedence as the
/// passive `dexter.harness.mac.setup.status` projection; that status aggregates every own route (any Mac), so with several
/// Macs the two may differ. `valid` is route publication plus a current host grant; never native permissions or a session.
public enum MacScreenControlHostAccess: String, Equatable, Sendable {
    case valid, missing, denied, expired
    case revisionRequired = "revision_required", notPublished = "not_published", unknown

    /// Rows of other bots or other devices are ignored; duplicates are ambiguous and never resolved by picking one.
    /// `nil` grants or routes mean "not read for this bot", reported as unknown for every operation.
    public static func read(botID: String, deviceID: String, grants: [DeviceGrantRow]?, routes: [DeviceConversationRoute]?,
                            now: Date) -> [String: Self] {
        var result: [String: Self] = [:]
        for operation in LocalMacAgentCuaAuthorization.operations {
            guard let grants, let routes else { result[operation] = .unknown; continue }
            let published = routes.filter { $0.botId == botID && $0.deviceId == deviceID && $0.tool == operation }
            let rows = grants.filter { $0.botID == botID && $0.destination == deviceID && $0.tool == operation }
            result[operation] = {
                guard published.count <= 1, rows.count <= 1 else { return .unknown }
                guard let route = published.first else { return .notPublished }
                guard route.isValid else { return .unknown }
                guard route.status == .active else { return .notPublished }
                // Same precedence as the host status: an explicit block or expiry is never shown as "renew".
                guard let row = rows.first, let policy = row.policy else { return .missing }
                if policy == "deny" { return .denied }
                if row.isExpired(at: now) { return .expired }
                if route.needsFreshGrant || (row.revision.map { $0 < route.minimumGrantRevision } ?? false) { return .revisionRequired }
                return ["ask", "allow"].contains(policy) ? .valid : .unknown
            }()
        }
        return result
    }
}

/// Read-only facts the app can observe for one bot on THIS Mac. None of them proves macOS permissions, the lock
/// check, the app the owner will pick or a consented session: those exist only in Dexter Control, at use time.
public struct MacScreenControlFacts: Equatable, Sendable {
    public enum Setup: Equatable, Sendable {
        /// This app package does not include the screen-control helper.
        case packageMissing
        case notPrepared
        /// A prepared private configuration; `screenControl` says whether its helper and operations are configured.
        case prepared(screenControl: Bool)
        /// Files exist but do not form a configuration this app prepared.
        case conflict
        /// The configuration could not be checked against the connected host.
        case unverified
    }
    public enum Agent: Equatable, Sendable { case running, stopping, stopped }
    public enum Device: Equatable, Sendable {
        /// No public pairing record yet for this Mac's agent.
        case notBound
        /// A pairing record exists but the host projection does not (yet) show that device.
        case unknown
        case bound(DeviceView)
    }
    public enum Local: Equatable, Sendable {
        case unknown, missing
        case authorized(operations: [String], maxSessionSeconds: Int)
    }
    public var setup: Setup
    public var agent: Agent
    public var device: Device
    public var botID: String?
    public var hostAccess: [String: MacScreenControlHostAccess]
    public var local: Local
    /// The same runtime gate as the existing preparation sheet (no turn draining, Apply or restart in progress).
    public var preparationAllowed: Bool

    public init(setup: Setup, agent: Agent, device: Device, botID: String?, hostAccess: [String: MacScreenControlHostAccess],
                local: Local, preparationAllowed: Bool) {
        self.setup = setup; self.agent = agent; self.device = device; self.botID = botID
        self.hostAccess = hostAccess; self.local = local; self.preparationAllowed = preparationAllowed
    }
}

/// Progressive guide for one bot: each layer's real state and the one action that moves it forward.
/// Pure: it reads nothing, starts nothing and grants nothing. It never reports the native layers as done.
public struct MacScreenControlGuide: Equatable, Sendable {
    public enum StepKind: String, CaseIterable, Sendable { case mac, hostAccess, localAuthorization, macPermissions, eachUse }
    public enum StepState: Equatable, Sendable {
        case done, needed, waiting, attention, unknown
        /// Owned by Dexter Control on this Mac; the app cannot read it.
        case notReadable
        /// Asked again every time a bot wants to use the screen.
        case perUse
        case unavailable
    }
    /// Why a step is in its state; the view turns it into copy.
    public enum Detail: Equatable, Sendable {
        case ready, packageMissing, conflict, unverified, notPrepared, helperNotConfigured, agentStopped, agentStopping
        case pairingPending, revoked, offline, capabilitiesNotAdvertised, deviceUnknown
        case chooseBot, waitingForMac, accessNeeded, accessUnknown, localNeeded, localUnknown, stopToEdit
        case checkOnThisMac, eachUse
    }
    /// Existing owner actions only. None of them grants access by itself.
    public enum Action: Equatable, Sendable {
        /// Opens the existing "Preparar este Mac" sheet (identity, pairing and start stay in that sheet).
        case prepareMac
        /// The same sheet restarts an already prepared and paired agent.
        case startAgent
        /// Existing stopped-agent helper copy for an older configuration without screen control.
        case prepareHelper
        case stopAgent
        case chooseBot
        /// Host grants and conversation publication of this bot on this Mac.
        case reviewBotAccess
        case editLocalAuthorization
        /// Brings the already running Dexter Control forward; never launches it.
        case showControlPanel
        case checkAgain, reload, openAdvanced
    }
    public struct Step: Equatable, Sendable, Identifiable {
        public let kind: StepKind
        public let state: StepState
        public let detail: Detail
        public let action: Action?
        /// Screen-control operations this layer allows, in canonical order (empty when unknown).
        public let operations: [String]
        public var id: StepKind { kind }
    }
    public enum Summary: Equatable, Sendable {
        case unavailable, attention, chooseBot
        /// App-verifiable steps still open (Este Mac, base access, local authorization).
        case remaining(Int)
        /// Every app-verifiable layer allows at least viewing; native permissions and the session stay per use.
        case configured(control: Bool)
    }

    public static let operations = LocalMacAgentCuaAuthorization.operations
    /// Without status no consented session can be asked for; without observe nothing can be seen.
    static let minimum: Set<String> = ["mac.cua.status", "mac.cua.observe"]

    public let steps: [Step]
    public let next: StepKind?
    public let action: Action?
    /// The action exists but the preparation gate is closed (for example, a conversation is still answering).
    public let actionBlockedByRuntime: Bool
    public let summary: Summary
    /// Operations every app-verifiable layer allows; empty until all of them are known and done.
    public let effectiveOperations: [String]

    public init(_ facts: MacScreenControlFacts) {
        func ordered(_ values: Set<String>) -> [String] { Self.operations.filter(values.contains) }
        func useful(_ values: Set<String>) -> Bool { Self.minimum.isSubset(of: values) }
        let all = Set(Self.operations)
        let device: DeviceView? = if case .bound(let value) = facts.device { value } else { nil }
        let usableDevice = device.map { $0.paired && $0.revokedAt == nil && $0.presence != .revoked } ?? false

        // 1. Este Mac: prepared configuration, owned agent, pairing and advertised operations.
        var advertised = Set<String>()
        var macOnlyStopped = false
        let mac: Step = {
            func step(_ state: StepState, _ detail: Detail, _ action: Action?, _ operations: [String] = []) -> Step {
                Step(kind: .mac, state: state, detail: detail, action: action, operations: operations)
            }
            switch facts.setup {
            case .packageMissing: return step(.unavailable, .packageMissing, nil)
            case .conflict: return step(.attention, .conflict, .openAdvanced)
            case .unverified: return step(.unknown, .unverified, .reload)
            case .notPrepared: return step(.needed, .notPrepared, .prepareMac)
            case .prepared(screenControl: false):
                switch facts.agent {
                case .stopped: return step(.needed, .helperNotConfigured, .prepareHelper)
                case .running: return step(.needed, .helperNotConfigured, .stopAgent)
                case .stopping: return step(.waiting, .agentStopping, nil)
                }
            case .prepared(screenControl: true):
                if let device { advertised = Set(device.capabilities).intersection(all) }
                switch (facts.agent, facts.device) {
                case (.stopping, _): return step(.waiting, .agentStopping, nil)
                case (_, .notBound): return step(facts.agent == .running ? .waiting : .needed, .pairingPending, .prepareMac)
                case (_, .unknown): return step(.unknown, .deviceUnknown, .checkAgain)
                case (_, .bound(let device)):
                    if device.revokedAt != nil || device.presence == .revoked { return step(.attention, .revoked, .openAdvanced) }
                    if !device.paired { return step(.waiting, .pairingPending, .prepareMac) }
                    if facts.agent == .stopped { macOnlyStopped = true; return step(.needed, .agentStopped, .startAgent) }
                    if device.presence != .online { return step(.waiting, .offline, .checkAgain) }
                    guard useful(advertised) else { return step(.attention, .capabilitiesNotAdvertised, .openAdvanced, ordered(advertised)) }
                    return step(.done, .ready, nil, ordered(advertised))
                }
            }
        }()

        // 2. Base: conversation publication and a current host grant, for this bot on this Mac only.
        let hostValid = Set(facts.hostAccess.filter { $0.value == .valid }.keys).intersection(all)
        let host: Step = {
            func step(_ state: StepState, _ detail: Detail, _ action: Action?, _ operations: [String] = []) -> Step {
                Step(kind: .hostAccess, state: state, detail: detail, action: action, operations: operations)
            }
            guard facts.botID != nil else { return step(.needed, .chooseBot, .chooseBot) }
            guard usableDevice else { return step(.waiting, .waitingForMac, nil) }
            if useful(hostValid) { return step(.done, .ready, nil, ordered(hostValid)) }
            if Self.minimum.contains(where: { (facts.hostAccess[$0] ?? .unknown) == .unknown }) {
                return step(.unknown, .accessUnknown, .reload, ordered(hostValid))
            }
            return step(.needed, .accessNeeded, .reviewBotAccess, ordered(hostValid))
        }()

        // 3. This Mac's private per-bot authorization (deny by default; written only while the agent is stopped).
        var localOperations = Set<String>()
        let local: Step = {
            func step(_ state: StepState, _ detail: Detail, _ action: Action?, _ operations: [String] = []) -> Step {
                Step(kind: .localAuthorization, state: state, detail: detail, action: action, operations: operations)
            }
            guard facts.botID != nil else { return step(.waiting, .chooseBot, nil) }
            guard facts.setup == .prepared(screenControl: true) else { return step(.waiting, .waitingForMac, nil) }
            switch facts.local {
            case .unknown: return step(.unknown, .localUnknown, .reload)
            case .authorized(let operations, _) where useful(Set(operations).intersection(all)):
                localOperations = Set(operations).intersection(all)
                return step(.done, .ready, nil, ordered(localOperations))
            case .authorized, .missing:
                switch facts.agent {
                case .stopped: return step(.needed, .localNeeded, .editLocalAuthorization)
                case .running: return step(.needed, .stopToEdit, .stopAgent)
                case .stopping: return step(.waiting, .agentStopping, nil)
                }
            }
        }()

        let verifiable = [mac, host, local]
        let configured = verifiable.allSatisfy { $0.state == .done }
        let permissions = Step(kind: .macPermissions, state: .notReadable, detail: .checkOnThisMac,
                               action: configured ? .showControlPanel : nil, operations: [])
        let eachUse = Step(kind: .eachUse, state: .perUse, detail: .eachUse, action: nil, operations: [])
        steps = verifiable + [permissions, eachUse]

        // The first open step leads, except a stopped-but-paired agent: finish edits first, start once afterwards.
        let open = verifiable.filter { $0.state != .done }
        let leading = macOnlyStopped ? (open.first { $0.kind != .mac && $0.action != nil } ?? open.first) : open.first
        let nextStep = leading ?? permissions
        next = nextStep.kind
        action = nextStep.action
        actionBlockedByRuntime = [.prepareMac, .startAgent].contains(nextStep.action) && !facts.preparationAllowed

        effectiveOperations = configured ? ordered(advertised.intersection(hostValid).intersection(localOperations)) : []
        if facts.setup == .packageMissing { summary = .unavailable }
        else if verifiable.contains(where: { $0.state == .attention }) { summary = .attention }
        else if facts.botID == nil, next != .mac { summary = .chooseBot }
        else if configured { summary = .configured(control: effectiveOperations.contains("mac.cua.control")) }
        else { summary = .remaining(open.count) }
    }
}
#endif
