#if os(macOS)
import DexterHostClient
import Foundation
import Observation

/// Whether the welcome sheet was finished or dismissed in this app. App-domain, non-secret, separate from the base.
public enum OnboardingWelcomeProgress: String, Sendable { case pending, dismissed, completed }

@MainActor public protocol OnboardingWelcomeProgressStore: AnyObject {
    var progress: OnboardingWelcomeProgress { get }
    func record(_ progress: OnboardingWelcomeProgress)
}

@MainActor public final class UserDefaultsOnboardingWelcomeProgressStore: OnboardingWelcomeProgressStore {
    public static let key = "com.dexter.apple.onboarding-welcome.v1"
    private let defaults: UserDefaults
    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }
    public var progress: OnboardingWelcomeProgress {
        (defaults.string(forKey: Self.key)).flatMap(OnboardingWelcomeProgress.init(rawValue:)) ?? .pending
    }
    public func record(_ progress: OnboardingWelcomeProgress) { defaults.set(progress.rawValue, forKey: Self.key) }
}

/// QA and tests: never touches a defaults domain.
@MainActor public final class InMemoryOnboardingWelcomeProgressStore: OnboardingWelcomeProgressStore {
    public private(set) var progress: OnboardingWelcomeProgress
    public init(_ progress: OnboardingWelcomeProgress = .pending) { self.progress = progress }
    public func record(_ progress: OnboardingWelcomeProgress) { self.progress = progress }
}

/// "Quem vai conversar com você?" (UX-P0-04). Discovery is filesystem metadata only: nothing is executed, installed,
/// signed in or read. Choosing an assistant is the owner's explicit consent for the first-use preset, applied only on a Mac
/// with no saved local-engine choice; any saved choice, including an explicit "off", is preserved and changed only in
/// Assistentes. A found program does not prove sign-in or a subscription.
@MainActor @Observable public final class OnboardingWelcomeController {
    public enum CardState: Equatable, Sendable {
        case checking
        /// The base reports it runnable now (sign-in still unconfirmed).
        case ready
        /// Found on this Mac and nothing saved yet: choosing turns it on for this Mac's base.
        case foundOnThisMac
        /// The saved choice already runs it, but the base does not report it runnable.
        case alreadyChosen
        /// A saved choice exists and does not include it: change it in Assistentes, never here.
        case savedChoiceDiffers
        case notInstalled
        /// The base reports it present but unavailable or unsupported.
        case unavailable
        case notReported
    }
    public struct Card: Equatable, Identifiable, Sendable {
        public let engine: EngineID
        public let state: CardState
        public var id: String { engine.rawValue }
        public var canChoose: Bool { state == .ready || state == .foundOnThisMac }
    }
    public enum Failure: Equatable, Sendable {
        case applyRefused(message: String)
        case engineNotReady(EngineID)
        case createRefused(message: String)
        /// Sent, outcome unknown: only Conferir (a read) may follow.
        case createUnconfirmed
        /// Conferir found no new bot: a new creation is a new explicit decision.
        case createNotFound
        case ambiguous(count: Int)
        case changed
    }
    public enum Phase: Equatable, Sendable {
        case choosing
        case preparing(EngineID)
        case checking(EngineID)
        case creating(EngineID)
        case finished(botID: String)
        case failed(Failure)
    }

    public static let engines: [EngineID] = [.claude, .codex]
    public static let defaultBotName = "Assistente"

    public var botName: String = OnboardingWelcomeController.defaultBotName
    public private(set) var cards: [Card] = []
    public private(set) var phase: Phase = .choosing
    public private(set) var chosenEngine: EngineID?
    @ObservationIgnored private let model: DexterAppModel
    @ObservationIgnored private let localHost: LocalHostLaunchCoordinator?
    @ObservationIgnored private let store: any OnboardingWelcomeProgressStore
    @ObservationIgnored private let discover: @MainActor (LocalEngineKind) -> [LocalEngineCandidate]
    @ObservationIgnored private var pendingAttempt: FirstUseBotAttempt?

    public init(model: DexterAppModel, localHost: LocalHostLaunchCoordinator?, store: any OnboardingWelcomeProgressStore,
                discover: (@MainActor (LocalEngineKind) -> [LocalEngineCandidate])? = nil) {
        self.model = model; self.localHost = localHost; self.store = store
        self.discover = discover ?? { LocalEngineDiscovery().candidates(for: $0) }
    }

    /// Present when the owner's base has no bots and the sheet was neither finished nor dismissed. Reopening is explicit.
    public static func shouldPresent(model: DexterAppModel, store: any OnboardingWelcomeProgressStore) -> Bool {
        store.progress == .pending && !model.isFixture && model.canCreateFirstUseBot && !model.isLoading && model.bots.isEmpty
    }

    /// This app manages the base on this Mac and may apply the first-use preset to it.
    public var managesThisMac: Bool { localHost?.acceptsLocalEnginePreference == true && model.canEditBotProfiles }

    public var isWorking: Bool {
        switch phase { case .preparing, .checking, .creating: true; default: false }
    }

    public func refresh() async {
        await model.refreshEngineCatalog()
        recomputeCards()
    }

    public func recomputeCards() { cards = Self.engines.map { Card(engine: $0, state: cardState($0)) } }

    private func plan(_ engine: EngineID) -> FirstUseEnginePlan? {
        guard managesThisMac, let localHost, let kind = LocalEngineKind(rawValue: engine.rawValue) else { return nil }
        return FirstUseEnginePlan.make(stored: localHost.loadLocalEnginePreference(), kind: kind, candidates: discover(kind))
    }

    private func cardState(_ engine: EngineID) -> CardState {
        let readiness = model.engineReadiness(for: engine)
        if readiness == .checking { return .checking }
        if readiness.canRun { return .ready }
        if let plan = plan(engine) {
            switch plan {
            case .applyPreset: return .foundOnThisMac
            case .alreadyChosen: return .alreadyChosen
            case .preserveExisting:
                let found = LocalEngineKind(rawValue: engine.rawValue).map { !discover($0).isEmpty } ?? false
                return found ? .savedChoiceDiffers : .notInstalled
            case .notFound: return .notInstalled
            }
        }
        switch readiness {
        case .notFound: return .notInstalled
        case .foundUnsupported, .foundUnavailable: return .unavailable
        default: return .notReported
        }
    }

    private var trimmedName: String {
        let name = botName.trimmingCharacters(in: .whitespacesAndNewlines)
        return name.isEmpty ? Self.defaultBotName : String(name.prefix(80))
    }

    /// "Usar Claude": preset (only when nothing is saved) → catalog re-read → one bot creation → conversation opens.
    public func choose(_ engine: EngineID) async {
        guard !isWorking, Self.engines.contains(engine) else { return }
        recomputeCards()
        guard let card = cards.first(where: { $0.engine == engine }), card.canChoose else { return }
        chosenEngine = engine
        let address = model.hostAddress
        if card.state == .foundOnThisMac {
            guard let localHost, case .applyPreset(let preset)? = plan(engine) else { phase = .failed(.changed); return }
            phase = .preparing(engine)
            switch await localHost.applyLocalEnginePreference(preset, model: model) {
            case .applied: break
            case .refused(let refusal): phase = .failed(.applyRefused(message: refusal.message)); recomputeCards(); return
            case .idle, .applying: phase = .failed(.changed); return
            }
        }
        guard model.hostAddress == address, model.canCreateFirstUseBot else { phase = .failed(.changed); return }
        phase = .checking(engine)
        await model.refreshEngineCatalog()
        recomputeCards()
        guard model.hostAddress == address else { phase = .failed(.changed); return }
        guard model.engineReadiness(for: engine).canRun else { phase = .failed(.engineNotReady(engine)); return }
        await create(engine)
    }

    /// Conferir after an unconfirmed creation: a read of the bot list only.
    public func confirmCreation() async {
        guard !isWorking, let attempt = pendingAttempt, let engine = chosenEngine else { return }
        phase = .creating(engine)
        handle(await model.reconcileFirstUseBot(attempt))
    }

    /// After Conferir showed no new bot: a new, explicit creation (the owner was told a late original could still appear).
    public func createAgain() async {
        guard !isWorking, case .failed(.createNotFound) = phase, let engine = chosenEngine else { return }
        await create(engine)
    }

    /// "Agora não": the sheet does not come back by itself; the empty window and Settings › Geral can reopen it.
    public func dismiss() {
        if case .finished = phase { return }
        store.record(.dismissed)
    }

    public func reopen() {
        guard !isWorking else { return }
        phase = .choosing; pendingAttempt = nil
        recomputeCards()
    }

    private func create(_ engine: EngineID) async {
        phase = .creating(engine)
        handle(await model.createFirstUseBot(name: trimmedName, engine: engine))
    }

    private func handle(_ outcome: FirstUseBotOutcome) {
        switch outcome {
        case .created(let botID):
            pendingAttempt = nil; store.record(.completed); phase = .finished(botID: botID)
        case .refused(let message):
            pendingAttempt = nil; phase = .failed(.createRefused(message: message))
        case .unconfirmed(let attempt):
            pendingAttempt = attempt; phase = .failed(.createUnconfirmed)
        case .notFound(let attempt):
            pendingAttempt = attempt; phase = .failed(.createNotFound)
        case .ambiguous(let count):
            pendingAttempt = nil; store.record(.completed); phase = .failed(.ambiguous(count: count))
        case .stale:
            pendingAttempt = nil; phase = .failed(.changed)
        }
    }
}
#endif
