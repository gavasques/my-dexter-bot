import Foundation
import Testing
@testable import MacCapabilitiesCore

/// Test-owned backend whose indicator is confirmed only when the test says so, like a window server that
/// reports a newly ordered-in panel visible after the run loop turns. It keeps the readiness callback even
/// after `endSession`, so a test can deliver a late report the protocol forbids and see the core ignore it.
/// No AppKit, AX or input.
@MainActor
final class DeferredIndicatorBackend: CuaBackend {
    var permissionsGranted = true
    var lockState: CuaLockState = .unlocked
    var indicatorVisible = false
    var alive = true
    var onEvent: (@MainActor (CuaBackendEvent) -> Void)?
    private(set) var shown: (@MainActor (Bool) -> Void)?
    private(set) var begins = 0
    private(set) var ends = 0
    private var decide: (@MainActor (CuaSurface?) -> Void)?
    private var surfaceId = ""

    func presentConsent(_ request: ConsentRequest, surfaceId: String, decide: @escaping @MainActor (CuaSurface?) -> Void) {
        self.decide = decide
        self.surfaceId = surfaceId
    }
    func approve() { let callback = decide; decide = nil; callback?(CuaSurface(surfaceId: surfaceId, label: "Owned", handle: 1)) }
    func cancelConsent() { decide = nil }
    func beginSession(on surface: CuaSurface, botLabel: String, shown: @escaping @MainActor (Bool) -> Void) {
        begins += 1
        self.shown = shown
    }
    /// The window server confirmed (or never confirmed) the indicator.
    func report(_ visible: Bool) {
        indicatorVisible = visible
        shown?(visible)
    }
    func endSession() { ends += 1; indicatorVisible = false }
    func surfaceAlive(_ surface: CuaSurface) -> Bool { alive }
    func observe(_ surface: CuaSurface, maxNodes: Int, authorization: CuaAuthorization,
                 completion: @escaping @MainActor (CuaObserveResult) -> Void) {
        completion(.refused(authorization.refusal() ?? "test_unexpected"))
    }
    func perform(_ surface: CuaSurface, elementId: String, action: CuaAction, value: String?, authorization: CuaAuthorization,
                 completion: @escaping @MainActor (CuaPerformResult) -> Void) {
        completion(.refused(authorization.refusal() ?? "test_unexpected"))
    }
}

@MainActor
final class ReadinessHarness {
    let backend = DeferredIndicatorBackend()
    var now = Date(timeIntervalSince1970: 3_000_000)
    var lines: [[String: Any]] = []
    lazy var core = HelperCore(backend: backend, fixtureMode: false, clock: { [unowned self] in self.now }) { [unowned self] line in
        self.lines.append(try! JSONSerialization.jsonObject(with: Data(line.utf8)) as! [String: Any])
    }
    var nextId = 0
    let botKey = String(repeating: "d", count: 32)

    @discardableResult
    func send(_ message: [String: Any]) -> [String: Any] {
        nextId += 1
        var m = message
        m["v"] = cuaProtocolVersion
        m["id"] = nextId
        core.handle(line: String(decoding: try! JSONSerialization.data(withJSONObject: m), as: UTF8.self))
        return lines.last { $0["id"] as? Int == nextId } ?? [:]
    }
    func events(_ name: String) -> [[String: Any]] { lines.filter { $0["event"] as? String == name } }
    func requestConsent() -> [String: Any] {
        send(["op": "request_consent", "botKey": botKey, "botLabel": "P", "maxSeconds": 60, "promptSeconds": 60])
    }
    /// Approves the prompt; the indicator is put up but not yet confirmed.
    func approvePending() {
        precondition(requestConsent()["ok"] as? Bool == true)
        backend.approve()
    }
}

@MainActor
@Suite struct IndicatorReadinessTests {
    /// INDICATOR_NOT_VISIBLE (Root R2): the indicator was asked to show and checked in the same turn. The
    /// session now starts only when the backend reports it on screen; until then nothing is granted.
    @Test func sessionStartsOnlyAfterTheIndicatorIsReportedOnScreen() {
        let h = ReadinessHarness()
        h.approvePending()
        #expect(h.backend.begins == 1)
        #expect(h.events("session_started").isEmpty)
        #expect(h.events("consent_denied").isEmpty)
        #expect(h.requestConsent()["code"] as? String == "busy")
        let status = h.send(["op": "status"])["state"] as? [String: Any] ?? [:]
        #expect(status["consentPending"] as? Bool == true)
        #expect(status["session"] is NSNull)
        h.backend.report(true)
        let started = h.events("session_started")
        #expect(started.count == 1)
        let session = started.first?["session"] as? [String: Any] ?? [:]
        #expect(session["indicatorVisible"] as? Bool == true)
        #expect(h.core.hasSession)
        #expect(h.backend.ends == 0)
    }

    @Test func anIndicatorNeverShownStartsNothing() {
        let h = ReadinessHarness()
        h.approvePending()
        h.backend.report(false)
        #expect(h.events("session_started").isEmpty)
        #expect(h.events("consent_denied").count == 1)
        #expect(h.backend.ends == 1)
        #expect(!h.core.hasSession)
        #expect(h.requestConsent()["ok"] as? Bool == true)
    }

    /// Stop, takeover, lock, lost permission or a gone surface before the indicator was confirmed abandons the
    /// start; a late report afterwards (which the protocol forbids) still starts nothing.
    @Test(arguments: [CuaBackendEvent.operatorStop, .takeover, .screenLocked, .permissionLost, .surfaceGone])
    func anEventBeforeReadinessAbandonsTheStartForGood(_ event: CuaBackendEvent) {
        let h = ReadinessHarness()
        h.approvePending()
        h.backend.onEvent?(event)
        #expect(h.events("consent_denied").count == 1)
        #expect(h.backend.ends == 1)
        h.backend.report(true)
        #expect(h.events("session_started").isEmpty)
        #expect(h.events("session_ended").isEmpty)
        #expect(!h.core.hasSession)
        #expect(h.backend.ends == 1)
    }

    /// A gate that closed silently while the indicator was pending is read again when readiness arrives.
    @Test(arguments: ["lock", "lock_unknown", "permission", "surface", "expired"])
    func aGateClosedWhilePendingStartsNothing(_ change: String) {
        let h = ReadinessHarness()
        h.approvePending()
        switch change {
        case "lock": h.backend.lockState = .locked
        case "lock_unknown": h.backend.lockState = .unknown
        case "permission": h.backend.permissionsGranted = false
        case "surface": h.backend.alive = false
        default: h.now = h.now.addingTimeInterval(maxIndicatorReadySeconds)
        }
        h.backend.report(true)
        #expect(h.events("session_started").isEmpty)
        #expect(h.events("consent_denied").count == 1)
        #expect(h.backend.ends == 1)
        #expect(!h.core.hasSession)
    }

    /// A backend that never answers cannot hold the core: the tick abandons the start at its own bound.
    @Test func theCoreAbandonsAStartTheBackendNeverConfirms() {
        let h = ReadinessHarness()
        h.approvePending()
        h.now = h.now.addingTimeInterval(maxIndicatorReadySeconds - 0.5)
        h.core.tick()
        #expect(h.events("consent_denied").isEmpty)
        h.now = h.now.addingTimeInterval(0.5)
        h.core.tick()
        #expect(h.events("consent_denied").count == 1)
        #expect(h.backend.ends == 1)
        h.backend.report(true)
        #expect(h.events("session_started").isEmpty)
        #expect(!h.core.hasSession)
    }

    @Test func shutdownWhilePendingStartsNothingAndDrains() {
        let h = ReadinessHarness()
        h.approvePending()
        var drained = 0
        h.core.shutdown { drained += 1 }
        #expect(drained == 1)
        #expect(h.backend.ends == 1)
        h.backend.report(true)
        #expect(h.events("session_started").isEmpty)
        #expect(!h.core.hasSession)
    }
}
