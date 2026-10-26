import Foundation
import XCTest
@testable import DexterAppCore

/// Synthetic geometry only: no view, host, account or GUI. Times are binary-exact so deadlines compare exactly.
final class ChatScrollFollowPolicyTests: XCTestCase {
    private let scopeA = ChatScrollScope(host: "https://127.0.0.1:1", hostScope: UUID(), conversation: "thread-a", generation: 1)
    private var scopeB: ChatScrollScope { ChatScrollScope(host: scopeA.host, hostScope: scopeA.hostScope, conversation: "thread-b", generation: 2) }
    private var tuning: ChatScrollFollowPolicy.Tuning {
        var tuning = ChatScrollFollowPolicy.Tuning()
        tuning.throttle = 0.125; tuning.humanGrace = 0.375; tuning.initialSettle = 0.375
        return tuning
    }

    private func metrics(offset: Double, content: Double = 2_000, viewport: Double = 500) -> ChatScrollMetrics {
        ChatScrollMetrics(offset: offset, contentHeight: content, viewportHeight: viewport)
    }

    /// Opened and positioned at the end of a 2000pt transcript in a 500pt viewport (max offset 1500).
    private func positioned() -> ChatScrollFollowPolicy {
        var policy = ChatScrollFollowPolicy(tuning: tuning)
        policy.sync(scope: scopeA)
        _ = policy.geometryChanged(metrics(offset: 0), now: 0)
        XCTAssertEqual(policy.contentChanged(hasContent: true, paused: false, now: 0), 0)
        XCTAssertEqual(policy.fire(now: 0, currentScope: scopeA, paused: false, reduceMotion: false), .move(.init(animated: false)))
        _ = policy.geometryChanged(metrics(offset: 1_500), now: 0.0625)
        return policy
    }

    func testReturningToEndDuringStreamingWithoutGesturePhaseResumesFollowing() {
        var policy = positioned()
        _ = policy.geometryChanged(metrics(offset: 1_415), now: 1)
        XCTAssertEqual(policy.mode, .reading)
        _ = policy.geometryChanged(metrics(offset: 1_455, content: 2_030), now: 2)
        XCTAssertEqual(policy.mode, .following, "human moves down 40pt while content grows 30pt")
        XCTAssertNotNil(policy.contentChanged(hasContent: true, paused: false, now: 3))
    }

    func testHumanMovementDuringBlockedInitialPositionWins() {
        var policy = ChatScrollFollowPolicy(tuning: tuning)
        policy.sync(scope: scopeA)
        _ = policy.geometryChanged(metrics(offset: 0), now: 0)
        _ = policy.contentChanged(hasContent: true, paused: true, now: 0)
        XCTAssertEqual(policy.fire(now: 0, currentScope: scopeA, paused: true, reduceMotion: false), .none)
        _ = policy.geometryChanged(metrics(offset: 200), now: 1)
        XCTAssertTrue(policy.initialPositionApplied)
        XCTAssertEqual(policy.mode, .reading)
        XCTAssertNil(policy.contentChanged(hasContent: true, paused: false, now: 2), "closing approval never overrides reading")
    }

    func testDefaultTuningMatchesTheAgreedBounds() {
        let tuning = ChatScrollFollowPolicy.Tuning()
        XCTAssertEqual(tuning.nearBottom, 80)
        XCTAssertTrue((0.08...0.12).contains(tuning.throttle))
        XCTAssertLessThanOrEqual(tuning.humanGrace, 0.5)
    }

    func testInitialLoadPositionsOnceWithoutAnimation() {
        var policy = ChatScrollFollowPolicy(tuning: tuning)
        policy.sync(scope: scopeA)
        XCTAssertNil(policy.contentChanged(hasContent: false, paused: false, now: 0), "nothing to position while empty or loading")
        XCTAssertEqual(policy.contentChanged(hasContent: true, paused: false, now: 1), 1)
        XCTAssertNil(policy.contentChanged(hasContent: true, paused: false, now: 1), "same tick is coalesced")
        XCTAssertEqual(policy.fire(now: 1, currentScope: scopeA, paused: false, reduceMotion: false), .move(.init(animated: false)))
        XCTAssertTrue(policy.initialPositionApplied)
        XCTAssertEqual(policy.fire(now: 1.0625, currentScope: scopeA, paused: false, reduceMotion: false), .none, "fires once")
        // Lazy rows settle right after opening: the follow-up is not animated through the history.
        _ = policy.geometryChanged(metrics(offset: 1_500), now: 1.0625)
        XCTAssertEqual(policy.geometryChanged(metrics(offset: 1_500, content: 2_300), now: 1.125), 1.25)
        XCTAssertEqual(policy.fire(now: 1.25, currentScope: scopeA, paused: false, reduceMotion: false), .move(.init(animated: false)))
    }

    func testGestureBeforeFirstPositionKeepsThePersonsChoice() {
        var policy = ChatScrollFollowPolicy(tuning: tuning)
        policy.sync(scope: scopeA)
        XCTAssertNotNil(policy.contentChanged(hasContent: true, paused: false, now: 0))
        XCTAssertNil(policy.phaseChanged(.tracking, now: 0.015625))
        XCTAssertNil(policy.pendingDeadline)
        XCTAssertTrue(policy.initialPositionApplied)
        XCTAssertEqual(policy.fire(now: 0.03125, currentScope: scopeA, paused: false, reduceMotion: false), .none)
    }

    func testReadingUpStopsFollowingAndNewContentDoesNotPull() {
        var policy = positioned()
        // Wheel/trackpad/scrollbar/keyboard up with stable content: inferred without a phase (macOS 14 / iOS 17 path).
        XCTAssertNil(policy.geometryChanged(metrics(offset: 1_300), now: 1))
        XCTAssertEqual(policy.mode, .reading)
        XCTAssertTrue(policy.showsLatestButton)
        // Streaming, new message, finalization, canonical reload, preview ack: none move the transcript.
        for step in 0..<20 {
            XCTAssertNil(policy.contentChanged(hasContent: true, paused: false, now: 2 + Double(step) * 0.0625))
        }
        XCTAssertNil(policy.geometryChanged(metrics(offset: 1_300, content: 2_600), now: 4), "growth below keeps the reading position")
        XCTAssertNil(policy.pendingDeadline)
        XCTAssertEqual(policy.fire(now: 5, currentScope: scopeA, paused: false, reduceMotion: false), .none)
    }

    func testSmallMovementNearTheEndDefersFollowInsteadOfPullingBack() {
        var policy = positioned()
        XCTAssertNil(policy.geometryChanged(metrics(offset: 1_460), now: 1))
        XCTAssertEqual(policy.mode, .following, "40pt from the end is still the end")
        XCTAssertEqual(policy.contentChanged(hasContent: true, paused: false, now: 1.0625), 1.1875)
        XCTAssertNil(policy.geometryChanged(metrics(offset: 1_460, content: 2_050), now: 1.125), "coalesced into the pending request")
        XCTAssertEqual(policy.fire(now: 1.1875, currentScope: scopeA, paused: false, reduceMotion: false), .retry(at: 1.375))
        XCTAssertEqual(policy.fire(now: 1.375, currentScope: scopeA, paused: false, reduceMotion: false), .move(.init(animated: true)))
    }

    func testExplicitLatestResumesFollowing() {
        var policy = positioned()
        _ = policy.geometryChanged(metrics(offset: 200), now: 1)
        XCTAssertEqual(policy.mode, .reading)
        XCTAssertEqual(policy.requestLatest(now: 2, bypassesPause: true), 2)
        XCTAssertEqual(policy.mode, .following)
        // 1300pt away in a 500pt viewport: jump without an animation that travels through history.
        XCTAssertEqual(policy.fire(now: 2, currentScope: scopeA, paused: true, reduceMotion: false), .move(.init(animated: false)))
        _ = policy.geometryChanged(metrics(offset: 1_500), now: 2.125)
        XCTAssertFalse(policy.showsLatestButton)
        XCTAssertEqual(policy.contentChanged(hasContent: true, paused: false, now: 3), 3.125, "follows again")
    }

    func testHumanSendForcesFollowButRespectsApprovalReviewPause() {
        var policy = positioned()
        _ = policy.geometryChanged(metrics(offset: 1_200), now: 1)
        XCTAssertEqual(policy.mode, .reading)
        XCTAssertEqual(policy.requestLatest(now: 2, bypassesPause: false), 2)
        XCTAssertEqual(policy.fire(now: 2, currentScope: scopeA, paused: true, reduceMotion: false), .none, "approval review keeps its place")
        XCTAssertEqual(policy.mode, .following)
        XCTAssertEqual(policy.requestLatest(now: 3, bypassesPause: false), 3)
        // Geometry says "already at the end" but may be stale right after a send: an explicit request still runs.
        _ = policy.geometryChanged(metrics(offset: 1_500), now: 3)
        XCTAssertEqual(policy.fire(now: 3, currentScope: scopeA, paused: false, reduceMotion: false), .move(.init(animated: true)))
    }

    func testApprovalReviewPauseBlocksUpdates() {
        var policy = positioned()
        XCTAssertNil(policy.contentChanged(hasContent: true, paused: true, now: 1))
        XCTAssertEqual(policy.contentChanged(hasContent: true, paused: false, now: 2), 2.125)
        _ = policy.geometryChanged(metrics(offset: 1_500, content: 2_100), now: 2.0625)
        XCTAssertEqual(policy.fire(now: 2.125, currentScope: scopeA, paused: true, reduceMotion: false), .none, "pause is re-checked at fire time")
        XCTAssertNil(policy.pendingDeadline)
    }

    func testScopeChangeInvalidatesPendingAndState() {
        var policy = positioned()
        _ = policy.geometryChanged(metrics(offset: 100), now: 1)
        XCTAssertNotNil(policy.requestLatest(now: 2, bypassesPause: true))
        XCTAssertEqual(policy.fire(now: 2, currentScope: scopeB, paused: false, reduceMotion: false), .none, "a deferred effect of another scope is dropped")
        XCTAssertNil(policy.pendingDeadline)
        XCTAssertFalse(policy.sync(scope: scopeA))
        XCTAssertTrue(policy.sync(scope: scopeB))
        XCTAssertEqual(policy.mode, .following)
        XCTAssertFalse(policy.initialPositionApplied)
        XCTAssertNil(policy.metrics)
        XCTAssertNil(policy.pendingDeadline)
        policy.reset()
        XCTAssertNil(policy.scope)
    }

    func testProgrammaticAnimationIsNotAHumanPhase() {
        var policy = positioned()
        XCTAssertEqual(policy.contentChanged(hasContent: true, paused: false, now: 1), 1.125)
        XCTAssertNil(policy.phaseChanged(.animating, now: 1.0625))
        XCTAssertFalse(policy.isUserInteracting)
        XCTAssertNotNil(policy.pendingDeadline, "own animation does not cancel following")
        _ = policy.geometryChanged(metrics(offset: 1_500, content: 2_040), now: 1.078125)
        XCTAssertEqual(policy.fire(now: 1.125, currentScope: scopeA, paused: false, reduceMotion: false), .move(.init(animated: true)))
        XCTAssertNil(policy.phaseChanged(.idle, now: 1.25))
        XCTAssertEqual(policy.mode, .following)
    }

    func testHumanPhaseCancelsPendingAndDecidesModeWhenItEnds() {
        var policy = positioned()
        XCTAssertNotNil(policy.contentChanged(hasContent: true, paused: false, now: 1))
        XCTAssertNil(policy.phaseChanged(.interacting, now: 1.03125))
        XCTAssertNil(policy.pendingDeadline)
        XCTAssertNil(policy.contentChanged(hasContent: true, paused: false, now: 1.046875), "no programmatic scroll during a gesture")
        _ = policy.geometryChanged(metrics(offset: 900, content: 2_100), now: 1.125)
        XCTAssertNil(policy.phaseChanged(.decelerating, now: 1.25), "native inertia is never intercepted")
        XCTAssertEqual(policy.fire(now: 1.25, currentScope: scopeA, paused: false, reduceMotion: false), .none)
        XCTAssertNil(policy.phaseChanged(.idle, now: 1.5))
        XCTAssertEqual(policy.mode, .reading)
        // Back to within 80pt by a gesture: following resumes and catches up once when the gesture ends.
        _ = policy.phaseChanged(.tracking, now: 2)
        _ = policy.geometryChanged(metrics(offset: 1_550, content: 2_100), now: 2.125)
        XCTAssertEqual(policy.mode, .following)
        XCTAssertEqual(policy.phaseChanged(.idle, now: 2.25), 2.375)
    }

    func testReturningToTheEndWithoutPhaseResumesFollowing() {
        var policy = positioned()
        _ = policy.geometryChanged(metrics(offset: 800), now: 1)
        XCTAssertEqual(policy.mode, .reading)
        _ = policy.geometryChanged(metrics(offset: 1_300), now: 2)
        XCTAssertEqual(policy.mode, .reading, "still 200pt away")
        _ = policy.geometryChanged(metrics(offset: 1_470), now: 3)
        XCTAssertEqual(policy.mode, .following)
    }

    func testForwardPaginationKeepsReading() {
        var policy = positioned()
        policy.preserveReadingPosition()
        XCTAssertEqual(policy.mode, .reading)
        // The next page lands below "Mostrar mais": the last id changes and content grows.
        XCTAssertNil(policy.contentChanged(hasContent: true, paused: false, now: 1))
        XCTAssertNil(policy.geometryChanged(metrics(offset: 1_500, content: 3_200), now: 1.125))
        XCTAssertNil(policy.pendingDeadline)
        XCTAssertTrue(policy.showsLatestButton)
        // A human send afterwards still reaches the end of the loaded page.
        XCTAssertEqual(policy.requestLatest(now: 2, bypassesPause: false), 2)
        XCTAssertEqual(policy.fire(now: 2, currentScope: scopeA, paused: false, reduceMotion: false), .move(.init(animated: false)))
    }

    func testThrottleCoalescesAStreamWithoutPostponingIt() {
        var policy = positioned()
        XCTAssertEqual(policy.contentChanged(hasContent: true, paused: false, now: 1), 1.125)
        // A continuous stream every 16ms must not re-arm (a debounce would never fire while tokens arrive).
        for step in 1..<7 { XCTAssertNil(policy.contentChanged(hasContent: true, paused: false, now: 1 + Double(step) * 0.015625)) }
        XCTAssertEqual(policy.pendingDeadline, 1.125)
        _ = policy.geometryChanged(metrics(offset: 1_500, content: 2_080), now: 1.09375)
        XCTAssertEqual(policy.fire(now: 1.125, currentScope: scopeA, paused: false, reduceMotion: false), .move(.init(animated: true)))
        XCTAssertEqual(policy.contentChanged(hasContent: true, paused: false, now: 1.140625), 1.265625, "next window")
        // An explicit request moves the deadline earlier, never later.
        XCTAssertEqual(policy.requestLatest(now: 1.15625, bypassesPause: false), 1.15625)
        XCTAssertNil(policy.contentChanged(hasContent: true, paused: false, now: 1.171875))
    }

    func testRichContentGrowthFollowsOnlyWhileFollowing() {
        var following = positioned()
        XCTAssertEqual(following.geometryChanged(metrics(offset: 1_500, content: 2_400), now: 1), 1.125, "image/table/card height")
        XCTAssertNil(following.geometryChanged(metrics(offset: 1_500, content: 2_450), now: 1.0625), "coalesced")
        XCTAssertEqual(following.mode, .following, "growth alone never means the person left")
        XCTAssertEqual(following.fire(now: 1.125, currentScope: scopeA, paused: false, reduceMotion: false), .move(.init(animated: true)))

        var reading = positioned()
        _ = reading.geometryChanged(metrics(offset: 600), now: 1)
        XCTAssertNil(reading.geometryChanged(metrics(offset: 600, content: 2_600), now: 2))
        XCTAssertEqual(reading.mode, .reading)
    }

    func testOverscrollBounceClampAndResizeAreNotReading() {
        var policy = positioned()
        _ = policy.geometryChanged(metrics(offset: 1_540), now: 1)
        XCTAssertNil(policy.geometryChanged(metrics(offset: 1_500), now: 1.125), "bounce back from overscroll")
        XCTAssertEqual(policy.mode, .following)
        XCTAssertNil(policy.geometryChanged(metrics(offset: 1_300, content: 1_800), now: 2), "content shrank and the offset clamped to the end")
        XCTAssertEqual(policy.mode, .following)
        XCTAssertEqual(policy.contentChanged(hasContent: true, paused: false, now: 2.0625), 2.1875)
        XCTAssertEqual(policy.fire(now: 2.1875, currentScope: scopeA, paused: false, reduceMotion: false), .none, "no grace after a clamp; already at the end")
        XCTAssertEqual(policy.geometryChanged(metrics(offset: 1_300, content: 1_800, viewport: 420), now: 3), 3.125, "viewport shrink keeps the end visible")
        XCTAssertEqual(policy.mode, .following)
    }

    func testReduceMotionRemovesProgrammaticAnimation() {
        var policy = positioned()
        XCTAssertNotNil(policy.contentChanged(hasContent: true, paused: false, now: 1))
        _ = policy.geometryChanged(metrics(offset: 1_500, content: 2_060), now: 1.0625)
        XCTAssertEqual(policy.fire(now: 1.125, currentScope: scopeA, paused: false, reduceMotion: true), .move(.init(animated: false)))
    }

    func testUpdateAlreadyAtTheEndDoesNothing() {
        var policy = positioned()
        XCTAssertNotNil(policy.contentChanged(hasContent: true, paused: false, now: 1))
        XCTAssertEqual(policy.fire(now: 1.125, currentScope: scopeA, paused: false, reduceMotion: false), .none)
    }
}
