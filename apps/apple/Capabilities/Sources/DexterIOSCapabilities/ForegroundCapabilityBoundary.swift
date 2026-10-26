import Foundation
import DexterNativeActions

public enum IOSForegroundCapabilityError: Error, Sendable, Equatable {
    case inactive
    case invalidRequest
    case consentMissing
    case consentExpired
    case requestChanged
    case alreadyUsed
    case busy
    case permissionDenied
    case empty
    case offline
    case unsupported
    case pickerCancelled
    case resultRejected
    case backendUnavailable
    case permissionPreparationRequired
}

public enum IOSForegroundCapabilityOutcome: Sendable {
    case value(IOSForegroundCapabilityPayload)
    case empty
}

private final class IOSForegroundCapabilityRequestLifetime: @unchecked Sendable {
    private let lock = NSLock()
    private let expiresAt: TimeInterval
    private let monotonicUptime: @Sendable () -> TimeInterval
    private var revoked = false

    init(expiresAt: TimeInterval, monotonicUptime: @escaping @Sendable () -> TimeInterval) {
        self.expiresAt = expiresAt
        self.monotonicUptime = monotonicUptime
    }

    func revoke() {
        lock.lock()
        revoked = true
        lock.unlock()
    }

    func check() throws {
        lock.lock()
        let isRevoked = revoked
        lock.unlock()
        if isRevoked { throw CancellationError() }
        guard monotonicUptime() < expiresAt else { throw IOSForegroundCapabilityError.consentExpired }
    }
}

/// Immutable provider input bound to one consent; the calendar window cannot be widened by a caller.
public struct IOSForegroundCapabilityRequest: Sendable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    public let capability: IOSNativeCapability
    public let calendarStart: Date
    public let calendarEnd: Date
    private let authorizeOperation: @Sendable () async throws -> Void
    private let lifetime: IOSForegroundCapabilityRequestLifetime

    fileprivate init(capability: IOSNativeCapability, calendarStart: Date, calendarEnd: Date,
                     lifetime: IOSForegroundCapabilityRequestLifetime,
                     authorizeOperation: @escaping @Sendable () async throws -> Void) {
        self.capability = capability
        self.calendarStart = calendarStart
        self.calendarEnd = calendarEnd
        self.lifetime = lifetime
        self.authorizeOperation = authorizeOperation
    }

    /// Providers call this after every suspension and immediately before each additional native read or prompt.
    public func checkAuthorization() async throws {
        try lifetime.check()
        try await authorizeOperation()
        try lifetime.check()
    }

    /// Synchronous callback adapters use this before consuming callback-scoped resources.
    func checkCallbackAuthorization() throws { try lifetime.check() }

    fileprivate func cancelAuthorization() { lifetime.revoke() }

    public var description: String { "IOSForegroundCapabilityRequest(\(capability.rawValue), bounded)" }
    public var debugDescription: String { description }
    public var customMirror: Mirror {
        Mirror(self, children: [(label: "capability", value: capability.rawValue), (label: "calendarWindow", value: "bounded")], displayStyle: .struct)
    }
}

/// The closed result shapes prevent an operation from widening into a different kind of read.
/// Payload descriptions, debug output and reflection are deliberately opaque.
public enum IOSForegroundCapabilityPayload: Sendable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    case calendar([IOSCalendarEventSummary])
    case contact(name: String)
    case location(latitude: Double, longitude: Double)
    case file(name: String, bytes: Data)
    case photo(jpeg: Data)
    case cameraImage(jpeg: Data)
    case microphone(pcm16Mono: Data, duration: TimeInterval, sampleRate: Double)

    public var description: String { "IOSForegroundCapabilityPayload(redacted)" }
    public var debugDescription: String { description }
    public var customMirror: Mirror { Mirror(self, children: EmptyCollection<(label: String?, value: Any)>()) }
}

public struct IOSCalendarEventSummary: Sendable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    public let title: String
    public let start: Date

    public init(title: String, start: Date) {
        self.title = title
        self.start = start
    }

    public var description: String { "IOSCalendarEventSummary(redacted)" }
    public var debugDescription: String { description }
    public var customMirror: Mirror { Mirror(self, children: EmptyCollection<(label: String?, value: Any)>()) }
}

/// A render-only view of a validated result. It is never Codable and is returned only to the local UI.
public enum IOSForegroundCapabilityPresentation: Sendable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    case calendar([(title: String, start: Date)])
    case contact(name: String)
    case location(latitude: Double, longitude: Double)
    case file(name: String, byteCount: Int, textPreview: String?)
    case photo(jpeg: Data)
    case cameraImage(jpeg: Data)
    case microphone(duration: TimeInterval, sampleRate: Double)

    public var description: String { "IOSForegroundCapabilityPresentation(redacted)" }
    public var debugDescription: String { description }
    public var customMirror: Mirror { Mirror(self, children: EmptyCollection<(label: String?, value: Any)>()) }
}

/// The raw payload stays private to this result wrapper; UI gets a minimized local projection.
public struct IOSForegroundCapabilityResult: Sendable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    public let capability: IOSNativeCapability
    private let payload: IOSForegroundCapabilityPayload

    fileprivate init(capability: IOSNativeCapability, payload: IOSForegroundCapabilityPayload) {
        self.capability = capability
        self.payload = payload
    }

    public var localPresentation: IOSForegroundCapabilityPresentation {
        switch payload {
        case .calendar(let events):
            return .calendar(events.prefix(10).map { (title: $0.title, start: $0.start) })
        case .contact(let name):
            return .contact(name: name)
        case .location(let latitude, let longitude):
            return .location(latitude: latitude, longitude: longitude)
        case .file(let name, let bytes):
            let text = String(data: bytes, encoding: .utf8).map { String($0.prefix(2_000)) }
            return .file(name: name, byteCount: bytes.count, textPreview: text)
        case .photo(let jpeg):
            return .photo(jpeg: jpeg)
        case .cameraImage(let jpeg):
            return .cameraImage(jpeg: jpeg)
        case .microphone(_, let duration, let sampleRate):
            return .microphone(duration: duration, sampleRate: sampleRate)
        }
    }

    public var description: String { "IOSForegroundCapabilityResult(capability: \(capability.rawValue), payload: redacted)" }
    public var debugDescription: String { description }
    public var customMirror: Mirror {
        Mirror(self, children: [(label: "capability", value: capability.rawValue), (label: "payload", value: "redacted")], displayStyle: .struct)
    }
}

/// Provider access is dependency-injected. Only the local foreground view calls the boundary.
public protocol IOSForegroundCapabilityBackend: Sendable {
    func perform(_ request: IOSForegroundCapabilityRequest) async throws -> IOSForegroundCapabilityOutcome
}

/// Opaque, process-local, non-Codable, one-use approval for one foreground request.
public struct IOSForegroundCapabilityConsent: Sendable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    fileprivate let id: UUID
    fileprivate init(id: UUID) { self.id = id }
    public var description: String { "IOSForegroundCapabilityConsent(redacted)" }
    public var debugDescription: String { description }
    public var customMirror: Mirror { Mirror(self, children: EmptyCollection<(label: String?, value: Any)>()) }
}

/// A local-only policy boundary. It has no transport, persistence, stream, export, or engine dependency.
public actor IOSForegroundCapabilityBoundary {
    private struct ConsentState {
        let scopeID: UUID
        let requestID: UUID
        let request: IOSForegroundCapabilityRequest
        let expiresAt: TimeInterval
        var used: Bool
    }

    private let backend: any IOSForegroundCapabilityBackend
    private let monotonicUptime: @Sendable () -> TimeInterval
    private var foregroundScopes = Set<UUID>()
    private var consents: [UUID: ConsentState] = [:]
    private var currentRequests: [UUID: UUID] = [:]
    private var seenRequestIDs: [UUID: Set<UUID>] = [:]
    private var work: [UUID: Task<IOSForegroundCapabilityOutcome, Error>] = [:]
    private var expiryTasks: [UUID: Task<Void, Never>] = [:]
    private var active = Set<UUID>()

    public static let maximumConsentLifetime: TimeInterval = 90
    public static let maximumOutstandingConsents = 32
    public static let maximumRequestsPerScope = 64
    public static let maximumConcurrentOperations = 1
    public static let maximumFileBytes = 1_048_576
    public static let maximumImageBytes = 10_485_760
    public static let maximumAudioBytes = 1_000_000
    public static let maximumAudioDuration: TimeInterval = 10

    public init(backend: any IOSForegroundCapabilityBackend) {
        self.backend = backend
        monotonicUptime = { ProcessInfo.processInfo.systemUptime }
    }

    init(backend: any IOSForegroundCapabilityBackend, monotonicUptime: @escaping @Sendable () -> TimeInterval) {
        self.backend = backend
        self.monotonicUptime = monotonicUptime
    }

    /// The app's local scene lifecycle owns this state; `true` does not grant OS permission.
    public func setForegroundActive(_ isActive: Bool, scopeID: UUID) {
        if isActive {
            foregroundScopes.insert(scopeID)
            return
        }
        foregroundScopes.remove(scopeID)
        invalidate(scopeID: scopeID)
    }

    /// Called only by a visible local confirmation action, never by an intent or remote request.
    public func consentToRequest(scopeID: UUID, requestID: UUID, capability: IOSNativeCapability,
                                 lifetime: TimeInterval = 60) throws -> IOSForegroundCapabilityConsent {
        try Task.checkCancellation()
        guard foregroundScopes.contains(scopeID) else { throw IOSForegroundCapabilityError.inactive }
        guard lifetime.isFinite, lifetime > 0, lifetime <= Self.maximumConsentLifetime else {
            throw IOSForegroundCapabilityError.invalidRequest
        }
        let now = monotonicUptime(), expiresAt = now + lifetime
        guard now.isFinite, now >= 0, expiresAt.isFinite, expiresAt > now else {
            throw IOSForegroundCapabilityError.invalidRequest
        }
        let seen = seenRequestIDs[scopeID, default: []]
        guard !seen.contains(requestID) else { throw IOSForegroundCapabilityError.requestChanged }
        guard seen.count < Self.maximumRequestsPerScope else { throw IOSForegroundCapabilityError.busy }
        prune(at: now)
        invalidate(scopeID: scopeID)
        guard consents.count < Self.maximumOutstandingConsents else { throw IOSForegroundCapabilityError.busy }
        seenRequestIDs[scopeID, default: []].insert(requestID)
        currentRequests[scopeID] = requestID
        let id = UUID()
        let calendarStart = Date()
        let requestLifetime = IOSForegroundCapabilityRequestLifetime(expiresAt: expiresAt,
                                                                      monotonicUptime: monotonicUptime)
        let request = IOSForegroundCapabilityRequest(capability: capability, calendarStart: calendarStart,
                                                      calendarEnd: calendarStart.addingTimeInterval(30 * 86_400),
                                                      lifetime: requestLifetime,
                                                      authorizeOperation: { [weak self] in
            guard let self else { throw IOSForegroundCapabilityError.consentMissing }
            try await self.authorize(consentID: id, scopeID: scopeID, requestID: requestID,
                                     capability: capability, expiresAt: expiresAt)
        })
        consents[id] = ConsentState(scopeID: scopeID, requestID: requestID, request: request,
                                    expiresAt: expiresAt, used: false)
        expiryTasks[id] = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(Int64((lifetime * 1_000).rounded(.up)))) } catch { return }
            await self?.expire(consentID: id, at: expiresAt)
        }
        return IOSForegroundCapabilityConsent(id: id)
    }

    public func revoke(scopeID: UUID) {
        foregroundScopes.remove(scopeID)
        invalidate(scopeID: scopeID)
        seenRequestIDs.removeValue(forKey: scopeID)
    }

    public func perform(consent: IOSForegroundCapabilityConsent, scopeID: UUID, requestID: UUID,
                        capability: IOSNativeCapability) async throws -> IOSForegroundCapabilityResult {
        let state = try begin(consent, scopeID: scopeID, requestID: requestID, capability: capability)
        let backend = self.backend
        let operation = Task {
            try await withTaskCancellationHandler {
                try await backend.perform(state.request)
            } onCancel: {
                state.request.cancelAuthorization()
            }
        }
        work[consent.id] = operation
        do {
            let outcome = try await withTaskCancellationHandler {
                try await operation.value
            } onCancel: {
                operation.cancel()
                Task { await self.invalidate(consentID: consent.id) }
            }
            try validateAfterAwait(consent, state: state)
            complete(consent.id)
            switch outcome {
            case .empty:
                throw IOSForegroundCapabilityError.empty
            case .value(let payload):
                let checked = try validate(payload, for: capability, request: state.request)
                return IOSForegroundCapabilityResult(capability: capability, payload: checked)
            }
        } catch {
            complete(consent.id)
            try validateAfterAwait(consent, state: state)
            if let known = error as? IOSForegroundCapabilityError { throw known }
            throw IOSForegroundCapabilityError.backendUnavailable
        }
    }

    private func begin(_ consent: IOSForegroundCapabilityConsent, scopeID: UUID, requestID: UUID,
                       capability: IOSNativeCapability) throws -> ConsentState {
        try Task.checkCancellation()
        guard foregroundScopes.contains(scopeID) else { throw IOSForegroundCapabilityError.inactive }
        guard var state = consents[consent.id] else { throw IOSForegroundCapabilityError.consentMissing }
        guard state.scopeID == scopeID, state.requestID == requestID, state.request.capability == capability,
              currentRequests[scopeID] == requestID else { throw IOSForegroundCapabilityError.requestChanged }
        guard monotonicUptime() < state.expiresAt else { throw IOSForegroundCapabilityError.consentExpired }
        guard !state.used else { throw IOSForegroundCapabilityError.alreadyUsed }
        guard active.count < Self.maximumConcurrentOperations else { throw IOSForegroundCapabilityError.busy }
        state.used = true
        consents[consent.id] = state
        active.insert(consent.id)
        return state
    }

    private func validateAfterAwait(_ consent: IOSForegroundCapabilityConsent, state: ConsentState) throws {
        try Task.checkCancellation()
        guard foregroundScopes.contains(state.scopeID) else { throw IOSForegroundCapabilityError.inactive }
        guard let live = consents[consent.id], live.used else { throw IOSForegroundCapabilityError.consentMissing }
        guard currentRequests[state.scopeID] == state.requestID else { throw IOSForegroundCapabilityError.requestChanged }
        guard monotonicUptime() < state.expiresAt else { throw IOSForegroundCapabilityError.consentExpired }
    }

    private func authorize(consentID: UUID, scopeID: UUID, requestID: UUID,
                           capability: IOSNativeCapability, expiresAt: TimeInterval) throws {
        try Task.checkCancellation()
        guard foregroundScopes.contains(scopeID) else { throw IOSForegroundCapabilityError.inactive }
        guard let live = consents[consentID], live.used,
              live.scopeID == scopeID, live.requestID == requestID,
              live.request.capability == capability, currentRequests[scopeID] == requestID else {
            throw IOSForegroundCapabilityError.consentMissing
        }
        guard monotonicUptime() < expiresAt else {
            work[consentID]?.cancel()
            throw IOSForegroundCapabilityError.consentExpired
        }
    }

    private func expire(consentID: UUID, at expiresAt: TimeInterval) {
        guard let state = consents[consentID], state.expiresAt == expiresAt,
              monotonicUptime() >= expiresAt else { return }
        state.request.cancelAuthorization()
        work[consentID]?.cancel()
    }

    private func complete(_ consentID: UUID) {
        work.removeValue(forKey: consentID)
        expiryTasks.removeValue(forKey: consentID)?.cancel()
        active.remove(consentID)
    }

    private func validate(_ payload: IOSForegroundCapabilityPayload, for capability: IOSNativeCapability,
                          request: IOSForegroundCapabilityRequest) throws -> IOSForegroundCapabilityPayload {
        switch (capability, payload) {
        case (.calendar, .calendar(let rows)):
            guard rows.count <= 10, rows.allSatisfy({ !$0.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                && $0.title.count <= 200 && $0.start >= request.calendarStart && $0.start <= request.calendarEnd
                && $0.start.timeIntervalSince1970.isFinite }) else { throw IOSForegroundCapabilityError.resultRejected }
            return .calendar(rows.sorted { $0.start < $1.start })
        case (.contacts, .contact(let name)):
            let safe = name.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !safe.isEmpty, safe.count <= 120 else { throw IOSForegroundCapabilityError.resultRejected }
            return .contact(name: safe)
        case (.location, .location(let latitude, let longitude)):
            guard let coordinate = IOSForegroundLocationPrecisionPolicy.rounded(latitude: latitude, longitude: longitude) else {
                throw IOSForegroundCapabilityError.resultRejected
            }
            return .location(latitude: coordinate.latitude, longitude: coordinate.longitude)
        case (.files, .file(let name, let bytes)):
            guard safeName(name), !bytes.isEmpty, bytes.count <= Self.maximumFileBytes,
                  String(data: bytes, encoding: .utf8) != nil, !bytes.contains(0) else { throw IOSForegroundCapabilityError.resultRejected }
            return .file(name: name, bytes: bytes)
        case (.photos, .photo(let jpeg)), (.camera, .cameraImage(let jpeg)):
            guard validJPEG(jpeg), jpeg.count <= Self.maximumImageBytes else { throw IOSForegroundCapabilityError.resultRejected }
            return payload
        case (.microphone, .microphone(let data, let duration, let sampleRate)):
            guard !data.isEmpty, data.count <= Self.maximumAudioBytes, duration.isFinite,
                  duration > 0, duration <= Self.maximumAudioDuration, data.count.isMultiple(of: 2),
                  sampleRate.isFinite, (8_000...48_000).contains(sampleRate),
                  abs(Double(data.count / 2) / sampleRate - duration) <= 0.05 else { throw IOSForegroundCapabilityError.resultRejected }
            return payload
        default:
            throw IOSForegroundCapabilityError.resultRejected
        }
    }

    private func safeName(_ name: String) -> Bool {
        !name.isEmpty && name.count <= 200 && !name.contains("/") && !name.contains("\\")
            && !name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) })
    }

    private func validJPEG(_ bytes: Data) -> Bool {
        guard bytes.count >= 4, bytes[0] == 0xFF, bytes[1] == 0xD8,
              bytes[bytes.count - 2] == 0xFF, bytes[bytes.count - 1] == 0xD9 else { return false }
        var index = 2
        var hasFrame = false
        while index < bytes.count - 2 {
            guard bytes[index] == 0xFF else { return false }
            while index < bytes.count, bytes[index] == 0xFF { index += 1 }
            guard index < bytes.count else { return false }
            let marker = bytes[index]
            index += 1
            if marker == 0xD9 { return hasFrame }
            if marker == 0xD8 || marker == 0x01 || (0xD0...0xD7).contains(marker) { continue }
            guard index + 1 < bytes.count else { return false }
            let segmentLength = Int(bytes[index]) << 8 | Int(bytes[index + 1])
            guard segmentLength >= 2, index + segmentLength <= bytes.count - 2 else { return false }
            if (0xC0...0xC3).contains(marker) || (0xC5...0xC7).contains(marker)
                || (0xC9...0xCB).contains(marker) || (0xCD...0xCF).contains(marker) {
                guard segmentLength >= 8 else { return false }
                let height = Int(bytes[index + 3]) << 8 | Int(bytes[index + 4])
                let width = Int(bytes[index + 5]) << 8 | Int(bytes[index + 6])
                guard (1...2_048).contains(width), (1...2_048).contains(height) else { return false }
                hasFrame = true
            }
            if marker == 0xDA { return hasFrame }
            index += segmentLength
        }
        return false
    }

    private func invalidate(scopeID: UUID) {
        currentRequests.removeValue(forKey: scopeID)
        for (id, _) in consents.filter({ $0.value.scopeID == scopeID }) {
            consents[id]?.request.cancelAuthorization()
            consents.removeValue(forKey: id)
            expiryTasks.removeValue(forKey: id)?.cancel()
            work[id]?.cancel()
        }
    }

    private func invalidate(consentID: UUID) {
        consents[consentID]?.request.cancelAuthorization()
        consents.removeValue(forKey: consentID)
        expiryTasks.removeValue(forKey: consentID)?.cancel()
    }

    private func prune(at now: TimeInterval) {
        for (id, _) in consents.filter({ now >= $0.value.expiresAt && !active.contains($0.key) }) {
            consents[id]?.request.cancelAuthorization()
            consents.removeValue(forKey: id)
            expiryTasks.removeValue(forKey: id)?.cancel()
        }
    }
}
