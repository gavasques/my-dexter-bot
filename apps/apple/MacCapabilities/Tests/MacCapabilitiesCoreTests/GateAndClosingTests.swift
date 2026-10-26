import Foundation
import Testing
@testable import MacCapabilitiesCore

/// Test-owned backend whose lane work blocks until released, asking its authorization either before or
/// after the block. Gates change silently (no backend event), like a native signal seen only by polling.
/// No AppKit, AX or input.
@MainActor
final class GatedLaneBackend: CuaBackend {
    var permissionsGranted = true
    var lockState: CuaLockState = .unlocked
    var indicatorVisible = false
    var alive = true
    var onEvent: (@MainActor (CuaBackendEvent) -> Void)?
    let lane = BackendLane(label: "test.gated")
    let gate = LaneGate()
    let attempts = AttemptCounter()
    let reads = AttemptCounter()
    /// true: block first, then authorize (a gate closes before the effect). false: authorize, then block
    /// (a gate closes after the hand-off).
    var authorizeAfterBlock = true
    /// Kept after the prompt is withdrawn, so a test can deliver a late decision.
    private(set) var decide: (@MainActor (CuaSurface?) -> Void)?
    private var surfaceId = ""

    func presentConsent(_ request: ConsentRequest, surfaceId: String, decide: @escaping @MainActor (CuaSurface?) -> Void) {
        self.decide = decide
        self.surfaceId = surfaceId
    }
    func approve() { decide?(CuaSurface(surfaceId: surfaceId, label: "Owned", handle: 1)) }
    func cancelConsent() {}
    func beginSession(on surface: CuaSurface, botLabel: String, shown: @escaping @MainActor (Bool) -> Void) { indicatorVisible = true; shown(true) }
    func endSession() { indicatorVisible = false; lane.invalidate() }
    func surfaceAlive(_ surface: CuaSurface) -> Bool { alive }

    func observe(_ surface: CuaSurface, maxNodes: Int, authorization: CuaAuthorization,
                 completion: @escaping @MainActor (CuaObserveResult) -> Void) {
        let gate = gate, reads = reads, afterBlock = authorizeAfterBlock
        lane.submit(skipped: .refused("session_ended"), { _ in
            if !afterBlock, let code = authorization.refusal() { return .refused(code) }
            gate.enterAndWait()
            if afterBlock, let code = authorization.refusal() { return .refused(code) }
            reads.increment()
            return .nodes([CuaNode(elementId: "el_1", role: "AXStaticText", title: "withheld", value: "", enabled: true)], truncated: false)
        }, completion: completion)
    }

    func perform(_ surface: CuaSurface, elementId: String, action: CuaAction, value: String?, authorization: CuaAuthorization,
                 completion: @escaping @MainActor (CuaPerformResult) -> Void) {
        let gate = gate, attempts = attempts, afterBlock = authorizeAfterBlock
        lane.submit(skipped: .refused("session_ended"), { _ in
            if !afterBlock, let code = authorization.refusal() { return .refused(code) }
            gate.enterAndWait()
            if afterBlock, let code = authorization.refusal() { return .refused(code) }
            attempts.increment()
            return .performed
        }, completion: completion)
    }
}

@MainActor
final class GatedHarness {
    let backend = GatedLaneBackend()
    var now = Date(timeIntervalSince1970: 2_000_000)
    var lines: [[String: Any]] = []
    /// Runs inside `output`, after the line is recorded: lets a test re-enter the core while it writes.
    var onLine: ((_ line: [String: Any]) -> Void)?
    lazy var core = HelperCore(backend: backend, fixtureMode: false, clock: { [unowned self] in self.now }) { [unowned self] line in
        let object = try! JSONSerialization.jsonObject(with: Data(line.utf8)) as! [String: Any]
        self.lines.append(object)
        self.onLine?(object)
    }
    var nextId = 0
    let botKey = String(repeating: "c", count: 32)

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
    func index(_ predicate: ([String: Any]) -> Bool) -> Int? { lines.firstIndex(where: predicate) }
    func requestConsent() -> Int {
        send(["op": "request_consent", "botKey": botKey, "botLabel": "P", "maxSeconds": 60, "promptSeconds": 60])
    }
    func startSession() -> [String: Any] {
        precondition(reply(requestConsent())?["ok"] as? Bool == true)
        backend.approve()
        return lines.last { $0["event"] as? String == "session_started" }!["session"] as! [String: Any]
    }
    func control(_ s: [String: Any]) -> Int {
        send(["op": "control", "sessionId": s["sessionId"]!, "surfaceId": s["surfaceId"]!, "elementId": "el_1", "action": "press"])
    }
    func observe(_ s: [String: Any]) -> Int {
        send(["op": "observe", "sessionId": s["sessionId"]!, "surfaceId": s["surfaceId"]!, "maxNodes": 5])
    }
    func until(_ condition: () -> Bool) async -> Bool {
        for _ in 0..<500 {
            if condition() { return true }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        return condition()
    }
    /// The reply to `id` precedes a `session_ended` with `reason`.
    func replyPrecedesEnd(_ id: Int, _ reason: String) -> Bool {
        guard let r = index({ $0["id"] as? Int == id }),
              let e = index({ $0["event"] as? String == "session_ended" && $0["reason"] as? String == reason }) else { return false }
        return r < e
    }
}

@MainActor
@Suite struct GateAndClosingTests {
    /// F1. A gate closes silently after the core accepted the action and before the lane hands it off. The
    /// fresh authorization on the lane refuses: no attempt, refusal with effect none, written before the
    /// session end it causes.
    @Test(arguments: [("lock", "screen_locked", "screen_locked"), ("permission", "permission_missing", "permission_lost"),
                      ("indicator", "indicator_hidden", ""), ("surface", "surface_gone", "surface_gone")])
    func aGateClosedSilentlyBeforeTheEffectRefusesWithoutAnAttempt(_ change: (String, String, String)) async {
        let h = GatedHarness()
        let s = h.startSession()
        let id = h.control(s)
        #expect(await signalled(h.backend.gate.entered))
        switch change.0 {
        case "lock": h.backend.lockState = .locked
        case "permission": h.backend.permissionsGranted = false
        case "indicator": h.backend.indicatorVisible = false
        default: h.backend.alive = false
        }
        h.backend.gate.release.signal()
        #expect(await h.until { h.reply(id) != nil })
        let reply = h.reply(id) ?? [:]
        #expect(h.backend.attempts.count == 0)
        #expect(reply["ok"] as? Bool == false)
        #expect(reply["code"] as? String == change.1)
        #expect(reply["effect"] as? String == "none")
        #expect(reply["performed"] == nil)
        if change.2.isEmpty {
            #expect(h.core.hasSession, "a hidden indicator refuses without ending the session")
        } else {
            #expect(h.replyPrecedesEnd(id, change.2))
        }
    }

    /// F1. The lock is still unknown-to-the-core when the read would start: nothing is read.
    @Test func aGateClosedSilentlyBeforeTheFirstReadReadsNothing() async {
        let h = GatedHarness()
        let s = h.startSession()
        let id = h.observe(s)
        #expect(await signalled(h.backend.gate.entered))
        h.backend.lockState = .unknown
        h.backend.gate.release.signal()
        #expect(await h.until { h.reply(id) != nil })
        #expect(h.backend.reads.count == 0)
        #expect(h.reply(id)?["code"] as? String == "lock_state_unknown")
        #expect(h.reply(id)?["nodes"] == nil)
        #expect(h.replyPrecedesEnd(id, "lock_state_unknown"))
    }

    /// F1. Authorized and handed off, then the lock closes silently before completion: never promoted.
    @Test func aGateClosedSilentlyAfterTheHandOffIsUnknownNotPerformed() async {
        let h = GatedHarness()
        h.backend.authorizeAfterBlock = false
        let s = h.startSession()
        let id = h.control(s)
        #expect(await signalled(h.backend.gate.entered))
        h.backend.lockState = .locked
        h.backend.gate.release.signal()
        #expect(await h.until { h.reply(id) != nil })
        #expect(h.backend.attempts.count == 1)
        #expect(h.reply(id)?["code"] as? String == "action_unconfirmed")
        #expect(h.reply(id)?["effect"] as? String == "unknown")
        #expect(h.reply(id)?["performed"] == nil)
        #expect(h.replyPrecedesEnd(id, "screen_locked"))
    }

    /// F3. The surface goes away silently while the read is in progress (authorized before it started).
    @Test func aSurfaceLostDuringTheReadReleasesNothing() async {
        let h = GatedHarness()
        h.backend.authorizeAfterBlock = false
        let s = h.startSession()
        let id = h.observe(s)
        #expect(await signalled(h.backend.gate.entered))
        h.backend.alive = false
        h.backend.gate.release.signal()
        #expect(await h.until { h.reply(id) != nil })
        #expect(h.backend.reads.count == 1)
        #expect(h.reply(id)?["code"] as? String == "surface_gone")
        #expect(h.reply(id)?["nodes"] == nil)
        #expect(!h.lines.contains { "\($0)".contains("withheld") })
        #expect(h.replyPrecedesEnd(id, "surface_gone"))
    }

    /// F3. The session expires while the read is in progress and no timer tick runs: the completion applies
    /// expiry itself. Injected clock, no waiting for real time.
    @Test func aSessionExpiredDuringTheReadReleasesNothingWithoutATick() async {
        let h = GatedHarness()
        h.backend.authorizeAfterBlock = false
        let s = h.startSession()
        let id = h.observe(s)
        #expect(await signalled(h.backend.gate.entered))
        h.now = h.now.addingTimeInterval(61)
        #expect(h.core.hasSession, "no tick ran")
        h.backend.gate.release.signal()
        #expect(await h.until { h.reply(id) != nil })
        #expect(h.reply(id)?["code"] as? String == "session_ended")
        #expect(h.reply(id)?["nodes"] == nil)
        #expect(h.replyPrecedesEnd(id, "expired"))
    }

    /// F2. After the drain completes, nothing is admitted: a new request, a late consent decision, a tick
    /// and backend events create no session.
    @Test func afterShutdownNothingCreatesASessionOrOperation() {
        let h = GatedHarness()
        let s = h.startSession()
        var drained = 0
        h.core.shutdown { drained += 1 }
        #expect(drained == 1)
        #expect(h.core.isClosing)
        let consent = h.requestConsent()
        #expect(h.reply(consent)?["ok"] as? Bool == false)
        #expect(h.reply(consent)?["code"] as? String == "session_ended")
        h.backend.approve()
        h.core.tick()
        h.backend.onEvent?(.screenLocked)
        h.backend.onEvent?(.operatorStop)
        let read = h.observe(s)
        #expect(h.reply(read)?["code"] as? String == "session_ended")
        h.core.shutdown { drained += 1 }
        #expect(!h.core.hasSession)
        #expect(!h.core.hasOperationInFlight)
        #expect(h.lines.filter { $0["event"] as? String == "session_started" }.count == 1)
        #expect(h.backend.reads.count == 0)
        #expect(drained == 1, "the drain completion runs exactly once")
    }

    /// F2. A prompt pending at shutdown is withdrawn; the operator's late approval starts nothing.
    @Test func aConsentDecisionAfterShutdownStartsNothing() {
        let h = GatedHarness()
        _ = h.requestConsent()
        var drained = 0
        h.core.shutdown { drained += 1 }
        h.backend.approve()
        #expect(!h.core.hasSession)
        #expect(h.lines.allSatisfy { $0["event"] as? String != "session_started" })
        #expect(drained == 1)
    }

    /// F2. Shutdown while a read is in flight: during the drain, requests and output re-entrancy (the
    /// writer reacting to session_ended by asking again and shutting down again) admit nothing; the accepted
    /// read finishes, withheld; its reply precedes the single drain completion.
    @Test func duringTheDrainNothingIsAdmittedAndTheDrainCompletesOnce() async {
        let h = GatedHarness()
        let s = h.startSession()
        let read = h.observe(s)
        #expect(await signalled(h.backend.gate.entered))
        var reentered: [Int] = []
        var drained = 0
        h.onLine = { line in
            guard line["event"] as? String == "session_ended" else { return }
            reentered.append(h.requestConsent())
            h.backend.approve()
            h.core.shutdown { drained += 100 }
        }
        h.core.shutdown { drained += 1; h.lines.append(["drained": true]) }
        h.onLine = nil
        #expect(drained == 0, "accepted work is still on the lane")
        #expect(h.core.hasOperationInFlight)
        let during = h.requestConsent()
        #expect(h.reply(during)?["code"] as? String == "session_ended")
        #expect(reentered.count == 1)
        #expect(reentered.allSatisfy { h.reply($0)?["code"] as? String == "session_ended" })
        h.backend.gate.release.signal()
        #expect(await h.until { drained > 0 })
        #expect(drained == 1)
        #expect(h.backend.reads.count == 0, "the read asked its authorization after shutdown and read nothing")
        #expect(h.reply(read)?["code"] as? String == "session_ended")
        let replyIndex = h.index { $0["id"] as? Int == read }, drainedIndex = h.index { $0["drained"] != nil }
        #expect(replyIndex != nil && drainedIndex != nil && replyIndex! < drainedIndex!)
        #expect(!h.core.hasSession)
        #expect(h.lines.filter { $0["event"] as? String == "session_started" }.count == 1)
    }

    /// R2-F2. The read completes after a silent expiry, lock or surface loss, so its reply holds the
    /// session_ended it caused. The writer reacts to the reply by shutting down: the drain completes once,
    /// only after that held event is out.
    @Test(arguments: [("expiry", "expired"), ("lock", "screen_locked"), ("surface", "surface_gone")])
    func aShutdownFromAReplyDrainsOnlyAfterTheEventsThatReplyHolds(_ change: (String, String)) async {
        let h = GatedHarness()
        h.backend.authorizeAfterBlock = false
        let s = h.startSession()
        let id = h.observe(s)
        #expect(await signalled(h.backend.gate.entered))
        switch change.0 {
        case "expiry": h.now = h.now.addingTimeInterval(61)
        case "lock": h.backend.lockState = .locked
        default: h.backend.alive = false
        }
        var drained = 0
        h.onLine = { line in
            guard line["id"] as? Int == id else { return }
            h.core.shutdown { drained += 1; h.lines.append(["drained": true]) }
        }
        h.backend.gate.release.signal()
        #expect(await h.until { drained > 0 })
        h.onLine = nil
        let reply = h.index { $0["id"] as? Int == id }
        let end = h.index { $0["event"] as? String == "session_ended" && $0["reason"] as? String == change.1 }
        let drain = h.index { $0["drained"] != nil }
        #expect(reply != nil && end != nil && drain != nil && reply! < end! && end! < drain!)
        #expect(drain == h.lines.count - 1, "nothing after the drain")
        #expect(h.lines.filter { $0["event"] as? String == "session_ended" }.count == 1)
        #expect(drained == 1)
        #expect(!h.core.hasOperationInFlight)
        #expect(await h.until { !h.backend.lane.isBusy })
    }

    /// R2-F2, without any operation: end_session's reply holds the session_ended(daemon) it caused; a shutdown
    /// from that reply drains after it.
    @Test func aShutdownFromAnEndSessionReplyDrainsAfterItsSessionEnded() {
        let h = GatedHarness()
        let s = h.startSession()
        var drained = 0
        let id = h.nextId + 1
        h.onLine = { line in
            guard line["id"] as? Int == id else { return }
            h.core.shutdown { drained += 1; h.lines.append(["drained": true]) }
        }
        h.send(["op": "end_session", "sessionId": s["sessionId"]!, "reason": "done"])
        h.onLine = nil
        let end = h.index { $0["event"] as? String == "session_ended" }
        let drain = h.index { $0["drained"] != nil }
        #expect(h.index { $0["id"] as? Int == id } != nil)
        #expect(end != nil && drain != nil && end! < drain!)
        #expect(drained == 1)
    }

    /// R2-F2. A shutdown from the held session_ended itself (the last event of the completion's reply):
    /// one drain, after it, and no second session end.
    @Test func aShutdownFromTheHeldSessionEndedDrainsOnceAfterIt() async {
        let h = GatedHarness()
        h.backend.authorizeAfterBlock = false
        let s = h.startSession()
        let id = h.control(s)
        #expect(await signalled(h.backend.gate.entered))
        h.backend.lockState = .locked
        var drained = 0
        h.onLine = { line in
            guard line["event"] as? String == "session_ended" else { return }
            h.core.shutdown { drained += 1; h.lines.append(["drained": true]) }
            h.core.shutdown { drained += 100 }
        }
        h.backend.gate.release.signal()
        #expect(await h.until { drained > 0 })
        h.onLine = nil
        #expect(h.reply(id)?["code"] as? String == "action_unconfirmed")
        #expect(h.replyPrecedesEnd(id, "screen_locked"))
        let end = h.index { $0["event"] as? String == "session_ended" }, drain = h.index { $0["drained"] != nil }
        #expect(end != nil && drain != nil && end! < drain!)
        #expect(h.lines.filter { $0["event"] as? String == "session_ended" }.count == 1)
        #expect(drained == 1)
    }

    /// Stop, then shutdown from Stop's own session_ended, while the lane is about to ask its authorization
    /// (which hops to the main actor): neither side waits on the other; the action is refused unattempted
    /// and the drain completes once, after the reply.
    @Test func aStopAndShutdownWhileTheLaneIsAboutToAuthorizeDoNotDeadlock() async {
        let h = GatedHarness()
        let s = h.startSession()
        let id = h.control(s)
        #expect(await signalled(h.backend.gate.entered))
        var drained = 0
        h.onLine = { line in
            guard line["event"] as? String == "session_ended" else { return }
            h.core.shutdown { drained += 1; h.lines.append(["drained": true]) }
        }
        h.backend.onEvent?(.operatorStop)
        h.onLine = nil
        #expect(drained == 0, "the accepted action is still on the lane")
        h.backend.gate.release.signal()
        #expect(await h.until { drained > 0 })
        #expect(h.backend.attempts.count == 0)
        #expect(h.reply(id)?["code"] as? String == "session_ended")
        let reply = h.index { $0["id"] as? Int == id }, drain = h.index { $0["drained"] != nil }
        #expect(reply != nil && drain != nil && reply! < drain!)
        #expect(drained == 1)
    }
}
