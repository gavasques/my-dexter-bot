import DexterHostClient
import Foundation

/// Small, content-free projection of the conversation the app is actually observing. Every sidebar occurrence of a
/// bot reads this same value; membership/selection never makes other bots busy. No reads, polling, or engine calls.
public struct BotSidebarActivitySnapshot: Equatable, Sendable {
    public let botID: String?
    private let facts: BotMascotHostFacts
    private let approvalExpirations: [Int64?]

    /// A canonical terminal observation may outlive its observer briefly, but cached running work never does.
    public static func terminalIsFresh(_ turn: Turn?, at now: Int64) -> Bool {
        guard let turn, let finished = turn.finishedAt, finished <= now else { return false }
        let window: Int64
        switch turn.state {
        case .completed: window = BotMascotActivity.finishedWindow
        case .failed: window = BotMascotActivity.errorWindow
        default: return false
        }
        return finished > now - window
    }

    public init(botID: String?, threadID: String?, currentTurn: Turn?, actions: [Action], textObserved: Bool,
                events: [TurnEvent] = [], observationActive: Bool = true,
                connection: BotMascotHostFacts.Connection = .connected) {
        guard observationActive, connection != .unavailable, let botID, let threadID else {
            self.botID = nil
            facts = BotMascotHostFacts(connection: .unavailable, now: 0)
            approvalExpirations = []
            return
        }
        self.botID = botID
        let own = actions.filter { $0.request.botId == botID && $0.request.threadId == threadID }
        approvalExpirations = own.filter { $0.state == .awaitingApproval }.map(\.approvalExpiresAt)
        // Only the presence of text is retained, never the answer bytes.
        var observed = BotMascotObservedActivity.facts(botID: botID, threadID: threadID, currentTurn: currentTurn,
            actions: own, streamingText: "", events: events, connection: connection, now: 0)
        observed.textObserved = observed.textObserved || (textObserved && observed.turnState == .running)
        facts = observed
    }

    public func activity(for botID: String, at now: Int64) -> BotMascotActivity {
        guard self.botID == botID else { return .idle }
        var value = facts
        value.now = now
        value.awaitingApproval = approvalExpirations.contains { $0.map { $0 > now } ?? true }
        return .derive(value)
    }

    public func statusLabel(for botID: String?, at now: Int64, portuguese: Bool) -> String {
        guard let botID, self.botID == botID else {
            return portuguese ? "Atividade não observada" : "Activity not observed"
        }
        return activity(for: botID, at: now).label(portuguese: portuguese)
    }

    /// The only clock updates the sidebar needs: exact approval expiry and short terminal-state expiry. Running
    /// turns do not need a state timer. Animation has its own local budget and never refreshes the host.
    public func nextTransition(after now: Int64) -> Int64? {
        guard botID != nil else { return nil }
        var dates = approvalExpirations.compactMap { $0 }.filter { $0 > now }
        if let finished = facts.finishedAt {
            let window: Int64? = facts.turnState == .completed ? BotMascotActivity.finishedWindow
                : facts.turnState == .failed ? BotMascotActivity.errorWindow : nil
            if let window, finished <= Int64.max - window, finished + window > now {
                dates.append(finished + window)
            }
        }
        return dates.min()
    }
}

/// Pure renderer budget, also used by the compact indicator on image/emoji/icon avatars.
public enum BotActivityIndicatorMotion {
    public static func framesPerSecond(activity: BotMascotActivity, motion: BotAvatarAppearance.Motion,
                                       reduceMotion: Bool, isVisible: Bool, isSceneActive: Bool,
                                       lowPower: Bool) -> Double? {
        guard isVisible, isSceneActive, !reduceMotion, motion != .none else { return nil }
        switch activity {
        case .working, .thinking, .writing, .tool, .reconnecting: return lowPower ? 6 : 12
        case .idle, .needsYou, .error, .finished: return nil
        }
    }
}
