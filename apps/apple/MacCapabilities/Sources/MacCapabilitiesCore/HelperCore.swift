import Foundation

public let cuaProtocolVersion = 2
public let maxSessionSeconds = 15 * 60
/// Longest time one consent prompt may stay open; the daemon asks for its own shorter bound.
public let maxConsentPromptSeconds = 5 * 60
let maxLineBytes = 64 * 1024
let maxNodes = 200
let maxNodeText = 160
/// Longest time the core waits for the backend to confirm its indicator on screen before it gives up itself.
let maxIndicatorReadySeconds: TimeInterval = 5

/// Session end reasons the daemon understands.
public enum CuaEndReason: String, Sendable {
    case operatorStop = "operator_stop"
    case takeover
    case expired
    case screenLocked = "screen_locked"
    case lockStateUnknown = "lock_state_unknown"
    case permissionLost = "permission_lost"
    case surfaceGone = "surface_gone"
    case daemon
}

struct ActiveSession {
    let sessionId: String
    let botKey: String
    let botLabel: String
    let surface: CuaSurface
    let expiresAt: Date
}

/// A session whose indicator the backend has put up but not yet confirmed on screen. It grants nothing.
struct StartingSession {
    let active: ActiveSession
    /// After this instant the core abandons the start even if the backend never answered.
    let readyBy: Date
}

/// The one backend read or action the core has handed off and not yet seen complete.
struct InFlightOperation {
    let token: Int
    let sessionId: String
}

struct PendingConsent {
    let request: ConsentRequest
    let surfaceId: String
    /// After this instant the prompt is withdrawn and an approval no longer starts a session.
    let expiresAt: Date
}

/// The helper's protocol engine. It owns the single CUA session, enforces every gate before it lets the
/// backend observe or act, and ends the session itself on stop, takeover, lock, lost permission, a gone
/// surface or expiry. The daemon can only ask; it cannot start a session, choose a surface or skip a gate.
///
/// Lines are JSON objects tagged `v: 1`. Requests carry an integer `id`; the reply echoes it. Events have
/// an `event` field and no `id`. Unknown ops, fields of the wrong type and oversized lines are refused.
@MainActor
public final class HelperCore {
    private let backend: CuaBackend
    private let fixtureMode: Bool
    private let clock: () -> Date
    private let randomHex: () -> String
    private let output: (String) -> Void
    private(set) var session: ActiveSession?
    private(set) var consent: PendingConsent?
    /// Set from the operator's approval until the backend reports its indicator; never a session.
    private(set) var starting: StartingSession?
    /// Events raised while a request is handled wait until its reply is written, so the daemon learns a
    /// refusal (`effect: none`) before the session end it caused and never mistakes it for an interrupted effect.
    private var heldEvents: [[String: Any]]?
    /// At most one backend read or action at a time. It stays set after its session ends, until the backend
    /// reports back, so no new consent or operation overlaps work that may still act.
    private(set) var inFlight: InFlightOperation?
    private var nextToken = 0
    /// Set once, by the first `shutdown`, before anything is cancelled or ended. From then on no request,
    /// consent decision, tick or backend event creates a session or an operation.
    public private(set) var isClosing = false
    /// The first shutdown's completion, run exactly once when no backend work is in flight and no protocol work
    /// is under way.
    private var drainWaiter: (@MainActor () -> Void)?
    /// Protocol work under way: a reply and the events it holds, an operation's completion from before it
    /// releases the in-flight slot, a backend event, a consent decision, a tick or initial shutdown teardown. A shutdown reached from
    /// `output` while any of it runs completes its drain only after the outermost one has written everything.
    private var protocolDepth = 0

    public init(backend: CuaBackend, fixtureMode: Bool, clock: @escaping () -> Date = Date.init,
                randomHex: @escaping () -> String = HelperCore.secureRandomHex, output: @escaping (String) -> Void) {
        self.backend = backend
        self.fixtureMode = fixtureMode
        self.clock = clock
        self.randomHex = randomHex
        self.output = output
        backend.onEvent = { [weak self] event in
            guard let self else { return }
            self.protocolWork { self.backendEvent(event) }
        }
    }

    public var hasSession: Bool { session != nil }
    public var hasOperationInFlight: Bool { inFlight != nil }

    /// 32 lowercase hex characters from the system CSPRNG.
    public nonisolated static func secureRandomHex() -> String {
        var generator = SystemRandomNumberGenerator()
        return (0..<16).map { _ in String(format: "%02x", UInt8.random(in: 0...255, using: &generator)) }.joined()
    }

    /// Ends the session and withdraws the prompt when their time is up. Called before every request and by
    /// the host's timer.
    public func tick() {
        if isClosing { return }
        protocolWork {
            if let pending = consent, clock() >= pending.expiresAt {
                consent = nil
                backend.cancelConsent()
                emit(["event": "consent_expired", "botKey": pending.request.botKey])
            }
            if let pending = starting, clock() >= pending.readyBy { abortStart(notify: true) }
            if let active = session, clock() >= active.expiresAt { end(.expired) }
        }
    }

    /// stdin closed: the daemon is gone, so no session may outlive it. Admission closes permanently first,
    /// then the prompt and the session end. `drained` runs exactly once, when no backend read or action is in
    /// flight and every reply and event already owed has been written: work already handed to the backend is
    /// waited for, never abandoned, and a shutdown reached from `output` in the middle of a reply waits for the
    /// events that reply holds. The waiter is withdrawn before it runs. Later calls do nothing.
    public func shutdown(drained: (@MainActor () -> Void)? = nil) {
        guard !isClosing else { return }
        isClosing = true
        protocolWork {
            drainWaiter = drained
            if consent != nil { backend.cancelConsent(); consent = nil }
            abortStart(notify: false)
            end(.daemon)
        }
    }

    public func handle(line: String) {
        guard line.utf8.count <= maxLineBytes,
              let data = line.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data),
              let message = object as? [String: Any],
              (message["v"] as? NSNumber)?.intValue == cuaProtocolVersion,
              let idNumber = message["id"] as? NSNumber, CFGetTypeID(idNumber) != CFBooleanGetTypeID(),
              let op = message["op"] as? String
        else {
            emit(["event": "protocol_error"])
            return
        }
        let id = idNumber.intValue
        respond(id) {
            // After shutdown nothing new is admitted, whatever the request.
            if isClosing { return refuse("session_ended") }
            tick()
            switch op {
            case "status": return status()
            case "request_consent": return requestConsent(message)
            case "observe": return observe(message, id: id)
            case "control": return control(message, id: id)
            case "end_session": return endSession(message)
            case "check": return check(message)
            case "cancel_consent": return cancelConsent(message)
            case "fixture" where fixtureMode: return fixture(message)
            default: return refuse("unsupported_op")
            }
        }
    }

    /// Writes the reply to `id` (nil: it comes later, from a backend completion), then the events raised while
    /// it was built. A completion that runs inside another reply nests: its events still follow its own reply.
    private func respond(_ id: Int, _ build: () -> [String: Any]?) {
        protocolWork {
            var outer = heldEvents
            heldEvents = []
            let reply = build()
            if var reply {
                reply["id"] = id
                emit(reply)
            }
            // Keep retention active while the output callback runs. Reentrant work may end a session
            // whose start is already queued; those events must stay after the start, and before drain.
            while let event = heldEvents?.first {
                heldEvents?.removeFirst()
                if outer != nil { outer?.append(event) }
                else { write(event) }
            }
            heldEvents = outer
        }
    }

    /// Runs `body` as protocol work; when the outermost one ends, a pending drain may complete.
    private func protocolWork(_ body: () -> Void) {
        protocolDepth += 1
        body()
        protocolDepth -= 1
        drainIfIdle()
    }

    // MARK: - operations

    private func status() -> [String: Any] {
        var state: [String: Any] = [
            "accessibility": backend.permissionsGranted, "screenLocked": backend.lockState != .unlocked, "consentPending": consent != nil || starting != nil,
        ]
        if let active = session {
            state["session"] = ["sessionId": active.sessionId, "surfaceId": active.surface.surfaceId,
                                "expiresAt": milliseconds(active.expiresAt), "indicatorVisible": backend.indicatorVisible]
        } else {
            state["session"] = NSNull()
        }
        return ["ok": true, "state": state]
    }

    private func requestConsent(_ m: [String: Any]) -> [String: Any] {
        guard Self.exactKeys(m, ["v", "id", "op", "botKey", "botLabel", "maxSeconds", "promptSeconds"]),
              let botKey = m["botKey"] as? String, Self.isHex(botKey, count: 32),
              let botLabel = m["botLabel"] as? String, !botLabel.isEmpty, botLabel.count <= 48,
              let seconds = Self.integer(m["maxSeconds"]), seconds >= 1, seconds <= maxSessionSeconds,
              let promptSeconds = Self.integer(m["promptSeconds"]), promptSeconds >= 1, promptSeconds <= maxConsentPromptSeconds
        else { return refuse("invalid_input") }
        if session != nil || consent != nil || starting != nil || inFlight != nil { return refuse("busy") }
        // The prompt is shown only when the operator could actually grant something.
        if let code = lockRefusal() { return refuse(code) }
        if !backend.permissionsGranted { return refuse("permission_missing") }
        let request = ConsentRequest(botKey: botKey, botLabel: botLabel, maxSeconds: seconds)
        let surfaceId = "srf_" + randomHex()
        let expiresAt = clock().addingTimeInterval(TimeInterval(promptSeconds))
        consent = PendingConsent(request: request, surfaceId: surfaceId, expiresAt: expiresAt)
        backend.presentConsent(request, surfaceId: surfaceId) { [weak self] surface in
            guard let self else { return }
            self.protocolWork { self.consentDecided(surface) }
        }
        return ["ok": true, "pending": true, "promptExpiresAt": milliseconds(expiresAt)]
    }

    /// The daemon withdraws a bot's prompt (its grant changed). Unknown or other bots' prompts are left alone.
    private func cancelConsent(_ m: [String: Any]) -> [String: Any] {
        guard Self.exactKeys(m, ["v", "id", "op", "botKey"]), let botKey = m["botKey"] as? String, Self.isHex(botKey, count: 32)
        else { return refuse("invalid_input") }
        if let pending = consent, pending.request.botKey == botKey {
            consent = nil
            backend.cancelConsent()
            emit(["event": "consent_denied", "botKey": botKey])
        }
        return ["ok": true]
    }

    private func consentDecided(_ surface: CuaSurface?) {
        guard !isClosing, let pending = consent else { return }
        consent = nil
        // Every gate is read again at decision time: a late answer, a lock or a lost permission starts nothing.
        guard let surface, surface.surfaceId == pending.surfaceId, session == nil, starting == nil, clock() < pending.expiresAt,
              backend.lockState == .unlocked, backend.permissionsGranted, backend.surfaceAlive(surface)
        else {
            emit(["event": "consent_denied", "botKey": pending.request.botKey])
            return
        }
        let active = ActiveSession(sessionId: "cus_" + randomHex(), botKey: pending.request.botKey, botLabel: pending.request.botLabel,
                                   surface: surface, expiresAt: clock().addingTimeInterval(TimeInterval(pending.request.maxSeconds)))
        // No visible indicator, no session: the window server may confirm it only after the run loop turns, so
        // the session starts when the backend reports it on screen, not when it was asked to show it.
        starting = StartingSession(active: active, readyBy: clock().addingTimeInterval(maxIndicatorReadySeconds))
        backend.beginSession(on: surface, botLabel: pending.request.botLabel) { [weak self] shown in
            guard let self else { return }
            self.protocolWork { self.indicatorReady(active.sessionId, shown) }
        }
    }

    /// The backend reported its indicator. Only the start still pending for this session counts, and every gate
    /// is read again: a stop, takeover, lock, lost permission, gone surface or hidden indicator meanwhile starts nothing.
    private func indicatorReady(_ sessionId: String, _ shown: Bool) {
        guard let pending = starting, pending.active.sessionId == sessionId else { return }
        starting = nil
        let active = pending.active
        guard shown, !isClosing, session == nil, clock() < pending.readyBy, clock() < active.expiresAt,
              backend.lockState == .unlocked, backend.permissionsGranted, backend.indicatorVisible, backend.surfaceAlive(active.surface)
        else {
            backend.endSession()
            emit(["event": "consent_denied", "botKey": active.botKey])
            return
        }
        session = active
        emit(["event": "session_started", "session": [
            "sessionId": active.sessionId, "botKey": active.botKey, "surfaceId": active.surface.surfaceId,
            "surfaceLabel": Self.bound(active.surface.label, 80), "expiresAt": milliseconds(active.expiresAt), "indicatorVisible": true,
        ]])
    }

    /// Abandons a start whose indicator was not confirmed: the backend withdraws it and nothing starts.
    private func abortStart(notify: Bool) {
        guard let pending = starting else { return }
        starting = nil
        backend.endSession()
        if notify { emit(["event": "consent_denied", "botKey": pending.active.botKey]) }
    }

    private func observe(_ m: [String: Any], id: Int) -> [String: Any]? {
        guard Self.exactKeys(m, ["v", "id", "op", "sessionId", "surfaceId", "maxNodes"]),
              let count = (m["maxNodes"] as? NSNumber)?.intValue, count >= 1, count <= maxNodes
        else { return refuse("invalid_input") }
        if inFlight != nil { return refuse("busy") }
        switch gate(m) {
        case .failure(let code): return refuse(code.rawValue)
        case .success(let active):
            let operation = begin(active)
            backend.observe(active.surface, maxNodes: count, authorization: authorization(operation, active)) { [weak self] result in
                guard let self else { return }
                self.complete(operation, id) { self.observed(result, active: active, count: count) }
            }
            return nil
        }
    }

    private func observed(_ result: CuaObserveResult, active: ActiveSession, count: Int) -> [String: Any] {
        // Every gate again, for this read's own session and surface: a stop, expiry, lock, lost permission,
        // hidden indicator or gone surface that happened while reading releases nothing.
        let failure = recheck(active)
        switch result {
        case .refused(let code): return refuse(failure?.rawValue ?? code)
        case .nodes(let nodes, let truncated):
            if let failure { return refuse(failure.rawValue) }
            return ["ok": true, "truncated": truncated || nodes.count > count,
                    "surface": ["surfaceId": active.surface.surfaceId, "label": Self.bound(active.surface.label, 80)],
                    "nodes": nodes.prefix(count).map { node in [
                        "elementId": node.elementId, "role": Self.bound(node.role, 48), "title": Self.bound(node.title, maxNodeText),
                        "value": Self.bound(node.value, maxNodeText), "enabled": node.enabled,
                    ] as [String: Any] }]
        }
    }

    private func control(_ m: [String: Any], id: Int) -> [String: Any]? {
        let hasValue = m["value"] != nil
        guard Self.exactKeys(m, hasValue ? ["v", "id", "op", "sessionId", "surfaceId", "elementId", "action", "value"]
                                         : ["v", "id", "op", "sessionId", "surfaceId", "elementId", "action"]),
              let elementId = m["elementId"] as? String, Self.isElementId(elementId),
              let raw = m["action"] as? String, let action = CuaAction(rawValue: raw),
              (action == .setValue) == hasValue
        else { return refuse("invalid_input") }
        var value: String?
        if hasValue {
            guard let text = m["value"] as? String, !text.isEmpty, text.count <= 512,
                  !text.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f })
            else { return refuse("invalid_input") }
            value = text
        }
        if inFlight != nil { return refuse("busy") }
        switch gate(m) {
        case .failure(let code): return refuse(code.rawValue)
        case .success(let active):
            let operation = begin(active)
            backend.perform(active.surface, elementId: elementId, action: action, value: value,
                            authorization: authorization(operation, active)) { [weak self] result in
                guard let self else { return }
                self.complete(operation, id) {
                    let failure = self.recheck(active)
                    switch result {
                    case .refused(let code): return self.refuse(failure?.rawValue ?? code)
                    // The input was handed off. If the session ended or any gate closed meanwhile, a reported
                    // success is not promoted: it may still have landed after the operator lost control.
                    case .performed where failure == nil: return ["ok": true, "performed": true]
                    case .performed, .unconfirmed: return ["ok": false, "code": "action_unconfirmed", "effect": "unknown"]
                    }
                }
            }
            return nil
        }
    }

    private func begin(_ active: ActiveSession) -> InFlightOperation {
        nextToken += 1
        let operation = InFlightOperation(token: nextToken, sessionId: active.sessionId)
        inFlight = operation
        return operation
    }

    /// The backend reported back: the slot is released and the reply written. Protocol work starts before the
    /// slot is released, so a drain cannot complete between the two or before the reply's held events are
    /// out. Ignored for a completion that does not own the slot (a second call).
    private func complete(_ operation: InFlightOperation, _ id: Int, _ build: () -> [String: Any]?) {
        guard inFlight?.token == operation.token else { return }
        protocolWork {
            inFlight = nil
            respond(id, build)
        }
    }

    private func drainIfIdle() {
        guard inFlight == nil, protocolDepth == 0, let waiter = drainWaiter else { return }
        drainWaiter = nil
        waiter()
    }

    /// The seam the backend asks on its lane. Each call hops to the main actor (or runs inline when the
    /// backend calls it there) and reads every gate fresh; it changes no state.
    private func authorization(_ operation: InFlightOperation, _ active: ActiveSession) -> CuaAuthorization {
        CuaAuthorization { [weak self] in
            let read: @MainActor () -> String? = {
                guard let self else { return "session_ended" }
                return self.authorize(operation, active)
            }
            if Thread.isMainThread { return MainActor.assumeIsolated(read) }
            return DispatchQueue.main.sync { MainActor.assumeIsolated(read) }
        }
    }

    private func authorize(_ operation: InFlightOperation, _ active: ActiveSession) -> String? {
        guard !isClosing, inFlight?.token == operation.token, session?.sessionId == active.sessionId,
              clock() < active.expiresAt else { return "session_ended" }
        switch backend.lockState {
        case .unlocked: break
        case .locked: return "screen_locked"
        case .unknown: return "lock_state_unknown"
        }
        guard backend.permissionsGranted else { return "permission_missing" }
        guard backend.indicatorVisible else { return "indicator_hidden" }
        guard backend.surfaceAlive(active.surface) else { return "surface_gone" }
        return nil
    }

    /// Gates only, no read and no input: lets the daemon confirm the bot's own session before reporting it.
    private func check(_ m: [String: Any]) -> [String: Any] {
        guard Self.exactKeys(m, ["v", "id", "op", "sessionId", "surfaceId"]) else { return refuse("invalid_input") }
        switch gate(m) {
        case .failure(let code): return refuse(code.rawValue)
        case .success(let active): return ["ok": true, "expiresAt": milliseconds(active.expiresAt)]
        }
    }

    private func endSession(_ m: [String: Any]) -> [String: Any] {
        guard Self.exactKeys(m, ["v", "id", "op", "sessionId", "reason"]), let sessionId = m["sessionId"] as? String else { return refuse("invalid_input") }
        if session?.sessionId == sessionId { end(.daemon) }
        return ["ok": true]
    }

    enum GateFailure: String, Error {
        case noSession = "no_session"
        case sessionEnded = "session_ended"
        case surfaceMismatch = "surface_mismatch"
        case screenLocked = "screen_locked"
        case lockStateUnknown = "lock_state_unknown"
        case permissionMissing = "permission_missing"
        case indicatorHidden = "indicator_hidden"
        case surfaceGone = "surface_gone"
        case invalid = "invalid_input"
    }

    /// Every check, in order, before the backend may read or act. Lock and lost permission also end the session.
    private func gate(_ m: [String: Any]) -> Result<ActiveSession, GateFailure> {
        guard let sessionId = m["sessionId"] as? String, let surfaceId = m["surfaceId"] as? String else { return .failure(.invalid) }
        guard let active = session, active.sessionId == sessionId else { return .failure(.noSession) }
        guard active.surface.surfaceId == surfaceId else { return .failure(.surfaceMismatch) }
        if let failure = sessionGates(active) { return .failure(failure) }
        return .success(active)
    }

    /// At completion: the timer may not have run since the request, so expiry is applied first, then every
    /// gate for the operation's own captured session and surface.
    private func recheck(_ active: ActiveSession) -> GateFailure? {
        tick()
        guard session?.sessionId == active.sessionId else { return .sessionEnded }
        return sessionGates(active)
    }

    private func sessionGates(_ active: ActiveSession) -> GateFailure? {
        switch backend.lockState {
        case .unlocked: break
        case .locked: end(.screenLocked); return .screenLocked
        case .unknown: end(.lockStateUnknown); return .lockStateUnknown
        }
        if !backend.permissionsGranted { end(.permissionLost); return .permissionMissing }
        guard backend.indicatorVisible else { return .indicatorHidden }
        if !backend.surfaceAlive(active.surface) { end(.surfaceGone); return .surfaceGone }
        return nil
    }

    /// Refusal code when the screen is not positively unlocked.
    private func lockRefusal() -> String? {
        switch backend.lockState {
        case .unlocked: return nil
        case .locked: return "screen_locked"
        case .unknown: return "lock_state_unknown"
        }
    }

    // MARK: - backend events and session end

    private func backendEvent(_ event: CuaBackendEvent) {
        // Any of these before the indicator was confirmed abandons the start; it can never resume later.
        abortStart(notify: true)
        switch event {
        case .operatorStop: end(.operatorStop)
        case .takeover: end(.takeover)
        case .screenLocked:
            if consent != nil { backend.cancelConsent(); consentDecided(nil) }
            end(.screenLocked)
        case .permissionLost: end(.permissionLost)
        case .surfaceGone: end(.surfaceGone)
        }
    }

    private func end(_ reason: CuaEndReason) {
        guard let active = session else { return }
        session = nil
        backend.endSession()
        emit(["event": "session_ended", "sessionId": active.sessionId, "reason": reason.rawValue])
    }

    // MARK: - fixture control (fixture mode only)

    private func fixture(_ m: [String: Any]) -> [String: Any] {
        guard let fixture = backend as? FixtureBackend, let command = m["command"] as? String else { return refuse("unsupported_op") }
        guard fixture.apply(command) else { return refuse("invalid_input") }
        return ["ok": true]
    }

    // MARK: - helpers

    private func refuse(_ code: String) -> [String: Any] { ["ok": false, "code": code, "effect": "none"] }

    private func emit(_ object: [String: Any]) {
        if object["id"] == nil, heldEvents != nil { heldEvents!.append(object); return }
        write(object)
    }

    /// Writes an already-dequeued event without adding it back to the active retention buffer.
    /// Retention remains active for any new events produced by the output callback.
    private func write(_ object: [String: Any]) {
        var message = object
        message["v"] = cuaProtocolVersion
        guard let data = try? JSONSerialization.data(withJSONObject: message, options: [.sortedKeys]),
              let line = String(data: data, encoding: .utf8) else { return }
        output(line)
    }

    private func milliseconds(_ date: Date) -> Int { Int((date.timeIntervalSince1970 * 1000).rounded(.down)) }

    static func integer(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue == number.doubleValue.rounded(.towardZero) else { return nil }
        return number.intValue
    }
    static func exactKeys(_ m: [String: Any], _ keys: Set<String>) -> Bool { Set(m.keys) == keys }
    static func isHex(_ s: String, count: Int) -> Bool {
        s.count == count && s.unicodeScalars.allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) }
    }
    static func isElementId(_ s: String) -> Bool {
        guard s.hasPrefix("el_") else { return false }
        let digits = s.dropFirst(3)
        return !digits.isEmpty && digits.count <= 6 && digits.allSatisfy(\.isASCII) && digits.allSatisfy(\.isNumber)
    }
    static func bound(_ s: String, _ limit: Int) -> String {
        let cleaned = String(String.UnicodeScalarView(s.unicodeScalars.filter { $0.value >= 0x20 && $0.value != 0x7f }))
        return cleaned.count <= limit ? cleaned : String(cleaned.prefix(limit))
    }
}
