import Foundation
import Testing
@testable import MacCapabilitiesCore

/// One synthetic element of a synthetic surface.
final class SyntheticElement {
    let name: String
    var attributes: [SurfaceAttribute: SurfaceValue] = [:]
    init(_ name: String) { self.name = name }
}

/// A synthetic `SurfaceAccess` with a manual monotonic clock. It records every call in order, advances the
/// clock by `readCost` per remote read but never past the timeout last set (an app that honours its
/// messaging timeout), and can run a hook before each read (to end the lane generation
/// between two attributes). No Accessibility, no app.
final class SyntheticAccess: SurfaceAccess, @unchecked Sendable {
    private let lock = NSLock()
    private var _log: [String] = []
    private var _now: TimeInterval = 100
    let app = SyntheticElement("app")
    var readCost: TimeInterval = 0
    var timeoutAccepted = true
    var beforeRead: ((Int) -> Void)?
    var actOutcome: SurfaceActOutcome = .success
    private var readCount = 0
    private var lastTimeout: TimeInterval = .infinity

    var log: [String] { lock.withLock { _log } }
    var now: TimeInterval { lock.withLock { _now } }
    func record(_ entry: String) { lock.withLock { _log.append(entry) } }

    func application(pid: Int32) -> AnyObject { app }
    func setTimeout(_ element: AnyObject, seconds: Float) -> Bool {
        record("timeout \((element as! SyntheticElement).name) \(String(format: "%.2f", seconds)) at \(String(format: "%.2f", now))")
        lock.withLock { lastTimeout = TimeInterval(seconds) }
        return timeoutAccepted
    }
    func read(_ element: AnyObject, _ attribute: SurfaceAttribute) -> SurfaceValue? {
        readCount += 1
        beforeRead?(readCount)
        record("read \((element as! SyntheticElement).name).\(attribute)")
        lock.withLock { _now += min(readCost, lastTimeout) }
        return (element as! SyntheticElement).attributes[attribute]
    }
    func pid(of element: AnyObject) -> Int32? { 7 }
    func act(_ element: AnyObject, _ action: CuaAction, value: String?) -> SurfaceActOutcome {
        record("act \((element as! SyntheticElement).name) \(action.rawValue)")
        return actOutcome
    }
    var reads: [String] { log.filter { $0.hasPrefix("read") } }
    var acts: [String] { log.filter { $0.hasPrefix("act") } }

    /// app -> window -> [button, secure field], fully described.
    func buildSurface() {
        let window = SyntheticElement("window"), button = SyntheticElement("button"), secure = SyntheticElement("secure")
        app.attributes[.focusedWindow] = .element(window)
        window.attributes = [.role: .text("AXWindow"), .title: .text("Owned"), .enabled: .flag(true), .children: .elements([button, secure])]
        button.attributes = [.role: .text("AXButton"), .title: .text("Go"), .enabled: .flag(true)]
        secure.attributes = [.role: .text("AXTextField"), .subrole: .text("AXSecureTextField"), .value: .text("secret"), .enabled: .flag(true)]
    }
}

@MainActor
@Suite struct SurfaceReaderTests {
    let lane = BackendLane(label: "test.reader")
    var ticket: BackendLane.Ticket { BackendLane.Ticket(lane: lane, generation: lane.generation) }
    let allow = CuaAuthorization { nil }

    func reader(_ access: SyntheticAccess) -> SurfaceReader {
        SurfaceReader(access: access, now: { access.now })
    }

    /// F1. A refusing authorization before the first read: no remote call at all.
    @Test func aRefusedAuthorizationReadsNothing() {
        let access = SyntheticAccess()
        access.buildSurface()
        let result = reader(access).observe(pid: 7, maxNodes: 10, ticket: ticket, authorization: CuaAuthorization { "screen_locked" })
        #expect(result == .refused("screen_locked"))
        #expect(access.log.isEmpty)
    }

    /// A full read; the secure field's value is never asked for.
    @Test func aSecureFieldsValueIsNeverRead() {
        let access = SyntheticAccess()
        access.buildSurface()
        guard case .nodes(let nodes, let truncated) = reader(access).observe(pid: 7, maxNodes: 10, ticket: ticket, authorization: allow) else {
            Issue.record("expected nodes"); return
        }
        #expect(!truncated)
        #expect(nodes.map(\.role) == ["AXWindow", "AXButton", "AXSecureTextField"])
        #expect(nodes[2].value == "")
        #expect(!access.reads.contains("read secure.value"))
    }

    /// F4. The session ends between two attributes of one element: the next remote call is not made.
    @Test func aStopBetweenAttributesMakesNoFurtherRemoteCall() {
        let access = SyntheticAccess()
        access.buildSurface()
        let lane = lane
        access.beforeRead = { count in if count == 4 { lane.invalidate() } }
        let result = reader(access).observe(pid: 7, maxNodes: 10, ticket: ticket, authorization: allow)
        #expect(result == .refused("session_ended"))
        // focusedWindow, window.role, window.subrole, window.title (during which the stop happened); nothing after.
        #expect(access.reads == ["read app.focusedWindow", "read window.role", "read window.subrole", "read window.title"])
    }

    /// F4. Every call gets min(1 s, time left) and none starts once less than the minimum is left; the
    /// element being read when time ran out is dropped, and the result is truncated.
    @Test func theDeadlineIsCheckedBeforeEveryAttributeAndBoundsEachTimeout() {
        let access = SyntheticAccess()
        access.buildSurface()
        access.readCost = 0.7
        guard case .nodes(let nodes, let truncated) = reader(access).observe(pid: 7, maxNodes: 10, ticket: ticket, authorization: allow) else {
            Issue.record("expected nodes"); return
        }
        #expect(truncated)
        let start = 100.0, budget = SurfaceReader.observeBudget
        let timeouts = access.log.filter { $0.hasPrefix("timeout") }.map { entry -> (Double, Double) in
            let parts = entry.split(separator: " ")
            return (Double(parts[2])!, Double(parts[4])!)
        }
        #expect(!timeouts.isEmpty)
        for (seconds, at) in timeouts {
            #expect(seconds <= SurfaceReader.callTimeout + 0.001)
            #expect(seconds <= start + budget - at + 0.01, "a call never gets more than the time left")
            #expect(at < start + budget, "no call starts after the deadline")
        }
        // The last call started with 0.10 s left and was bounded to it: the read ends at the deadline, not 0.6 s later.
        #expect(access.now <= start + budget + 0.001)
        #expect(access.reads.count == 8)
        // Only the window was read completely (7 reads after focusedWindow); the button was cut and dropped.
        #expect(nodes.map(\.role) == ["AXWindow"])
    }

    /// F4. A timeout that cannot be set is an explicit refusal; no call is made on that element.
    @Test func aTimeoutThatCannotBeSetMakesNoCall() {
        let access = SyntheticAccess()
        access.buildSurface()
        access.timeoutAccepted = false
        #expect(reader(access).observe(pid: 7, maxNodes: 10, ticket: ticket, authorization: allow) == .refused("element_unsupported"))
        #expect(access.reads.isEmpty)
    }

    /// F1. The action asks a fresh authorization after its own reads and immediately before the hand-off;
    /// a refusal or a stop at that point sends nothing.
    @Test func theActionIsAuthorizedImmediatelyBeforeTheHandOff() {
        let access = SyntheticAccess()
        access.buildSurface()
        let reader = reader(access)
        #expect(reader.observe(pid: 7, maxNodes: 10, ticket: ticket, authorization: allow) != .refused("session_ended"))

        let refusing = CuaAuthorization { access.record("authorize: refuse"); return "permission_missing" }
        #expect(reader.perform(pid: 7, elementId: "el_2", action: .press, value: nil, ticket: ticket, authorization: refusing) == .refused("permission_missing"))
        #expect(access.acts.isEmpty)
        #expect(access.log.last == "authorize: refuse")
    }

    @Test func anAuthorizedActionIsHandedOffOnceRightAfterItsAuthorization() {
        let access = SyntheticAccess()
        access.buildSurface()
        let reader = reader(access)
        _ = reader.observe(pid: 7, maxNodes: 10, ticket: ticket, authorization: allow)
        let recording = CuaAuthorization { access.record("authorize"); return nil }
        #expect(reader.perform(pid: 7, elementId: "el_2", action: .press, value: nil, ticket: ticket, authorization: recording) == .performed)
        let tail = Array(access.log.suffix(3))
        #expect(tail.count == 3 && tail[0] == "authorize" && tail[1].hasPrefix("timeout button 1.00") && tail[2] == "act button press")
        #expect(access.acts.count == 1)
        // set_value on the secure field: authorized before its subrole read (the first remote call), then
        // refused on that subrole with no effect and no second authorization.
        #expect(reader.perform(pid: 7, elementId: "el_3", action: .setValue, value: "x", ticket: ticket, authorization: recording) == .refused("element_unsupported"))
        #expect(Array(access.log.suffix(3)) == ["authorize", "timeout secure 1.00 at 100.00", "read secure.subrole"])
        #expect(access.acts.count == 1)
        #expect(access.log.filter { $0 == "authorize" }.count == 2)
    }

    /// R2-F1. set_value is authorized before its subrole read and again after it, immediately before the
    /// hand-off: authorize, read, authorize, act.
    @Test func aSetValueIsAuthorizedBeforeItsFirstReadAndAgainBeforeTheHandOff() {
        let access = SyntheticAccess()
        access.buildSurface()
        let reader = reader(access)
        _ = reader.observe(pid: 7, maxNodes: 10, ticket: ticket, authorization: allow)
        let start = access.log.count
        let recording = CuaAuthorization { access.record("authorize"); return nil }
        #expect(reader.perform(pid: 7, elementId: "el_2", action: .setValue, value: "x", ticket: ticket, authorization: recording) == .performed)
        let steps = access.log.dropFirst(start).map { $0.hasPrefix("timeout") ? "timeout" : $0 }
        #expect(steps == ["authorize", "timeout", "read button.subrole", "authorize", "timeout", "act button set_value"])
    }

    /// R2-F1. A gate that closes silently during set_value's subrole read: the second authorization refuses
    /// and nothing is handed off.
    @Test func aGateClosedDuringTheSubroleReadSendsNothing() {
        let access = SyntheticAccess()
        access.buildSurface()
        let reader = reader(access)
        _ = reader.observe(pid: 7, maxNodes: 10, ticket: ticket, authorization: allow)
        let closed = AttemptCounter()
        access.beforeRead = { _ in closed.increment() }
        let closing = CuaAuthorization { closed.count == 0 ? nil : "screen_locked" }
        #expect(reader.perform(pid: 7, elementId: "el_2", action: .setValue, value: "x", ticket: ticket, authorization: closing) == .refused("screen_locked"))
        #expect(closed.count == 1, "exactly the subrole read")
        #expect(access.acts.isEmpty)
    }

    /// A ticket whose generation ended between authorization and the effect: nothing is sent.
    @Test func aStopAfterAuthorizationButBeforeTheEffectSendsNothing() {
        let access = SyntheticAccess()
        access.buildSurface()
        let reader = reader(access)
        let ticket = ticket
        _ = reader.observe(pid: 7, maxNodes: 10, ticket: ticket, authorization: allow)
        let lane = lane
        let stopping = CuaAuthorization { lane.invalidate(); return nil }
        #expect(reader.perform(pid: 7, elementId: "el_2", action: .press, value: nil, ticket: ticket, authorization: stopping) == .refused("session_ended"))
        #expect(access.acts.isEmpty)
    }
}
