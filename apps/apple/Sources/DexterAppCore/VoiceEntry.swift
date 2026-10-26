import DexterHostClient
import Foundation

/// UX-P1-13: one voice entry in the chat. Two different paths exist and are never mixed:
/// - the native Codex call (the official Codex program and its own sign-in; no API key), only in a conversation whose
///   EFFECTIVE engine is Codex and only when the host says this conversation supports it;
/// - Live (the owner's OpenAI API key, billed separately), only after the owner enabled it and saved a key.
/// The entry never falls back from one path to the other by itself: when a Codex conversation cannot call, Live is
/// offered as an explicit choice, never started. A session in progress always keeps its own path.

/// Why the native call is not usable in this conversation, from the conversation and the host's own answer.
public enum NativeVoiceGap: Equatable, Sendable {
    /// The conversation answers with another assistant; the native call exists only with Codex.
    case notCodex(EngineID)
    /// The host reports a program that does not make calls (the version found, when it says).
    case programUpdate(version: String?)
    case signIn
    case modelUnsupported
    /// The host's answer could not be read, or it named another reason.
    case unavailable
}

/// What the app knows about the native call in this conversation. Only `read` comes from the host.
public enum NativeVoiceReading: Equatable, Sendable {
    case notRead
    case reading
    case failed
    case read(supported: Bool, code: NativeVoiceCode?, cliVersion: String?)
}

public enum VoiceEntryBlock: Equatable, Sendable {
    case demo
    case noLocalBase
    case engineLoading
    case replyRunning
}

public enum VoiceEntryRoute: Equatable, Sendable {
    /// Teams, groups or no bot: no voice entry at all.
    case hidden
    /// Shown, disabled, with the reason.
    case unavailable(VoiceEntryBlock)
    /// Reading the host's native-call answer for this Codex conversation; disabled until it arrives.
    case checking
    /// Opens the call sheet; the microphone is used only after "Ligar".
    case nativeCall
    /// Starts the owner's Live session (a conversation that has no native call, with Live set up).
    case live
    /// A Codex conversation that cannot call while Live is set up: the sheet offers Live as an explicit choice.
    case chooseLive(NativeVoiceGap)
    /// Nothing usable: "Configurar voz" explains both paths and their costs.
    case setup(NativeVoiceGap)
    case nativeInProgress
    case liveInProgress

    public var isEnabled: Bool {
        switch self {
        case .hidden, .unavailable, .checking, .liveInProgress: false
        case .nativeCall, .live, .chooseLive, .setup, .nativeInProgress: true
        }
    }
}

public struct VoiceEntryInput: Equatable, Sendable {
    public var privateBotConversation: Bool
    public var isDemo: Bool
    /// The owner's own local base is connected (both paths need it).
    public var ownerLocalBase: Bool
    public var replyBusy: Bool
    public var engine: EffectiveConversationEngine
    public var native: NativeVoiceReading
    /// A native call of this conversation is starting, active, stopping or unconfirmed.
    public var nativeSessionOpen: Bool
    /// Live enabled on this base and a key saved on this Mac for it.
    public var liveConfigured: Bool
    public var liveActive: Bool

    public init(privateBotConversation: Bool, isDemo: Bool, ownerLocalBase: Bool, replyBusy: Bool,
                engine: EffectiveConversationEngine, native: NativeVoiceReading, nativeSessionOpen: Bool,
                liveConfigured: Bool, liveActive: Bool) {
        self.privateBotConversation = privateBotConversation; self.isDemo = isDemo; self.ownerLocalBase = ownerLocalBase
        self.replyBusy = replyBusy; self.engine = engine; self.native = native; self.nativeSessionOpen = nativeSessionOpen
        self.liveConfigured = liveConfigured; self.liveActive = liveActive
    }
}

public enum VoiceEntryDecision {
    public static func route(_ input: VoiceEntryInput) -> VoiceEntryRoute {
        guard input.privateBotConversation else { return .hidden }
        // A session in progress keeps its path whatever changed around it.
        if input.liveActive { return .liveInProgress }
        if input.nativeSessionOpen { return .nativeInProgress }
        if input.isDemo { return .unavailable(.demo) }
        guard input.ownerLocalBase else { return .unavailable(.noLocalBase) }
        switch input.engine {
        case .none:
            return .hidden
        case .loading:
            // The bot default is not the conversation's engine; nothing is decided from it.
            return .unavailable(.engineLoading)
        case .known(let engine, _, _) where engine != .codex:
            guard input.liveConfigured else { return .setup(.notCodex(engine)) }
            return input.replyBusy ? .unavailable(.replyRunning) : .live
        case .known:
            let gap: NativeVoiceGap
            switch input.native {
            case .notRead, .reading:
                return .checking
            case .failed:
                gap = .unavailable
            case .read(let supported, let code, let version):
                if supported { return input.replyBusy ? .unavailable(.replyRunning) : .nativeCall }
                gap = Self.gap(code: code, version: version)
            }
            return input.liveConfigured ? .chooseLive(gap) : .setup(gap)
        }
    }

    static func gap(code: NativeVoiceCode?, version: String?) -> NativeVoiceGap {
        switch code {
        case .authNeeded: .signIn
        case .modelUnsupported: .modelUnsupported
        case .unsupported, nil: .programUpdate(version: version)
        default: .unavailable
        }
    }
}
