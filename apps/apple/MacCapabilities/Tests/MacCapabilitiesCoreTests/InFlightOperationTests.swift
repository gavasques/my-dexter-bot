import Foundation
import Testing
@testable import MacCapabilitiesCore

/// Lets the test hold lane work in progress: the work signals `entered` and blocks until `release`.
final class LaneGate: Sendable {
    let entered = DispatchSemaphore(value: 0)
    let release = DispatchSemaphore(value: 0)
    func enterAndWait() {
        entered.signal()
        release.wait()
    }
}

final class AttemptCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0
    func increment() { lock.lock(); value += 1; lock.unlock() }
    var count: Int { lock.lock(); defer { lock.unlock() }; return value }
}

/// Test-owned backend whose reads and actions run on a real `BackendLane` and block there until released,
/// like an AX call waiting on a slow app. No AppKit, AX or input.
@MainActor
final class DelayedLaneBackend: CuaBackend {
    var permissionsGranted = true
    var lockState: CuaLockState = .unlocked
    var indicatorVisible = false
    var onEvent: (@MainActor (CuaBackendEvent) -> Void)?
    let lane = BackendLane(label: "test.delayed")
    let gate = LaneGate()
    let attempts = AttemptCounter()
    private var approve: (@MainActor () -> Void)?

    func presentConsent(_ request: ConsentRequest, surfaceId: String, decide: @escaping @MainActor (CuaSurface?) -> Void) {
        approve = { decide(CuaSurface(surfaceId: surfaceId, label: "Owned", handle: 1)) }
    }
    func approveConsent() { approve?(); approve = nil }
    func cancelConsent() { approve = nil }
    func beginSession(on surface: CuaSurface, botLabel: String, shown: @escaping @MainActor (Bool) -> Void) { indicatorVisible = true; shown(true) }
    func endSession() { indicatorVisible = false; lane.invalidate() }
    func surfaceAlive(_ surface: CuaSurface) -> Bool { true }

    func observe(_ surface: CuaSurface, maxNodes: Int, authorization: CuaAuthorization,
                 completion: @escaping @MainActor (CuaObserveResult) -> Void) {
        let gate = gate
        lane.submit(skipped: .refused("session_ended"), { _ in
            if let code = authorization.refusal() { return .refused(code) }
            gate.enterAndWait()
            return .nodes([CuaNode(elementId: "el_1", role: "AXStaticText", title: "read-while-stopping", value: "", enabled: true)], truncated: false)
        }, completion: completion)
    }

    func perform(_ surface: CuaSurface, elementId: String, action: CuaAction, value: String?, authorization: CuaAuthorization,
                 completion: @escaping @MainActor (CuaPerformResult) -> Void) {
        let gate = gate, attempts = attempts
        lane.submit(skipped: .refused("session_ended"), { ticket in
            if let code = authorization.refusal() { return .refused(code) }
            guard ticket.isCurrent else { return .refused("session_ended") }
            attempts.increment()
            gate.enterAndWait()
            return .performed
        }, completion: completion)
    }
}

@MainActor
final class LaneHarness {
    let backend = DelayedLaneBackend()
    var lines: [[String: Any]] = []
    lazy var core = HelperCore(backend: backend, fixtureMode: false) { [unowned self] line in
        self.lines.append(try! JSONSerialization.jsonObject(with: Data(line.utf8)) as! [String: Any])
    }
    var nextId = 0
    let botKey = String(repeating: "a", count: 32)

    /// Sends a request; returns its id. The reply may come later.
    @discardableResult
    func send(_ message: [String: Any]) -> Int {
        nextId += 1
        var m = message
        m["v"] = cuaProtocolVersion
        m["id"] = nextId
        core.handle(line: String(decoding: try! JSONSerialization.data(withJSONObject: m), as: UTF8.self))
        return nextId
    }
    func reply(_ id: Int) -> [String: Any]? { lines.first { $0["id"] as? Int == id } }
    func events(_ name: String) -> [[String: Any]] { lines.filter { $0["event"] as? String == name } }

    func startSession() -> (String, String) {
        precondition(reply(send(["op": "request_consent", "botKey": botKey, "botLabel": "P", "maxSeconds": 60, "promptSeconds": 60]))?["ok"] as? Bool == true)
        backend.approveConsent()
        let s = events("session_started").last!["session"] as! [String: Any]
        return (s["sessionId"] as! String, s["surfaceId"] as! String)
    }

    /// The Stop button's action, delivered through the main queue like any AppKit event.
    func pressStopOnMainQueue() {
        DispatchQueue.main.async { MainActor.assumeIsolated { self.backend.onEvent?(.operatorStop) } }
    }

    /// Yields the main actor until `condition` holds (5 s bound).
    func until(_ condition: () -> Bool) async -> Bool {
        for _ in 0..<500 {
            if condition() { return true }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        return condition()
    }
}

/// Waits for a semaphore on a global queue, never on the main actor.
func signalled(_ semaphore: DispatchSemaphore) async -> Bool {
    await withCheckedContinuation { continuation in
        DispatchQueue.global().async { continuation.resume(returning: semaphore.wait(timeout: .now() + 5) == .success) }
    }
}

@MainActor
@Suite struct InFlightOperationTests {
    /// The read is still blocked on the lane when Stop arrives; Stop must be handled first and the late
    /// read must release nothing. With reads on the main actor this deadlocks: the read is only released
    /// after the Stop has been seen.
    @Test func stopDuringASlowReadIsHandledFirstAndTheReadReleasesNothing() async {
        let h = LaneHarness()
        let (sessionId, surfaceId) = h.startSession()
        let id = h.send(["op": "observe", "sessionId": sessionId, "surfaceId": surfaceId, "maxNodes": 5])
        #expect(h.reply(id) == nil, "the reply waits for the lane")
        #expect(await signalled(h.backend.gate.entered))
        h.pressStopOnMainQueue()
        #expect(await h.until { !h.events("session_ended").isEmpty })
        #expect(h.events("session_ended").last?["reason"] as? String == "operator_stop")
        #expect(h.reply(id) == nil, "Stop was handled while the read was still running")
        #expect(h.backend.lane.isBusy)
        #expect(h.reply(h.send(["op": "request_consent", "botKey": h.botKey, "botLabel": "P", "maxSeconds": 60, "promptSeconds": 60]))?["code"] as? String == "busy")

        h.backend.gate.release.signal()
        #expect(await h.until { h.reply(id) != nil })
        let reply = h.reply(id) ?? [:]
        #expect(reply["ok"] as? Bool == false)
        #expect(reply["code"] as? String == "session_ended")
        #expect(reply["effect"] as? String == "none")
        #expect(reply["nodes"] == nil)
        #expect(!h.lines.contains { "\($0)".contains("read-while-stopping") })
        #expect(h.core.hasOperationInFlight == false)
    }

    @Test func anActionHandedOffBeforeStopStaysUnknownAndIsAttemptedOnce() async {
        let h = LaneHarness()
        let (sessionId, surfaceId) = h.startSession()
        let press: [String: Any] = ["op": "control", "sessionId": sessionId, "surfaceId": surfaceId, "elementId": "el_1", "action": "press"]
        // Without a stop the same action is confirmed.
        let first = h.send(press)
        #expect(await signalled(h.backend.gate.entered))
        h.backend.gate.release.signal()
        #expect(await h.until { h.reply(first) != nil })
        #expect(h.reply(first)?["performed"] as? Bool == true)

        let second = h.send(press)
        #expect(await signalled(h.backend.gate.entered))
        let overlapping = h.reply(h.send(press)) ?? [:]
        #expect(overlapping["code"] as? String == "busy")
        #expect(overlapping["effect"] as? String == "none")
        h.pressStopOnMainQueue()
        #expect(await h.until { !h.events("session_ended").isEmpty })
        #expect(h.reply(second) == nil)
        h.backend.gate.release.signal()
        #expect(await h.until { h.reply(second) != nil })
        let reply = h.reply(second) ?? [:]
        #expect(reply["ok"] as? Bool == false)
        #expect(reply["code"] as? String == "action_unconfirmed")
        #expect(reply["effect"] as? String == "unknown", "a success reported after Stop is not promoted")
        #expect(reply["performed"] == nil)
        #expect(h.backend.attempts.count == 2, "one attempt per accepted request, no retry")
    }

    @Test func workQueuedForAnEndedSessionNeverStarts() async {
        let lane = BackendLane(label: "test.queue")
        let gate = LaneGate(), ran = AttemptCounter()
        let h = LaneHarness()
        lane.submit(skipped: "skipped", { _ in gate.enterAndWait(); return "first" }, completion: { h.lines.append(["result": $0]) })
        lane.submit(skipped: "skipped", { _ in ran.increment(); return "second" }, completion: { h.lines.append(["result": $0]) })
        #expect(await signalled(gate.entered))
        lane.invalidate()
        gate.release.signal()
        #expect(await h.until { h.lines.count == 2 })
        #expect(h.lines.compactMap { $0["result"] as? String } == ["first", "skipped"])
        #expect(ran.count == 0)
        #expect(lane.isBusy == false)
    }

    @Test func shutdownEndsTheSessionButCompletesOnlyAfterHandedOffWorkDrains() async {
        let h = LaneHarness()
        let (sessionId, surfaceId) = h.startSession()
        let id = h.send(["op": "observe", "sessionId": sessionId, "surfaceId": surfaceId, "maxNodes": 5])
        #expect(await signalled(h.backend.gate.entered))
        var drained = false
        h.core.shutdown { drained = true; h.lines.append(["drained": true]) }
        #expect(h.events("session_ended").last?["reason"] as? String == "daemon")
        try? await Task.sleep(nanoseconds: 100_000_000)
        #expect(drained == false, "shutdown does not complete while the lane holds accepted work")
        h.backend.gate.release.signal()
        #expect(await h.until { drained })
        let replyIndex = h.lines.firstIndex { $0["id"] as? Int == id }
        let drainedIndex = h.lines.firstIndex { $0["drained"] != nil }
        #expect(replyIndex != nil && drainedIndex != nil && replyIndex! < drainedIndex!)
        #expect(h.backend.lane.isBusy == false)
    }
}
