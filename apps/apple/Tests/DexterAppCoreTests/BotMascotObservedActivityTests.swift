import DexterHostClient
import XCTest
@testable import DexterAppCore

final class BotMascotObservedActivityTests: XCTestCase {
    private let now: Int64 = 1_800_000_000_000

    private func turn(_ state: String, bot: String = "bot-1", thread: String = "thread-1", startedAt: Int64? = nil, finishedAt: Int64? = nil) throws -> Turn {
        var fields = #""cursor":1,"id":"turn-1","threadId":"\#(thread)","botId":"\#(bot)","engine":"claude","clientRequestId":"req-1","inputMessageId":"msg-1","state":"\#(state)","outputChars":0,"outputTruncated":false,"createdAt":\#(now - 60_000),"updatedAt":\#(now)"#
        if let startedAt { fields += #","startedAt":\#(startedAt)"# }
        if let finishedAt { fields += #","finishedAt":\#(finishedAt)"# }
        return try JSONDecoder().decode(Turn.self, from: Data(("{" + fields + "}").utf8))
    }

    private func action(_ state: ActionState, bot: String = "bot-1", thread: String = "thread-1", createdAt: Int64? = nil, expiresAt: Int64? = nil) -> Action {
        Action(id: UUID().uuidString, request: ActionRequest(botId: bot, threadId: thread, tool: "dexter.files.read", destination: "local",
                                                             arguments: [:], idempotencyKey: "key"),
               requestHash: String(repeating: "a", count: 64), grantRevision: 1, state: state, createdAt: createdAt ?? now - 1_000,
               updatedAt: now, approvalExpiresAt: expiresAt, decidedBy: nil, result: nil, reason: nil)
    }

    private func activity(_ turn: Turn?, _ actions: [Action] = [], text: String = "") -> BotMascotActivity {
        BotMascotObservedActivity.activity(botID: "bot-1", threadID: "thread-1", currentTurn: turn, actions: actions, streamingText: text, now: now)
    }

    private func event(_ kind: String, cursor: Int64 = 1, turn: String = "turn-1", thread: String = "thread-1", text: String? = nil) throws -> TurnEvent {
        var object: [String: Any] = ["cursor": cursor, "turnId": turn, "threadId": thread, "kind": kind, "createdAt": now]
        if let text { object["text"] = text }
        return try JSONDecoder().decode(TurnEvent.self, from: JSONSerialization.data(withJSONObject: object))
    }

    func testRunningTurnReadsWorkingWritingOrTool() throws {
        let running = try turn("running", startedAt: now - 30_000)
        XCTAssertEqual(activity(running), .working)
        XCTAssertEqual(activity(running, text: "Olá"), .writing)
        XCTAssertEqual(activity(running, [action(.running)], text: "Olá"), .tool)
        // Ready/finished actions are not tool work in progress.
        XCTAssertEqual(activity(running, [action(.ready), action(.succeeded)]), .working)
        // An unreconciled action from before this turn never pins the tool state.
        XCTAssertEqual(activity(running, [action(.running, createdAt: now - 45_000)]), .working)
    }

    func testOnlyThisBotAndThreadCount() throws {
        let running = try turn("running", startedAt: now - 30_000)
        XCTAssertEqual(activity(running, [action(.running, bot: "bot-2"), action(.awaitingApproval, thread: "thread-2", expiresAt: now + 60_000)]), .working)
        XCTAssertEqual(activity(try turn("running", bot: "bot-2")), .idle)
        XCTAssertEqual(activity(try turn("running", thread: "thread-2"), text: "texto de outra conversa"), .idle)
    }

    func testApprovalWaitsOnlyWhileValid() throws {
        XCTAssertEqual(activity(nil, [action(.awaitingApproval, expiresAt: now + 60_000)]), .needsYou)
        XCTAssertEqual(activity(try turn("running", startedAt: now - 30_000), [action(.awaitingApproval, expiresAt: now + 1), action(.running)]), .needsYou)
        XCTAssertEqual(activity(nil, [action(.awaitingApproval, expiresAt: now)]), .idle)
        XCTAssertEqual(activity(nil, [action(.awaitingApproval, expiresAt: now - 5)]), .idle)
    }

    func testTerminalTurnsShowBrieflyThenRest() throws {
        XCTAssertEqual(activity(try turn("completed", finishedAt: now - 1_000)), .finished)
        XCTAssertEqual(activity(try turn("completed", finishedAt: now - 3_000), text: "resto"), .idle)
        XCTAssertEqual(activity(try turn("failed", finishedAt: now - 2_000)), .error)
        XCTAssertEqual(activity(try turn("failed", finishedAt: now - 7_000)), .idle)
        XCTAssertEqual(activity(try turn("completed")), .idle, "no confirmed finish time, no claim")
        for state in ["queued", "interrupted", "unknown"] {
            XCTAssertEqual(activity(try turn(state, finishedAt: now), text: "parcial"), .idle, state)
        }
        XCTAssertEqual(activity(nil, text: "sem turno"), .idle)
    }

    func testFactsCarryNoFictitiousEvents() throws {
        let facts = BotMascotObservedActivity.facts(botID: "bot-1", threadID: "thread-1", currentTurn: try turn("running", startedAt: now - 1),
                                                    actions: [], streamingText: "Olá", now: now)
        XCTAssertNil(facts.latestEvent)
        XCTAssertTrue(facts.textObserved)
        XCTAssertEqual(facts.connection, .connected)
    }

    func testOnlyExactObservedTurnEventsAffectActivity() throws {
        let running = try turn("running", startedAt: now - 10_000)
        func observed(_ events: [TurnEvent]) -> BotMascotActivity {
            BotMascotObservedActivity.activity(botID: "bot-1", threadID: "thread-1", currentTurn: running,
                actions: [], streamingText: "", events: events, now: now)
        }
        XCTAssertEqual(observed([try event("tool.requested", turn: "other"), try event("text.delta", thread: "other", text: "foreign")]), .working)
        XCTAssertEqual(observed([try event("text.delta", text: "Olá")]), .writing)
        XCTAssertEqual(observed([try event("tool.requested")]), .tool)
        XCTAssertEqual(observed([try event("tool.requested"), try event("tool.resolved", cursor: 2)]), .working)
        XCTAssertNotEqual(observed([try event("turn.started")]), .thinking)
    }

    func testStoppedAndDisconnectedObservationSettleDespiteCachedWork() throws {
        let running = try turn("running", startedAt: now - 10_000)
        let pending = [action(.awaitingApproval, expiresAt: now + 60_000), action(.running)]
        XCTAssertEqual(BotMascotObservedActivity.activity(botID: "bot-1", threadID: "thread-1", currentTurn: running,
            actions: pending, streamingText: "partial", observationActive: false, now: now), .idle)
        XCTAssertEqual(BotMascotObservedActivity.activity(botID: "bot-1", threadID: "thread-1", currentTurn: running,
            actions: pending, streamingText: "partial", connection: .unavailable, now: now), .idle)
        XCTAssertEqual(BotMascotObservedActivity.activity(botID: "bot-1", threadID: "thread-1", currentTurn: running,
            actions: [], streamingText: "", connection: .reconnecting, now: now), .reconnecting)
        XCTAssertEqual(BotMascotObservedActivity.activity(botID: "bot-2", threadID: "thread-1", currentTurn: running,
            actions: [], streamingText: "", connection: .reconnecting, now: now), .idle)
    }

    func testSidebarSharesExactBotAcrossRowsAndDoesNotClaimOtherBotsIdle() throws {
        let snapshot = BotSidebarActivitySnapshot(botID: "bot-1", threadID: "thread-1",
            currentTurn: try turn("running", startedAt: now - 10_000), actions: [], textObserved: true)
        let rows = ["bot-1", "bot-2", "bot-1", "coordinator", "bot-1"]
        XCTAssertEqual(rows.map { snapshot.activity(for: $0, at: now) }, [.writing, .idle, .writing, .idle, .writing])
        XCTAssertEqual(snapshot.statusLabel(for: "bot-2", at: now, portuguese: true), "Atividade não observada")
        XCTAssertEqual(snapshot.statusLabel(for: "bot-2", at: now, portuguese: false), "Activity not observed")
        XCTAssertEqual(snapshot.statusLabel(for: "bot-1", at: now, portuguese: true), "Escrevendo")
        XCTAssertEqual(snapshot.statusLabel(for: "bot-1", at: now, portuguese: false), "Writing")
        XCTAssertNil(snapshot.nextTransition(after: now), "running rows do not need a state timer")
    }

    func testSidebarRejectsMismatchedTurnAndStopsOnUnavailableObservation() throws {
        let running = try turn("running", startedAt: now - 10_000)
        let wrongThread = BotSidebarActivitySnapshot(botID: "bot-1", threadID: "other", currentTurn: running, actions: [], textObserved: true)
        XCTAssertEqual(wrongThread.activity(for: "bot-1", at: now), .idle)
        for connection in [BotMascotHostFacts.Connection.connected, .unavailable] {
            let stopped = BotSidebarActivitySnapshot(botID: "bot-1", threadID: "thread-1", currentTurn: running,
                actions: [action(.awaitingApproval, expiresAt: now + 60_000)], textObserved: true,
                observationActive: false, connection: connection)
            XCTAssertEqual(stopped.activity(for: "bot-1", at: now), .idle)
            XCTAssertNil(stopped.nextTransition(after: now))
            XCTAssertEqual(stopped.statusLabel(for: "bot-1", at: now, portuguese: false), "Activity not observed")
        }
    }

    func testSidebarExpiresApprovalAndTerminalWithoutAnotherHostEvent() throws {
        let finish = now - 1_000
        let snapshot = BotSidebarActivitySnapshot(botID: "bot-1", threadID: "thread-1",
            currentTurn: try turn("completed", finishedAt: finish),
            actions: [action(.awaitingApproval, expiresAt: now + 500)], textObserved: false)
        XCTAssertEqual(snapshot.activity(for: "bot-1", at: now), .needsYou)
        XCTAssertEqual(snapshot.nextTransition(after: now), now + 500)
        XCTAssertEqual(snapshot.activity(for: "bot-1", at: now + 500), .finished)
        XCTAssertEqual(snapshot.nextTransition(after: now + 500), finish + BotMascotActivity.finishedWindow)
        XCTAssertEqual(snapshot.activity(for: "bot-1", at: finish + BotMascotActivity.finishedWindow), .idle)
        XCTAssertNil(snapshot.nextTransition(after: finish + BotMascotActivity.finishedWindow))
        let failed = BotSidebarActivitySnapshot(botID: "bot-1", threadID: "thread-1",
            currentTurn: try turn("failed", finishedAt: now), actions: [], textObserved: false)
        XCTAssertEqual(failed.activity(for: "bot-1", at: now), .error)
        XCTAssertEqual(failed.activity(for: "bot-1", at: now + BotMascotActivity.errorWindow), .idle)
        for state in ["queued", "interrupted", "unknown"] {
            let settled = BotSidebarActivitySnapshot(botID: "bot-1", threadID: "thread-1",
                currentTurn: try turn(state, finishedAt: now), actions: [], textObserved: true)
            XCTAssertEqual(settled.activity(for: "bot-1", at: now), .idle)
            XCTAssertNil(settled.nextTransition(after: now))
        }
        XCTAssertTrue(BotSidebarActivitySnapshot.terminalIsFresh(try turn("completed", finishedAt: now - 1), at: now))
        XCTAssertTrue(BotSidebarActivitySnapshot.terminalIsFresh(try turn("failed", finishedAt: now - 5_999), at: now))
        XCTAssertFalse(BotSidebarActivitySnapshot.terminalIsFresh(try turn("completed", finishedAt: now - 2_500), at: now))
        XCTAssertFalse(BotSidebarActivitySnapshot.terminalIsFresh(try turn("failed", finishedAt: now + 1), at: now))
        XCTAssertFalse(BotSidebarActivitySnapshot.terminalIsFresh(try turn("running", finishedAt: now), at: now))
    }

    func testIndicatorBudgetStopsForComfortVisibilityAndInactiveScene() {
        func fps(_ activity: BotMascotActivity = .working, motion: BotAvatarAppearance.Motion = .subtle,
                 reduceMotion: Bool = false, visible: Bool = true, active: Bool = true, lowPower: Bool = false) -> Double? {
            BotActivityIndicatorMotion.framesPerSecond(activity: activity, motion: motion, reduceMotion: reduceMotion,
                isVisible: visible, isSceneActive: active, lowPower: lowPower)
        }
        XCTAssertEqual(fps(), 12)
        XCTAssertEqual(fps(lowPower: true), 6)
        XCTAssertNil(fps(motion: .none))
        XCTAssertNil(fps(reduceMotion: true))
        XCTAssertNil(fps(visible: false))
        XCTAssertNil(fps(active: false))
        for state in [BotMascotActivity.idle, .needsYou, .error, .finished] { XCTAssertNil(fps(state)) }
        for state in [BotMascotActivity.working, .thinking, .writing, .tool, .reconnecting] { XCTAssertEqual(fps(state), 12) }
    }
}
