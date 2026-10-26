import Foundation

public enum HealthCapabilityError: Error, Sendable, Equatable {
    case inactive, invalidRequest, consentMissing, consentExpired, requestChanged
    case alreadyUsed, busy, authorizationRequired, backendUnavailable, invalidAggregate
}

/// These are local UI purposes, not system permission states or engine-controlled strings.
public enum HealthPurpose: Sendable, Equatable {
    case requestStepReadAuthorization
    case displayDailySteps
}

/// UTC calendar days, [start, end), at most 31 days. Rejects partial days rather than widening access.
public struct UTCStepInterval: Sendable, Equatable {
    public let start: Date
    public let end: Date
    public let dayCount: Int
    public static let maximumDays = 31
    public static let secondsPerDay: TimeInterval = 86_400

    public init(start: Date, end: Date) throws {
        let first = start.timeIntervalSince1970, last = end.timeIntervalSince1970
        guard first.isFinite, last.isFinite, first >= 0, last <= 253_402_214_400,
              first.truncatingRemainder(dividingBy: Self.secondsPerDay) == 0,
              last.truncatingRemainder(dividingBy: Self.secondsPerDay) == 0,
              last > first, last - first <= Double(Self.maximumDays) * Self.secondsPerDay else {
            throw HealthCapabilityError.invalidRequest
        }
        self.start = start
        self.end = end
        self.dayCount = Int((last - first) / Self.secondsPerDay)
    }

    public var days: [Date] {
        (0..<dayCount).map { start.addingTimeInterval(Double($0) * Self.secondsPerDay) }
    }
}

/// Ephemeral, deliberately not Codable. No samples, identifiers, source metadata or medical conclusions.
public struct DailyStepCount: Sendable, Equatable, CustomStringConvertible, CustomDebugStringConvertible {
    public let utcDay: Date
    public let count: Double
    public init(utcDay: Date, count: Double) { self.utcDay = utcDay; self.count = count }
    public var description: String { "DailyStepCount(redacted)" }
    public var debugDescription: String { description }
}

public enum StepReadResult: Sendable, Equatable, CustomStringConvertible, CustomDebugStringConvertible {
    case data([DailyStepCount])
    /// Empty can mean no matching samples, denied read access, or limited access. Never infer denial/grant.
    case emptyOrUnavailable
    case dataUnavailable
    public var description: String { "StepReadResult(redacted)" }
    public var debugDescription: String { description }
}

public enum StepAuthorizationResult: Sendable, Equatable {
    /// Only the request completed. HealthKit does not disclose whether read access was granted.
    case authorizationRequested
    case dataUnavailable
}

/// Trusted dependency only. Neither this protocol nor the boundary exposes transport, persistence or export.
public protocol LocalStepBackend: Sendable {
    func requestReadAuthorization() async throws -> StepAuthorizationResult
    func dailySteps(in interval: UTCStepInterval) async throws -> StepReadResult
}

/// Opaque, in-memory and one-use. The UI must obtain a new handle for an explicit new request.
public struct HealthConsent: Sendable {
    fileprivate let id: UUID
    fileprivate init(id: UUID) { self.id = id }
}

/// Integrating app must drive foreground state and pass explicit user consent from a local UI action.
/// This is a policy boundary, not an OS sandbox or proof of platform read permission.
public actor LocalHealthBoundary {
    private struct ConsentState {
        let scopeID: UUID
        let requestID: UUID
        let purpose: HealthPurpose
        let interval: UTCStepInterval?
        let expiresAt: TimeInterval
        var used: Bool
    }
    private let backend: any LocalStepBackend
    private let monotonicUptime: @Sendable () -> TimeInterval
    private var foreground = false
    private var authorizationRequested = false
    private var consents: [UUID: ConsentState] = [:]
    private var currentRequests: [UUID: UUID] = [:]
    private var active = Set<UUID>()
    private var cancelWork: [UUID: @Sendable () -> Void] = [:]
    public static let maximumConsents = 64
    public static let maximumConcurrentRequests = 4

    public init(backend: any LocalStepBackend) {
        self.backend = backend
        monotonicUptime = { ProcessInfo.processInfo.systemUptime }
    }

    /// Clock injection is internal so package fixtures can advance elapsed time without exposing
    /// a wall-clock override to production callers.
    init(backend: any LocalStepBackend, monotonicUptime: @escaping @Sendable () -> TimeInterval) {
        self.backend = backend
        self.monotonicUptime = monotonicUptime
    }

    public func setForegroundActive(_ active: Bool) {
        foreground = active
        if !active {
            cancelWork.values.forEach { $0() }
            consents.removeAll(); currentRequests.removeAll()
        }
    }

    /// Caller is trusted local UI composition: invoking this method asserts an explicit user action.
    /// A newer request for a scope invalidates all previous requests, including await continuations.
    public func consentToRequest(scopeID: UUID, requestID: UUID, purpose: HealthPurpose,
                                 interval: UTCStepInterval? = nil, lifetime: TimeInterval = 60) throws -> HealthConsent {
        guard foreground else { throw HealthCapabilityError.inactive }
        guard lifetime.isFinite, lifetime > 0, lifetime <= 300,
              (purpose == .displayDailySteps) == (interval != nil) else { throw HealthCapabilityError.invalidRequest }
        let issuedAt = monotonicUptime()
        let expiresAt = issuedAt + lifetime
        guard issuedAt.isFinite, issuedAt >= 0, expiresAt.isFinite, expiresAt > issuedAt else {
            throw HealthCapabilityError.invalidRequest
        }
        prune(at: issuedAt)
        // A valid replacement always revokes the previous scope before capacity can reject it.
        invalidate(scopeID)
        guard consents.count < Self.maximumConsents else { throw HealthCapabilityError.busy }
        currentRequests[scopeID] = requestID
        let id = UUID()
        consents[id] = ConsentState(scopeID: scopeID, requestID: requestID, purpose: purpose,
                                    interval: interval, expiresAt: expiresAt, used: false)
        return HealthConsent(id: id)
    }

    public func revoke(scopeID: UUID) {
        invalidate(scopeID)
    }

    public func requestAuthorization(consent: HealthConsent, scopeID: UUID, requestID: UUID) async throws -> StepAuthorizationResult {
        let state = try begin(consent, scopeID, requestID, .requestStepReadAuthorization)
        defer { finish(consent) }
        do {
            let backend = self.backend
            let work = Task { try await backend.requestReadAuthorization() }
            cancelWork[consent.id] = { work.cancel() }
            let result = try await withTaskCancellationHandler(operation: { try await work.value }, onCancel: { work.cancel() })
            try validateAfterAwait(consent, state)
            if result == .authorizationRequested { authorizationRequested = true }
            return result
        } catch {
            try validateAfterAwait(consent, state)
            throw HealthCapabilityError.backendUnavailable
        }
    }

    public func readDailySteps(consent: HealthConsent, scopeID: UUID, requestID: UUID) async throws -> StepReadResult {
        let state = try begin(consent, scopeID, requestID, .displayDailySteps)
        defer { finish(consent) }
        guard authorizationRequested else { throw HealthCapabilityError.authorizationRequired }
        guard let interval = state.interval else { throw HealthCapabilityError.invalidRequest }
        do {
            let backend = self.backend
            let work = Task { try await backend.dailySteps(in: interval) }
            cancelWork[consent.id] = { work.cancel() }
            let result = try await withTaskCancellationHandler(operation: { try await work.value }, onCancel: { work.cancel() })
            try validateAfterAwait(consent, state)
            switch result {
            case .data(let rows):
                let allowed = Set(interval.days)
                var seen = Set<Date>()
                guard !rows.isEmpty, rows.count <= interval.dayCount,
                      rows.allSatisfy({ allowed.contains($0.utcDay) && seen.insert($0.utcDay).inserted
                          && $0.count.isFinite && $0.count >= 0 && $0.count <= 1_000_000 }) else {
                    throw HealthCapabilityError.invalidAggregate
                }
                return .data(rows.sorted { $0.utcDay < $1.utcDay })
            case .emptyOrUnavailable, .dataUnavailable: return result
            }
        } catch {
            try validateAfterAwait(consent, state)
            if let safe = error as? HealthCapabilityError, safe == .invalidAggregate { throw safe }
            throw HealthCapabilityError.backendUnavailable
        }
    }

    private func begin(_ consent: HealthConsent, _ scope: UUID, _ request: UUID, _ purpose: HealthPurpose) throws -> ConsentState {
        try Task.checkCancellation()
        guard foreground else { throw HealthCapabilityError.inactive }
        guard var state = consents[consent.id] else { throw HealthCapabilityError.consentMissing }
        guard state.scopeID == scope, state.requestID == request, state.purpose == purpose,
              currentRequests[scope] == request else { throw HealthCapabilityError.requestChanged }
        guard hasTimeRemaining(until: state.expiresAt) else { throw HealthCapabilityError.consentExpired }
        guard !state.used else { throw HealthCapabilityError.alreadyUsed }
        guard active.count < Self.maximumConcurrentRequests else { throw HealthCapabilityError.busy }
        state.used = true
        consents[consent.id] = state
        active.insert(consent.id)
        return state
    }

    private func validateAfterAwait(_ consent: HealthConsent, _ state: ConsentState) throws {
        try Task.checkCancellation()
        guard foreground else { throw HealthCapabilityError.inactive }
        guard let live = consents[consent.id], live.used else { throw HealthCapabilityError.consentMissing }
        guard currentRequests[state.scopeID] == state.requestID else { throw HealthCapabilityError.requestChanged }
        guard hasTimeRemaining(until: state.expiresAt) else { throw HealthCapabilityError.consentExpired }
    }

    private func finish(_ consent: HealthConsent) {
        cancelWork.removeValue(forKey: consent.id)
        active.remove(consent.id)
        consents.removeValue(forKey: consent.id)
        prune()
    }

    private func invalidate(_ scopeID: UUID) {
        for (id, state) in consents where state.scopeID == scopeID { cancelWork[id]?() }
        consents = consents.filter { $0.value.scopeID != scopeID }
        currentRequests.removeValue(forKey: scopeID)
    }

    private func prune() {
        prune(at: monotonicUptime())
    }

    private func prune(at instant: TimeInterval) {
        consents = consents.filter { active.contains($0.key) || (instant.isFinite && $0.value.expiresAt > instant) }
        let scopes = Set(consents.values.map(\.scopeID))
        currentRequests = currentRequests.filter { scopes.contains($0.key) }
    }

    private func hasTimeRemaining(until expiresAt: TimeInterval) -> Bool {
        let instant = monotonicUptime()
        return instant.isFinite && instant < expiresAt
    }
}
