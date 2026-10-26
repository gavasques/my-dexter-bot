import DexterHostClient
import Foundation

/// Production activity of one bot in the visible conversation, read only from what the app already observed for that
/// exact bot and thread: the current turn, the thread's actions/events and the streamed answer text. Nothing is synthesized
/// (no fictitious events), other conversations are never aggregated, and `thinking` stays a creator preview.
public enum BotMascotObservedActivity {
    /// - Parameters:
    ///   - currentTurn: the app's current turn; ignored unless it belongs to `botID` in `threadID`.
    ///   - actions: the visible thread's actions as last read from the host.
    ///   - streamingText: answer text received for the current turn ("" when none arrived).
    ///   - connection: pass `.reconnecting` only from a real reconnect signal (the app has none today).
    ///   - now: wall clock in ms, for the short "finished"/"error" moments.
    public static func facts(botID: String, threadID: String, currentTurn: Turn?, actions: [Action], streamingText: String,
                             events: [TurnEvent] = [], observationActive: Bool = true,
                             connection: BotMascotHostFacts.Connection = .connected, now: Int64) -> BotMascotHostFacts {
        // A stopped observer or disconnected host cannot keep stale work/approval animating.
        guard observationActive, connection != .unavailable else {
            return BotMascotHostFacts(connection: .unavailable, now: now)
        }
        let turn = currentTurn.flatMap { $0.botId == botID && $0.threadId == threadID ? $0 : nil }
        let own = actions.filter { $0.request.botId == botID && $0.request.threadId == threadID }
        // A still-valid approval request of this bot in this thread waits for the owner, whatever the turn is doing.
        let awaiting = own.contains { $0.state == .awaitingApproval && ($0.approvalExpiresAt.map { $0 > now } ?? true) }
        let running = turn?.state == .running
        // Only actions created during this turn count as its tool work; an old unreconciled action never pins "tool".
        let turnStart = turn.map { $0.startedAt ?? $0.createdAt } ?? .max
        let toolRunning = running && own.contains { $0.state == .running && $0.createdAt >= turnStart }
        let ownEvents = events.filter { $0.threadId == threadID && $0.turnId == turn?.id }
        var facts = BotMascotHostFacts(turn: turn, events: ownEvents, awaitingApproval: awaiting,
                                      connection: turn == nil && !awaiting ? .connected : connection, now: now)
        facts.textObserved = running && (facts.textObserved || !streamingText.isEmpty)
        facts.hasUnresolvedToolRequest = running && (facts.hasUnresolvedToolRequest || toolRunning)
        return facts
    }

    public static func activity(botID: String, threadID: String, currentTurn: Turn?, actions: [Action], streamingText: String,
                                events: [TurnEvent] = [], observationActive: Bool = true,
                                connection: BotMascotHostFacts.Connection = .connected, now: Int64) -> BotMascotActivity {
        .derive(facts(botID: botID, threadID: threadID, currentTurn: currentTurn, actions: actions, streamingText: streamingText,
                      events: events, observationActive: observationActive, connection: connection, now: now))
    }
}
