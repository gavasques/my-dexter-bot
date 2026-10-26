import Foundation
import Testing
@testable import MacCapabilitiesCore

@MainActor @Suite struct IndependentR3IdleShutdownTests {
    @Test func topLevelIdleShutdownMustWaitForItsReentrantEndEventOutputToReturn() {
        let h = GatedHarness(); _ = h.startSession()
        var drained = 0
        var nestedRequest: Int?
        h.onLine = { line in
            guard line["event"] as? String == "session_ended" else { return }
            // A normal output callback can request status/consent while it finishes processing an event.
            // Closing must refuse this request, but its nested response must not drain the outer output.
            nestedRequest = h.requestConsent()
            h.lines.append(["outerOutputReturned": true])
        }
        h.core.shutdown { drained += 1; h.lines.append(["independentDrained": true]) }
        h.onLine = nil
        let returned = h.index { $0["outerOutputReturned"] != nil }
        let drain = h.index { $0["independentDrained"] != nil }
        print("INDEPENDENT R3 idleShutdown outputReturnedIndex=\(String(describing: returned)) drainIndex=\(String(describing: drain)) drained=\(drained)")
        #expect(nestedRequest != nil && h.reply(nestedRequest!)?["code"] as? String == "session_ended")
        #expect(drained == 1)
        #expect(returned != nil && drain != nil && returned! < drain!, "drained must wait until the outer accepted event output callback returns")
        #expect(h.core.isClosing && !h.core.hasSession && !h.core.hasOperationInFlight)
    }
}

@MainActor final class ReentrantEndingBackend: CuaBackend {
    var permissionsGranted = true
    var lockState: CuaLockState = .unlocked
    var indicatorVisible = false
    var onEvent: (@MainActor (CuaBackendEvent) -> Void)?
    private var decide: (@MainActor (CuaSurface?) -> Void)?
    private var surface: CuaSurface?
    func presentConsent(_ request: ConsentRequest, surfaceId: String, decide: @escaping @MainActor (CuaSurface?) -> Void) {
        self.decide = decide; surface = CuaSurface(surfaceId: surfaceId, label: "Synthetic", handle: 1)
    }
    func approve() { let callback = decide; decide = nil; callback?(surface) }
    func cancelConsent() { decide = nil }
    func beginSession(on surface: CuaSurface, botLabel: String, shown: @escaping @MainActor (Bool) -> Void) { indicatorVisible = true; shown(true) }
    func endSession() {
        indicatorVisible = false
        // CuaBackend's typed event callback is permitted to arrive synchronously during teardown.
        // No physical input or asynchronous child: just a duplicate operator-stop notification.
        onEvent?(.operatorStop)
    }
    func surfaceAlive(_ surface: CuaSurface) -> Bool { true }
    func observe(_ surface: CuaSurface, maxNodes: Int, authorization: CuaAuthorization, completion: @escaping @MainActor (CuaObserveResult) -> Void) {
        completion(.refused("element_unsupported"))
    }
    func perform(_ surface: CuaSurface, elementId: String, action: CuaAction, value: String?, authorization: CuaAuthorization, completion: @escaping @MainActor (CuaPerformResult) -> Void) {
        completion(.refused("element_unsupported"))
    }
}

@MainActor @Suite struct IndependentR3TeardownEventTests {
    @Test func topLevelShutdownMustHoldDrainAcrossSynchronousBackendTeardownEvent() {
        let backend = ReentrantEndingBackend()
        var lines: [[String: Any]] = []
        let core = HelperCore(backend: backend, fixtureMode: false) { line in
            lines.append(try! JSONSerialization.jsonObject(with: Data(line.utf8)) as! [String: Any])
        }
        let request: [String: Any] = ["v": 2, "id": 1, "op": "request_consent", "botKey": String(repeating: "d", count: 32), "botLabel": "Synthetic", "maxSeconds": 60, "promptSeconds": 60]
        core.handle(line: String(decoding: try! JSONSerialization.data(withJSONObject: request), as: UTF8.self))
        backend.approve()
        #expect(core.hasSession)
        var drained = 0
        core.shutdown { drained += 1; lines.append(["independentDrained": true]) }
        let end = lines.firstIndex { $0["event"] as? String == "session_ended" }
        let drain = lines.firstIndex { $0["independentDrained"] != nil }
        print("INDEPENDENT R3 teardown endIndex=\(String(describing: end)) drainIndex=\(String(describing: drain)) drained=\(drained)")
        #expect(drained == 1)
        #expect(lines.filter { $0["event"] as? String == "session_ended" }.count == 1)
        #expect(end != nil && drain != nil && end! < drain!, "shutdown's own session_ended must precede drained even if endSession raises an event")
        #expect(core.isClosing && !core.hasSession && !core.hasOperationInFlight)
    }
}
