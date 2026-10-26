import DexterHostClient
import XCTest
@testable import DexterAppCore

final class BotMascotMotionTests: XCTestCase {
    private let now: Int64 = 1_800_000_000_000

    // MARK: Host facts → activity

    func testActivityFollowsOnlyReportedHostFacts() {
        func derive(_ facts: BotMascotHostFacts) -> BotMascotActivity { BotMascotActivity.derive(facts) }
        XCTAssertEqual(derive(.init(now: now)), .idle)
        XCTAssertEqual(derive(.init(turnState: .queued, now: now)), .idle)
        XCTAssertEqual(derive(.init(turnState: .running, latestEvent: .turnStarted, now: now)), .working)
        XCTAssertEqual(derive(.init(turnState: .running, now: now)), .working)
        XCTAssertEqual(derive(.init(turnState: .running, latestEvent: .textDelta, now: now)), .writing)
        XCTAssertEqual(derive(.init(turnState: .running, latestEvent: .toolRequested, hasUnresolvedToolRequest: true, now: now)), .tool)
        XCTAssertEqual(derive(.init(turnState: .running, latestEvent: .toolResolved, now: now)), .working)
        XCTAssertEqual(derive(.init(turnState: .completed, finishedAt: now - 1_000, now: now)), .finished)
        XCTAssertEqual(derive(.init(turnState: .completed, finishedAt: now - 2_500, now: now)), .idle)
        XCTAssertEqual(derive(.init(turnState: .completed, finishedAt: nil, now: now)), .idle)
        XCTAssertEqual(derive(.init(turnState: .completed, finishedAt: now + 5_000, now: now)), .idle, "clock skew claims nothing")
        XCTAssertEqual(derive(.init(turnState: .failed, finishedAt: now - 5_999, now: now)), .error)
        XCTAssertEqual(derive(.init(turnState: .failed, finishedAt: now - 6_000, now: now)), .idle)
        XCTAssertEqual(derive(.init(turnState: .interrupted, finishedAt: now, now: now)), .idle)
        XCTAssertEqual(derive(.init(turnState: .unknown, finishedAt: now, now: now)), .idle)
        XCTAssertEqual(derive(.init(connection: .reconnecting, turnState: .running, latestEvent: .textDelta, now: now)), .reconnecting)
        XCTAssertEqual(derive(.init(connection: .unavailable, turnState: .running, now: now)), .idle)
        // Waiting for the owner beats everything else, even a reconnect.
        XCTAssertEqual(derive(.init(connection: .reconnecting, turnState: .running, awaitingApproval: true, now: now)), .needsYou)
        XCTAssertEqual(derive(.init(turnState: .running, latestEvent: .textDelta, hasUnresolvedToolRequest: true, awaitingApproval: true, now: now)), .needsYou)
    }

    func testThinkingIsNeverInferred() {
        let states: [TurnState?] = [nil, .queued, .running, .completed, .interrupted, .failed, .unknown]
        let events: [TurnEventKind?] = [nil, .turnQueued, .turnStarted, .textDelta, .toolRequested, .toolResolved, .turnCompleted, .turnInterrupted, .turnFailed, .turnUnknown]
        var produced = Set<BotMascotActivity>()
        for connection in [BotMascotHostFacts.Connection.connected, .reconnecting, .unavailable] {
            for state in states {
                for event in events {
                    for tool in [false, true] {
                        for approval in [false, true] {
                            for finishedAt in [nil, now, now - 3_000, now - 10_000] as [Int64?] {
                                produced.insert(.derive(.init(connection: connection, turnState: state, latestEvent: event, hasUnresolvedToolRequest: tool,
                                                              awaitingApproval: approval, finishedAt: finishedAt, now: now)))
                            }
                        }
                    }
                }
            }
        }
        XCTAssertFalse(produced.contains(.thinking))
        XCTAssertEqual(produced, BotMascotActivity.derivable)
    }

    func testFactsComeFromTheTurnsOwnEventsInCursorOrder() throws {
        let turn = try decodeTurn(id: "turn-a", state: "running")
        let events = try [event(4, "turn-a", "tool.resolved"), event(2, "turn-a", "tool.requested"), event(3, "turn-b", "tool.requested"),
                          event(5, "turn-a", "tool.requested"), event(1, "turn-a", "turn.started")]
        let facts = BotMascotHostFacts(turn: turn, events: events, awaitingApproval: false, now: now)
        XCTAssertEqual(facts.latestEvent, .toolRequested)
        XCTAssertTrue(facts.hasUnresolvedToolRequest)
        XCTAssertEqual(BotMascotActivity.derive(facts), .tool)
        let resolved = BotMascotHostFacts(turn: turn, events: events + [try event(6, "turn-a", "tool.resolved"), try event(7, "turn-a", "text.delta")],
                                          awaitingApproval: false, now: now)
        XCTAssertFalse(resolved.hasUnresolvedToolRequest)
        XCTAssertEqual(BotMascotActivity.derive(resolved), .writing)
        XCTAssertEqual(BotMascotActivity.derive(BotMascotHostFacts(turn: nil, events: events, awaitingApproval: false, now: now)), .idle)
    }

    // MARK: Budget

    func testAnimationBudgetRespectsComfortAndCost() {
        func level(_ motion: BotAvatarAppearance.Motion = .lively, side: Double = 128, reduce: Bool = false, visible: Bool = true,
                   active: Bool = true, lowPower: Bool = false) -> BotMascotAnimationLevel {
            .resolve(motion: motion, side: side, reduceMotion: reduce, isVisible: visible, isSceneActive: active, lowPower: lowPower)
        }
        XCTAssertEqual(level(reduce: true), .still)
        XCTAssertEqual(level(.none), .still)
        XCTAssertEqual(level(visible: false), .still)
        XCTAssertEqual(level(active: false), .still)
        XCTAssertEqual(level(side: 16), .still)
        XCTAssertEqual(level(side: 19.9), .still)
        XCTAssertEqual(level(side: 20), .blinkOnly)
        XCTAssertEqual(level(.subtle, side: 32), .blinkOnly)
        XCTAssertEqual(level(.subtle, side: 40), .full(amplitude: 0.55, framesPerSecond: 24))
        XCTAssertEqual(level(.lively, side: 40), .full(amplitude: 1, framesPerSecond: 30))
        XCTAssertEqual(level(.lively, lowPower: true), .full(amplitude: 1, framesPerSecond: 15))
        XCTAssertEqual(level(.subtle, lowPower: true), .full(amplitude: 0.55, framesPerSecond: 15))
        XCTAssertFalse(BotMascotAnimationLevel.still.isAnimated)
    }

    // MARK: Poses

    func testStillPosesCarryTheStateWithoutMotion() {
        let expected: [BotMascotActivity: BotMascotPose.Accessory] = [
            .idle: .none, .working: .none, .thinking: .thinkingDots, .tool: .gear, .needsYou: .attention,
            .writing: .typingDots, .reconnecting: .reconnecting, .error: .failure, .finished: .sparkle,
        ]
        for activity in BotMascotActivity.allCases {
            let pose = BotMascotPose.still(activity)
            XCTAssertEqual(pose.accessory, expected[activity], activity.rawValue)
            XCTAssertEqual(pose.bodyScaleX, 1); XCTAssertEqual(pose.bodyScaleY, 1)
            XCTAssertEqual(pose.bodyOffsetX, 0); XCTAssertEqual(pose.bodyOffsetY, 0); XCTAssertEqual(pose.tiltDegrees, 0)
            XCTAssertEqual(pose.eyeOpen, 1)
            for time in stride(from: 0.0, to: 30, by: 0.37) {
                XCTAssertEqual(BotMascotPose.resolve(activity, level: .still, time: time, elapsed: time), pose)
            }
        }
        XCTAssertEqual(BotMascotPose.still(.finished).expression, .happy)
        XCTAssertEqual(BotMascotPose.still(.error).expression, .worried)
        XCTAssertEqual(BotMascotPose.still(.needsYou).expression, .wide)
        XCTAssertEqual(BotMascotPose.still(.idle).expression, .neutral)
    }

    func testAnimatedPosesStayGentleAndBounded() {
        let lively = BotMascotAnimationLevel.full(amplitude: 1, framesPerSecond: 30)
        for activity in BotMascotActivity.allCases {
            for time in stride(from: 0.0, to: 24, by: 0.033) {
                let pose = BotMascotPose.resolve(activity, level: lively, time: time, elapsed: time, seed: 99)
                let context = "\(activity.rawValue) t=\(time)"
                XCTAssertLessThanOrEqual(abs(pose.bodyOffsetX), 0.031, context)
                XCTAssertLessThanOrEqual(abs(pose.bodyOffsetY), 0.061, context)
                XCTAssertTrue((0.97...1.035).contains(pose.bodyScaleX), context)
                XCTAssertTrue((0.97...1.035).contains(pose.bodyScaleY), context)
                XCTAssertLessThanOrEqual(abs(pose.tiltDegrees), 3.01, context)
                XCTAssertTrue((0...1).contains(pose.eyeOpen), context)
                XCTAssertLessThanOrEqual(abs(pose.eyeOffsetX), 0.05, context)
                XCTAssertLessThanOrEqual(abs(pose.eyeOffsetY), 0.05, context)
                XCTAssertTrue((0...1).contains(pose.accessoryPhase), context)
                XCTAssertTrue((0...1).contains(pose.accessoryOpacity), context)
                XCTAssertEqual(pose.accessory, BotMascotPose.still(activity).accessory, context)
            }
        }
    }

    func testSubtleMovesLessThanLively() {
        func peak(_ level: BotMascotAnimationLevel) -> Double {
            stride(from: 0.0, to: 10, by: 0.02).map { abs(BotMascotPose.resolve(.idle, level: level, time: $0, elapsed: $0).bodyScaleY - 1) }.max()!
        }
        let subtle = peak(.full(amplitude: 0.55, framesPerSecond: 24)), lively = peak(.full(amplitude: 1, framesPerSecond: 30))
        XCTAssertGreaterThan(subtle, 0)
        XCTAssertLessThan(subtle, lively)
    }

    func testOneShotsEndAndNothingAlarmsInALoop() {
        let level = BotMascotAnimationLevel.full(amplitude: 1, framesPerSecond: 30)
        XCTAssertNotEqual(BotMascotPose.resolve(.error, level: level, time: 100.1, elapsed: 0.1).bodyOffsetX, 0)
        for elapsed in stride(from: 0.5, to: 30, by: 0.1) {
            XCTAssertEqual(BotMascotPose.resolve(.error, level: level, time: 100 + elapsed, elapsed: elapsed).bodyOffsetX, 0)
            XCTAssertEqual(BotMascotPose.resolve(.error, level: level, time: 100 + elapsed, elapsed: elapsed).bodyScaleY, 1)
        }
        XCTAssertLessThan(BotMascotPose.resolve(.finished, level: level, time: 0.3, elapsed: 0.3).bodyOffsetY, -0.05)
        for elapsed in stride(from: 0.6, to: 10, by: 0.1) {
            XCTAssertEqual(BotMascotPose.resolve(.finished, level: level, time: elapsed, elapsed: elapsed).bodyOffsetY, 0)
        }
        XCTAssertEqual(BotMascotPose.resolve(.finished, level: level, time: 2.1, elapsed: 2.1).accessoryOpacity, 0)
        XCTAssertEqual(BotMascotPose.resolve(.finished, level: level, time: 1, elapsed: 1).accessoryPhase, 1)
        // Happy closed eyes never blink.
        for time in stride(from: 0.0, to: 20, by: 0.01) {
            XCTAssertEqual(BotMascotPose.resolve(.finished, level: level, time: time, elapsed: 3).eyeOpen, 1)
        }
    }

    func testBlinkOnlyChangesNothingButTheEyelids() {
        var blinked = false
        for time in stride(from: 0.0, to: 12, by: 0.01) {
            var pose = BotMascotPose.resolve(.writing, level: .blinkOnly, time: time, elapsed: time, seed: 5)
            if pose.eyeOpen < 1 { blinked = true }
            pose.eyeOpen = 1
            XCTAssertEqual(pose, .still(.writing))
        }
        XCTAssertTrue(blinked)
    }

    func testBlinkScheduleIsSparseAndSpreadAcrossAvatars() {
        let seed = BotMascotBlink.seed("bot-1")
        XCTAssertEqual(seed, BotMascotBlink.seed("bot-1"))
        XCTAssertNotEqual(seed, BotMascotBlink.seed("bot-2"))
        var time = 1_000.0
        for _ in 0..<20 {
            let start = BotMascotBlink.nextStart(after: time, seed: seed)
            XCTAssertGreaterThanOrEqual(start, time - 1e-9)
            XCTAssertLessThanOrEqual(start - time, BotMascotBlink.period(seed: seed) + 1e-9)
            XCTAssertLessThan(BotMascotBlink.openness(at: start + BotMascotBlink.duration / 2, seed: seed), 0.05)
            XCTAssertEqual(BotMascotBlink.openness(at: start + BotMascotBlink.duration + 0.01, seed: seed), 1)
            let frames = BotMascotBlink.frames(startingAt: start)
            XCTAssertEqual(frames, frames.sorted())
            XCTAssertEqual(BotMascotBlink.openness(at: frames.last!, seed: seed), 1)
            time = start + 0.5
        }
        // Eyes are open most of the time: at most ~5% of a period is a blink.
        let samples = stride(from: 0.0, to: 60, by: 0.01).map { BotMascotBlink.openness(at: $0, seed: seed) }
        XCTAssertLessThan(Double(samples.filter { $0 < 1 }.count) / Double(samples.count), 0.05)
        let periods = Set((0..<40).map { BotMascotBlink.period(seed: BotMascotBlink.seed("bot-\($0)")) })
        XCTAssertGreaterThan(periods.count, 5)
    }

    // MARK: Fixtures

    private func decodeTurn(id: String, state: String) throws -> Turn {
        let json = """
        {"cursor":1,"id":"\(id)","threadId":"thread-1","botId":"bot-1","engine":"claude","clientRequestId":"req-1",
         "inputMessageId":"msg-1","state":"\(state)","outputChars":0,"outputTruncated":false,"createdAt":1,"updatedAt":1}
        """
        return try JSONDecoder().decode(Turn.self, from: Data(json.utf8))
    }

    private func event(_ cursor: Int64, _ turnID: String, _ kind: String) throws -> TurnEvent {
        let json = #"{"cursor":\#(cursor),"turnId":"\#(turnID)","threadId":"thread-1","kind":"\#(kind)","createdAt":\#(cursor)}"#
        return try JSONDecoder().decode(TurnEvent.self, from: Data(json.utf8))
    }
}
