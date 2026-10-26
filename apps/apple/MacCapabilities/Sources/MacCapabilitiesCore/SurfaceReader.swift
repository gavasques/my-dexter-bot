import Foundation

/// The remote attributes the reader asks of one element. Each read is one message to the target app.
public enum SurfaceAttribute: Sendable, CaseIterable {
    case focusedWindow, windows, role, subrole, title, description, value, enabled, children
}

public enum SurfaceValue {
    case text(String)
    case flag(Bool)
    case element(AnyObject)
    case elements([AnyObject])
}

public enum SurfaceActOutcome: Sendable, Equatable {
    case success
    /// Rejected by the app before any effect (unsupported action or attribute, bad argument).
    case unsupported
    case invalidElement
    case disabled
    /// Handed off; the app did not confirm.
    case failed
}

/// The remote side of one surface: Accessibility in the native backend, synthetic in tests. Every `read` and
/// `act` is one message to the app, bounded by the messaging timeout last set on its element; `application`,
/// `setTimeout` and `pid` are local. Elements are opaque and never leave the reader's lane.
public protocol SurfaceAccess: Sendable {
    func application(pid: Int32) -> AnyObject
    /// Bounds the next remote calls on `element` to `seconds` (> 0). False when the bound could not be set; the
    /// reader then makes no call on that element.
    func setTimeout(_ element: AnyObject, seconds: Float) -> Bool
    func read(_ element: AnyObject, _ attribute: SurfaceAttribute) -> SurfaceValue?
    func pid(of element: AnyObject) -> Int32?
    func act(_ element: AnyObject, _ action: CuaAction, value: String?) -> SurfaceActOutcome
}

/// Reads and acts on the selected surface through `SurfaceAccess`. Used only from one `BackendLane`, one call
/// at a time; the element ids it hands out are valid only within the lane generation that read them.
///
/// Before every remote call, in order: the lane generation is still current; the monotonic deadline taken
/// before the first call leaves at least `minimumCallTimeout`; the call's messaging timeout is set to the
/// smaller of `callTimeout` and the time left (a failure to set it is explicit and no call is made). So no
/// call starts after the deadline and none is given more than the time left: an operation exceeds its budget
/// only by however much the OS overruns the timeout of the one call in progress, which is not measured here.
/// Fresh authorization is asked before the first remote call of every read and action, and again after an
/// action's own remote reads, immediately before the input is handed off; only local checks run between
/// that last authorization and the hand-off.
public final class SurfaceReader: @unchecked Sendable {
    public static let callTimeout: TimeInterval = 1
    public static let minimumCallTimeout: TimeInterval = 0.05
    public static let observeBudget: TimeInterval = 5
    public static let performBudget: TimeInterval = 2

    private enum Stop: Error {
        case ended
        case deadline
        case unbounded
    }

    private struct Bound {
        let ticket: BackendLane.Ticket
        let deadline: TimeInterval
    }

    private let access: any SurfaceAccess
    private let now: @Sendable () -> TimeInterval
    private var elements: [String: AnyObject] = [:]
    private var elementsGeneration: UInt64?

    /// `now` is a monotonic clock in seconds; tests inject their own.
    public init(access: any SurfaceAccess, now: @escaping @Sendable () -> TimeInterval = SurfaceReader.monotonicSeconds) {
        self.access = access
        self.now = now
    }

    @Sendable public static func monotonicSeconds() -> TimeInterval {
        TimeInterval(DispatchTime.now().uptimeNanoseconds) / 1_000_000_000
    }

    public func observe(pid: Int32, maxNodes: Int, ticket: BackendLane.Ticket, authorization: CuaAuthorization) -> CuaObserveResult {
        elements = [:]
        elementsGeneration = ticket.generation
        let bound = Bound(ticket: ticket, deadline: now() + Self.observeBudget)
        // A gate that closed silently since the request was accepted reads nothing.
        if let code = authorization.refusal() { return .refused(code) }
        var nodes: [CuaNode] = []
        var truncated = false
        do {
            let app = access.application(pid: pid)
            var window: AnyObject?
            if case .element(let focused)? = try read(app, .focusedWindow, bound) { window = focused }
            if window == nil, case .elements(let windows)? = try read(app, .windows, bound) { window = windows.first }
            guard let window else { return .refused("surface_gone") }
            var queue: [AnyObject] = [window]
            while !queue.isEmpty {
                if nodes.count >= maxNodes { truncated = true; break }
                let element = queue.removeFirst()
                // A node is kept only once all of it was read.
                let (node, children) = try readNode(element, id: "el_\(nodes.count + 1)", bound)
                elements[node.elementId] = element
                nodes.append(node)
                queue.append(contentsOf: children)
            }
        } catch {
            switch error as? Stop ?? .ended {
            // A stopped session reads nothing more; the core withholds whatever was read.
            case .ended: elements = [:]; return .refused("session_ended")
            case .unbounded: elements = [:]; return .refused("element_unsupported")
            case .deadline: truncated = true
            }
        }
        return .nodes(nodes, truncated: truncated)
    }

    public func perform(pid: Int32, elementId: String, action: CuaAction, value: String?, ticket: BackendLane.Ticket,
                        authorization: CuaAuthorization) -> CuaPerformResult {
        guard elementsGeneration == ticket.generation, let element = elements[elementId], access.pid(of: element) == pid
        else { return .refused("element_unknown") }
        let bound = Bound(ticket: ticket, deadline: now() + Self.performBudget)
        // A gate that closed silently since the request was accepted: no remote call at all, not even the
        // subrole read of a set_value.
        if let code = authorization.refusal() { return .refused(code) }
        do {
            if action == .setValue {
                guard value != nil else { return .refused("element_unsupported") }
                if case .text("AXSecureTextField")? = try read(element, .subrole, bound) { return .refused("element_unsupported") }
                // That read was remote: fresh gates again before the hand-off.
                if let code = authorization.refusal() { return .refused(code) }
            }
            // Only local checks (generation, deadline, the effect's timeout) between the last authorization and the hand-off.
            try prepare(element, bound)
        } catch {
            switch error as? Stop ?? .ended {
            case .ended: return .refused("session_ended")
            // Too slow or unboundable before anything was sent: refused, nothing delivered.
            case .deadline, .unbounded: return .refused("element_unsupported")
            }
        }
        // Handed to the OS from here; it cannot be recalled.
        switch access.act(element, action, value: value) {
        case .success: return .performed
        case .unsupported: return .refused("element_unsupported")
        case .invalidElement: return .refused("element_unknown")
        case .disabled: return .refused("permission_missing")
        case .failed: return .unconfirmed
        }
    }

    private func readNode(_ element: AnyObject, id: String, _ bound: Bound) throws -> (CuaNode, [AnyObject]) {
        let role = try text(element, .role, bound) ?? "AXUnknown"
        let secure = try text(element, .subrole, bound) == "AXSecureTextField"
        var title = try text(element, .title, bound)
        if title == nil { title = try text(element, .description, bound) }
        // A secure text field's value is never asked for.
        let value = secure ? "" : try text(element, .value, bound) ?? ""
        var enabled = false
        if case .flag(let flag)? = try read(element, .enabled, bound) { enabled = flag }
        var children: [AnyObject] = []
        if case .elements(let list)? = try read(element, .children, bound) { children = list }
        let node = CuaNode(elementId: id, role: secure ? "AXSecureTextField" : role, title: title ?? "", value: value, enabled: enabled)
        return (node, children)
    }

    private func text(_ element: AnyObject, _ attribute: SurfaceAttribute, _ bound: Bound) throws -> String? {
        guard case .text(let string)? = try read(element, attribute, bound) else { return nil }
        return string
    }

    private func read(_ element: AnyObject, _ attribute: SurfaceAttribute, _ bound: Bound) throws -> SurfaceValue? {
        try prepare(element, bound)
        return access.read(element, attribute)
    }

    /// The checks before every remote call.
    private func prepare(_ element: AnyObject, _ bound: Bound) throws {
        guard bound.ticket.isCurrent else { throw Stop.ended }
        let remaining = bound.deadline - now()
        guard remaining >= Self.minimumCallTimeout else { throw Stop.deadline }
        guard access.setTimeout(element, seconds: Float(min(Self.callTimeout, remaining))) else { throw Stop.unbounded }
    }
}
