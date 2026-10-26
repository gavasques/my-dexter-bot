import Foundation

/// Finite input actions on one accessibility element of the selected surface.
public enum CuaAction: String, Sendable, CaseIterable {
    case press
    case focus
    case setValue = "set_value"
}

/// One app window the operator selected in the consent prompt. `handle` is backend-specific (a pid for the
/// native backend); it never leaves the helper.
public struct CuaSurface: Sendable, Equatable {
    public let surfaceId: String
    public let label: String
    public let handle: Int32

    public init(surfaceId: String, label: String, handle: Int32) {
        self.surfaceId = surfaceId
        self.label = label
        self.handle = handle
    }
}

public struct CuaNode: Sendable, Equatable {
    public let elementId: String
    public let role: String
    public let title: String
    public let value: String
    public let enabled: Bool

    public init(elementId: String, role: String, title: String, value: String, enabled: Bool) {
        self.elementId = elementId
        self.role = role
        self.title = title
        self.value = value
        self.enabled = enabled
    }
}

public enum CuaObserveResult: Sendable, Equatable {
    case nodes([CuaNode], truncated: Bool)
    /// Nothing was read; `code` is one of the helper's refusal codes.
    case refused(String)
}

public enum CuaPerformResult: Sendable, Equatable {
    case performed
    /// Refused before any input was delivered.
    case refused(String)
    /// The backend attempted the action and cannot confirm whether it took effect.
    case unconfirmed
}

/// What the backend can establish about the console session. Only positive evidence counts as `unlocked`;
/// anything the backend cannot establish is `unknown`, which the core treats like a locked screen.
public enum CuaLockState: Sendable, Equatable {
    case unlocked
    case locked
    case unknown
}

public struct ConsentRequest: Sendable, Equatable {
    public let botKey: String
    public let botLabel: String
    public let maxSeconds: Int
}

/// Things the operator or the system did that end a session. The backend reports them; the core decides.
public enum CuaBackendEvent: Sendable, Equatable {
    case operatorStop
    case takeover
    case screenLocked
    case permissionLost
    case surfaceGone
}

/// A fresh, non-prompting authorization for one accepted read or action. The backend asks it on its own
/// lane, before its first remote read and again immediately before it hands an input to the OS. Each call
/// re-reads every gate on the main actor (session, expiry, lock, permission, indicator, surface), so a gate
/// that closed silently, without any event, is seen; a ticket or a snapshot taken when the request was
/// accepted is not enough. It never ends the session itself: the core does that when the operation
/// completes, after the refusal has been written.
public struct CuaAuthorization: Sendable {
    private let check: @Sendable () -> String?

    public init(_ check: @escaping @Sendable () -> String?) { self.check = check }

    /// nil when the operation may proceed now; otherwise the refusal code. Safe to call on any thread except
    /// that it must not be called from a queue the main actor waits on (the backend lane never is).
    public func refusal() -> String? { check() }
}

/// The operator-facing and OS-facing half of the helper. The native implementation uses Accessibility and
/// AppKit; the fixture implementation is deterministic and touches no screen, input or AX API.
@MainActor
public protocol CuaBackend: AnyObject {
    /// Every permission the backend needs (native: Accessibility and Input Monitoring), as currently
    /// granted. Never prompts.
    var permissionsGranted: Bool { get }
    /// Re-read on every check; never cached by the core.
    var lockState: CuaLockState { get }
    /// True only while the session indicator is actually on screen.
    var indicatorVisible: Bool { get }
    var onEvent: (@MainActor (CuaBackendEvent) -> Void)? { get set }

    /// Shows the consent prompt until `cancelConsent` or a decision. `decide` receives the selected surface, or nil when the operator declined.
    func presentConsent(_ request: ConsentRequest, surfaceId: String, decide: @escaping @MainActor (CuaSurface?) -> Void)
    func cancelConsent()
    /// Puts up the indicator and the stop/takeover monitor. A window server may report the indicator on screen
    /// only after the run loop turns, so readiness is reported, not assumed: `shown` runs at most once on the
    /// main actor, possibly before this returns, with true once `indicatorVisible` is true or false when the
    /// backend gives up within its own bound. `endSession` withdraws it: after `endSession` it never runs.
    /// Readiness hands no authority to anyone; the core starts nothing until it re-reads every gate.
    func beginSession(on surface: CuaSurface, botLabel: String, shown: @escaping @MainActor (Bool) -> Void)
    func endSession()
    func surfaceAlive(_ surface: CuaSurface) -> Bool
    /// Reads the surface. `completion` runs exactly once on the main actor, possibly before this returns. A
    /// backend whose reads can block (native AX) runs them off the main actor so stop, takeover and the timer
    /// are still handled meanwhile; `endSession` must keep a read that has not started from starting. Nothing
    /// is read unless `authorization` passes immediately before the first remote read.
    func observe(_ surface: CuaSurface, maxNodes: Int, authorization: CuaAuthorization,
                 completion: @escaping @MainActor (CuaObserveResult) -> Void)
    /// Acts once, never retried. `completion` runs exactly once on the main actor. `authorization` is asked
    /// before the first remote read and again immediately before the input is handed to the OS (after any
    /// remote read of its own); when it refuses, the result is `.refused` with its
    /// code. `.refused` means no input was delivered; once the input is handed to the OS the result is
    /// `.performed` or `.unconfirmed`.
    func perform(_ surface: CuaSurface, elementId: String, action: CuaAction, value: String?, authorization: CuaAuthorization,
                 completion: @escaping @MainActor (CuaPerformResult) -> Void)
}
