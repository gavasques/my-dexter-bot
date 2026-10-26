import Foundation

/// Deterministic backend for tests and the `--fixture` helper mode. It has one synthetic surface and two
/// synthetic elements and calls no AppKit, Accessibility, screen-capture or input API. The operator's
/// actions (approve, stop, takeover, lock...) are commands sent by the test. The `*_silent` commands change
/// state without any event, like a native signal the helper only sees by polling. `delay_next_observe` holds a
/// real `BackendLane` busy for a fixed delay before the next read, which then asks its authorization from the
/// lane like the native backend, so a stdio client can stop or silently lock while the lane is busy and see
/// the drain. Every read and action asks its authorization before reading or acting.
@MainActor
public final class FixtureBackend: CuaBackend {
    public var permissionsGranted = true
    public var lockState: CuaLockState = .unlocked
    public var indicatorVisible: Bool { indicatorShown && !indicatorBroken }
    private var indicatorShown = false
    public var onEvent: (@MainActor (CuaBackendEvent) -> Void)?
    public private(set) var performed: [(elementId: String, action: CuaAction, value: String?)] = []
    public private(set) var consentShown: ConsentRequest?
    private var pendingDecision: (@MainActor (CuaSurface?) -> Void)?
    private var pendingSurfaceId: String?
    private var surfaceOpen = true
    private var indicatorBroken = false
    private var failNextPerform = false
    private var lockDuringObserve = false
    private var delayNextObserve = false
    private let lane = BackendLane(label: "dexter.cua.fixture")
    private static let surfaceLabel = "Fixture Notes"
    private static let nodes = [
        CuaNode(elementId: "el_1", role: "AXButton", title: "Send", value: "", enabled: true),
        CuaNode(elementId: "el_2", role: "AXTextField", title: "Body", value: "draft", enabled: true),
    ]

    public init() {}

    public func presentConsent(_ request: ConsentRequest, surfaceId: String, decide: @escaping @MainActor (CuaSurface?) -> Void) {
        consentShown = request
        pendingSurfaceId = surfaceId
        pendingDecision = decide
    }
    public func cancelConsent() {
        pendingDecision = nil
        pendingSurfaceId = nil
    }
    /// Reports readiness at once: the synthetic indicator is on screen unless `break_indicator` was applied.
    public func beginSession(on surface: CuaSurface, botLabel: String, shown: @escaping @MainActor (Bool) -> Void) {
        indicatorShown = true
        shown(indicatorVisible)
    }
    public func endSession() {
        indicatorShown = false
        lane.invalidate()
    }
    public func surfaceAlive(_ surface: CuaSurface) -> Bool { surfaceOpen }

    public func observe(_ surface: CuaSurface, maxNodes: Int, authorization: CuaAuthorization,
                        completion: @escaping @MainActor (CuaObserveResult) -> Void) {
        let result = CuaObserveResult.nodes(Array(Self.nodes.prefix(maxNodes)), truncated: Self.nodes.count > maxNodes)
        guard delayNextObserve else {
            if let code = authorization.refusal() { completion(.refused(code)); return }
            if lockDuringObserve { lockDuringObserve = false; lockState = .locked }
            completion(result)
            return
        }
        delayNextObserve = false
        lane.submit(skipped: .refused("session_ended"), { _ in
            Thread.sleep(forTimeInterval: 0.8)
            if let code = authorization.refusal() { return .refused(code) }
            return result
        }, completion: completion)
    }
    public func perform(_ surface: CuaSurface, elementId: String, action: CuaAction, value: String?, authorization: CuaAuthorization,
                        completion: @escaping @MainActor (CuaPerformResult) -> Void) {
        completion(performNow(elementId: elementId, action: action, value: value, authorization: authorization))
    }
    private func performNow(elementId: String, action: CuaAction, value: String?, authorization: CuaAuthorization) -> CuaPerformResult {
        guard let node = Self.nodes.first(where: { $0.elementId == elementId }) else { return .refused("element_unknown") }
        if action == .setValue && node.role != "AXTextField" { return .refused("element_unsupported") }
        if let code = authorization.refusal() { return .refused(code) }
        if failNextPerform { failNextPerform = false; return .unconfirmed }
        performed.append((elementId, action, value))
        return .performed
    }

    /// Applies one fixture command. Returns false for an unknown command.
    public func apply(_ command: String) -> Bool {
        switch command {
        case "approve_consent":
            guard let decide = pendingDecision, let surfaceId = pendingSurfaceId else { return false }
            cancelConsent()
            decide(CuaSurface(surfaceId: surfaceId, label: Self.surfaceLabel, handle: 1))
        case "deny_consent":
            guard let decide = pendingDecision else { return false }
            cancelConsent()
            decide(nil)
        case "stop": onEvent?(.operatorStop)
        case "takeover": onEvent?(.takeover)
        case "lock": lockState = .locked; onEvent?(.screenLocked)
        case "unlock": lockState = .unlocked
        case "lock_silent": lockState = .locked
        case "lock_unknown_silent": lockState = .unknown
        case "lock_during_observe": lockDuringObserve = true
        case "revoke_permission": permissionsGranted = false; onEvent?(.permissionLost)
        case "revoke_permission_silent": permissionsGranted = false
        case "grant_permission": permissionsGranted = true
        case "break_indicator", "hide_indicator_silent": indicatorBroken = true
        case "restore_indicator": indicatorBroken = false
        case "close_surface": surfaceOpen = false; onEvent?(.surfaceGone)
        case "fail_next_perform": failNextPerform = true
        case "delay_next_observe": delayNextObserve = true
        default: return false
        }
        return true
    }
}
