import Foundation
import Testing
import MacCapabilitiesCore
@testable import MacCapabilitiesNative

/// A one-window synthetic surface for the native backend's lane and reader. No Accessibility.
final class OneButtonAccess: SurfaceAccess, @unchecked Sendable {
    final class Element {}
    let app = Element(), window = Element(), button = Element()
    private let lock = NSLock()
    private var _acts = 0
    private var _reads = 0
    var acts: Int { lock.withLock { _acts } }
    var reads: Int { lock.withLock { _reads } }
    func application(pid: Int32) -> AnyObject { app }
    func setTimeout(_ element: AnyObject, seconds: Float) -> Bool { true }
    func read(_ element: AnyObject, _ attribute: SurfaceAttribute) -> SurfaceValue? {
        lock.withLock { _reads += 1 }
        switch (element === app, element === window, attribute) {
        case (true, _, .focusedWindow): return .element(window)
        case (_, true, .children): return .elements([button])
        case (_, _, .role): return .text(element === window ? "AXWindow" : "AXButton")
        default: return nil
        }
    }
    func pid(of element: AnyObject) -> Int32? { 9 }
    func act(_ element: AnyObject, _ action: CuaAction, value: String?) -> SurfaceActOutcome {
        lock.withLock { _acts += 1 }
        return .success
    }
}

@MainActor
@Suite struct NativeBackendTests {
    /// Any app quitting used to end the session as `surface_gone`; only the selected app may.
    @Test func onlyTheSelectedAppQuittingEndsTheSession() {
        let backend = NativeBackend()
        var events: [CuaBackendEvent] = []
        backend.onEvent = { events.append($0) }
        backend.applicationTerminated(4242)
        backend.selectedPid = 4242
        backend.applicationTerminated(1111)
        #expect(events.isEmpty)
        backend.applicationTerminated(4242)
        #expect(events == [.surfaceGone])
    }

    /// The shipped constructor stays fail-closed on this (uncalibrated) Mac: never positively unlocked.
    @Test func defaultNativeLockStateIsNeverUnlocked() {
        #expect(NativeBackend().lockState != .unlocked)
    }

    /// The native lane and reader ask the authorization before reading and before acting; a refusal there
    /// reads or sends nothing. Synthetic access, no Accessibility, no session or panel.
    @Test func theNativeLaneAsksAuthorizationBeforeReadingAndActing() async {
        let access = OneButtonAccess()
        let backend = NativeBackend(lockSignalsCalibrated: false, access: access)
        let surface = CuaSurface(surfaceId: "srf_test", label: "Synthetic", handle: 9)
        let allow = CuaAuthorization { nil }, refuse = CuaAuthorization { "screen_locked" }

        let refusedRead = await withCheckedContinuation { c in backend.observe(surface, maxNodes: 5, authorization: refuse) { c.resume(returning: $0) } }
        #expect(refusedRead == .refused("screen_locked"))
        #expect(access.reads == 0)

        let read = await withCheckedContinuation { c in backend.observe(surface, maxNodes: 5, authorization: allow) { c.resume(returning: $0) } }
        guard case .nodes(let nodes, _) = read else { Issue.record("expected nodes"); return }
        #expect(nodes.map(\.role) == ["AXWindow", "AXButton"])

        let refusedAct = await withCheckedContinuation { c in
            backend.perform(surface, elementId: "el_2", action: .press, value: nil, authorization: refuse) { c.resume(returning: $0) }
        }
        #expect(refusedAct == .refused("screen_locked"))
        #expect(access.acts == 0)

        let act = await withCheckedContinuation { c in
            backend.perform(surface, elementId: "el_2", action: .press, value: nil, authorization: allow) { c.resume(returning: $0) }
        }
        #expect(act == .performed)
        #expect(access.acts == 1)
    }
}
