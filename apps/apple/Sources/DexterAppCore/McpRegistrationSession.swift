import DexterHostClient
import Foundation
import Observation

/// Immutable local projection. It preserves the original namespace/body and never grants dispatch authority.
public struct McpDeferredRegistration: Identifiable, Equatable, Sendable {
    public let namespace: McpRegistrationNamespace
    public let request: McpRegistrationRequest
    public let state: McpRegistrationSession.State
    public let registration: McpRegistrationObservation?
    public let originalReceipt: McpRegistrationReceipt?
    public let lastFailure: McpRegistrationSession.Failure?
    public var id: String { request.requestID }
    public var isUnresolved: Bool { [.submitting, .unknown, .legacyUnavailable].contains(state) }
}

public enum McpRegistrationLifecycleError: Error, Equatable, Sendable {
    case operationInFlight, mutationAlreadySent, notPrepared, noUncertainAttempt, historyFull, instanceStillUncertain
}

/// Retained, owner-local technical state. Closing a sheet does not discard its original request.
/// No disk journal, automatic mutation replay, account/login, discovery or grants.
@MainActor @Observable public final class McpRegistrationSession {
    public enum State: Equatable, Sendable { case idle, prepared, submitting, registered, removed, replaced, unknown, rejected, legacyUnavailable }
    public enum Failure: Equatable, Sendable { case invalidRequest, forbidden, conflict, legacyHost, unavailable, contractMismatch, outcomeUnknown, scopeChanged }
    public let namespace: McpRegistrationNamespace
    public let contextScope: UUID
    public private(set) var request: McpRegistrationRequest?
    public private(set) var registration: McpRegistrationObservation?
    public private(set) var state: State = .idle
    public private(set) var lastFailure: Failure?
    public private(set) var busy = false
    public private(set) var mutationSent = false
    public private(set) var invalidated = false
    public static let deferredLimit = 32
    public private(set) var deferredRegistrations: [McpDeferredRegistration] = []
    public private(set) var readingDeferredRequestID: String?
    @ObservationIgnored private let client: HostClient
    @ObservationIgnored private let isCurrent: @MainActor () -> Bool
    @ObservationIgnored private var acknowledgedReceipt: McpRegistrationReceipt?

    init(namespace: McpRegistrationNamespace, contextScope: UUID, client: HostClient,
         previous: McpRegistrationSession? = nil, isCurrent: @escaping @MainActor () -> Bool) {
        self.namespace = namespace; self.contextScope = contextScope; self.client = client; self.isCurrent = isCurrent
        if let previous, previous.namespace == namespace {
            // Value snapshots only. Old callbacks cannot update this new window's retained list or input.
            deferredRegistrations = previous.deferredRegistrations
            if let request = previous.request {
                self.request = request; mutationSent = previous.mutationSent
                acknowledgedReceipt = previous.acknowledgedReceipt
                // A new window may only read an already-sent intention; it cannot restart its dispatcher.
                state = mutationSent ? .unknown : .prepared
            }
        }
    }
    /// Pure rendering fact. Host/context generations are monotonic; checking a view never mutates observation state.
    public var scopeMatches: Bool { !invalidated && isCurrent() }
    /// Call from explicit operations or the UI's scope-change hook, never from body/computed rendering properties.
    @discardableResult public func invalidateIfScopeChanged() -> Bool {
        if !invalidated && !isCurrent() { invalidated = true }
        return invalidated
    }
    public var deferredRemaining: Int { Self.deferredLimit - deferredRegistrations.count }
    public func hasUnresolvedDeferred(serverID: String) -> Bool {
        deferredRegistrations.contains { $0.namespace == namespace && $0.request.serverID == serverID && $0.isUnresolved }
    }
    /// Clears only an intention which has never sent a POST. No rollback/cancel/absence assertion.
    public func discardPrepared() throws {
        try checkScope()
        guard !busy else { throw McpRegistrationLifecycleError.operationInFlight }
        guard !mutationSent else { throw McpRegistrationLifecycleError.mutationAlreadySent }
        guard state == .prepared, request != nil else { throw McpRegistrationLifecycleError.notPrepared }
        clearCurrentIntention()
    }
    /// Human decision to stop local monitoring for now. Keeps the original uncertain effect and blocks its instance ID.
    @discardableResult public func deferUncertainMonitoring() throws -> String {
        try checkScope()
        guard !busy else { throw McpRegistrationLifecycleError.operationInFlight }
        guard mutationSent, requiresReconciliation, let original = request else { throw McpRegistrationLifecycleError.noUncertainAttempt }
        guard deferredRegistrations.count < Self.deferredLimit else { throw McpRegistrationLifecycleError.historyFull }
        deferredRegistrations.append(McpDeferredRegistration(namespace: namespace, request: original, state: state,
            registration: registration, originalReceipt: acknowledgedReceipt, lastFailure: lastFailure))
        clearCurrentIntention()
        return original.requestID
    }
    private func clearCurrentIntention() {
        request = nil; registration = nil; acknowledgedReceipt = nil; mutationSent = false
        state = .idle; lastFailure = nil
    }
    public var originalReceipt: McpRegistrationReceipt? { acknowledgedReceipt }
    public var requiresReconciliation: Bool { mutationSent && [.submitting, .unknown, .legacyUnavailable].contains(state) }
    public func begin(httpDraft: McpHttpDraft) throws { try setRequest(McpRegistrationRequest(httpDraft: httpDraft)) }
    public func begin(definition: JSONValue) throws { try setRequest(McpRegistrationRequest(definition: definition)) }
    /// Deliberately starts a manual registration from reviewed import metadata, not an import-provenance authority.
    public func beginReviewedImport(definition: JSONValue) throws { try begin(definition: McpRegistrationRequest.reviewedImport(definition)) }
    private func setRequest(_ original: McpRegistrationRequest) throws {
        try checkScope()
        guard !busy, !requiresReconciliation, state != .prepared else { throw HostClientError.conflict }
        guard !hasUnresolvedDeferred(serverID: original.serverID) else { throw McpRegistrationLifecycleError.instanceStillUncertain }
        request = original; registration = nil; acknowledgedReceipt = nil; mutationSent = false
        state = .prepared; lastFailure = nil
    }
    private func checkScope() throws {
        invalidateIfScopeChanged()
        guard scopeMatches, !Task.isCancelled else { throw HostClientError.forbidden }
    }
    /// Verify public installation+owner at the captured base before EACH endpoint operation and after the health read.
    private func verifyNamespace() async throws {
        try checkScope()
        let health = try await client.health()
        try checkScope()
        let current = try McpRegistrationNamespace(baseURL: client.baseURL, health: health)
        guard current == namespace else { invalidated = true; throw HostClientError.forbidden }
    }
    public func submit() async {
        invalidateIfScopeChanged()
        guard !busy, scopeMatches, request != nil else { return }
        if mutationSent { await reconcile(); return }
        guard state == .prepared, let original = request else { return }
        busy = true; defer { busy = false }
        do { try await verifyNamespace() }
        catch { lastFailure = scopeMatches ? Self.failure(error) : .scopeChanged; return }
        var definitiveRefusal: HostClientError?
        do {
            try checkScope(); state = .submitting; mutationSent = true
            let receipt = try await client.registerMcpServer(original, namespace: namespace)
            try checkScope(); acknowledgedReceipt = receipt
        } catch {
            state = .unknown; lastFailure = scopeMatches ? Self.failure(error) : .scopeChanged
            guard scopeMatches, !Task.isCancelled else { return }
            if let refusal = error as? HostClientError, [.invalidRequest, .forbidden, .conflict].contains(refusal) {
                definitiveRefusal = refusal
            }
        }
        // Exactly ONE bounded read after an ACK or failure. No mutation replay, even when the read fails.
        do {
            try await readOriginal(original)
            if registration == nil, let definitiveRefusal {
                state = .rejected; lastFailure = Self.failure(definitiveRefusal)
            }
        } catch {
            lastFailure = scopeMatches ? Self.failure(error) : .scopeChanged
            state = scopeMatches && (error as? HostClientError) == .notFound ? .legacyUnavailable : .unknown
        }
    }
    public func reconcile() async {
        invalidateIfScopeChanged()
        guard !busy, scopeMatches, let original = request, mutationSent else { return }
        busy = true; defer { busy = false }
        do { try await readOriginal(original) }
        catch {
            lastFailure = scopeMatches ? Self.failure(error) : .scopeChanged
            state = scopeMatches && (error as? HostClientError) == .notFound ? .legacyUnavailable : .unknown
        }
    }
    /// Reads a preserved original key at its namespace; never activates it, replaces current input or resubmits it.
    public func reconcileDeferred(requestID: String) async {
        invalidateIfScopeChanged()
        guard !busy, scopeMatches,
              let index = deferredRegistrations.firstIndex(where: { $0.id == requestID && $0.namespace == namespace }) else { return }
        let original = deferredRegistrations[index]
        busy = true; readingDeferredRequestID = requestID
        defer { busy = false; readingDeferredRequestID = nil }
        // A previous observation cannot stand in for a fresh one while the explicit read is unresolved.
        deferredRegistrations[index] = McpDeferredRegistration(namespace: namespace, request: original.request, state: .unknown,
            registration: nil, originalReceipt: original.originalReceipt, lastFailure: nil)
        do {
            try await verifyNamespace(); try checkScope()
            let value = try await client.mcpRegistrationReceipt(original.request, namespace: original.namespace)
            try checkScope()
            if let receipt = original.originalReceipt, let value, value.receipt != receipt { throw HostClientError.contractMismatch }
            let next: State
            switch value?.instanceState { case .registered?: next = .registered; case .removed?: next = .removed; case .replaced?: next = .replaced; case nil: next = .unknown }
            deferredRegistrations[index] = McpDeferredRegistration(namespace: namespace, request: original.request, state: next,
                registration: value, originalReceipt: value?.receipt ?? original.originalReceipt,
                lastFailure: value == nil ? .outcomeUnknown : nil)
        } catch {
            deferredRegistrations[index] = McpDeferredRegistration(namespace: namespace, request: original.request,
                state: scopeMatches && (error as? HostClientError) == .notFound ? .legacyUnavailable : .unknown,
                registration: nil, originalReceipt: original.originalReceipt,
                lastFailure: scopeMatches ? Self.failure(error) : .scopeChanged)
        }
    }
    private func readOriginal(_ original: McpRegistrationRequest) async throws {
        registration = nil; state = .unknown
        try await verifyNamespace()
        try checkScope()
        let value = try await client.mcpRegistrationReceipt(original, namespace: namespace)
        try checkScope()
        guard request == original else { throw HostClientError.contractMismatch }
        guard let value else {
            // Receipt absence never authorizes a retry, including immediately after an uncertain POST.
            registration = nil; state = .unknown; lastFailure = .outcomeUnknown; return
        }
        if let acknowledgedReceipt, acknowledgedReceipt != value.receipt { throw HostClientError.contractMismatch }
        acknowledgedReceipt = value.receipt; registration = value; lastFailure = nil
        switch value.instanceState { case .registered: state = .registered; case .removed: state = .removed; case .replaced: state = .replaced }
    }
    private static func failure(_ error: any Error) -> Failure {
        switch error as? HostClientError {
        case .invalidRequest: .invalidRequest
        case .forbidden, .remotePairingUnavailable: .forbidden
        case .conflict: .conflict
        case .notFound: .legacyHost
        case .notReady: .unavailable
        case .contractMismatch: .contractMismatch
        default: .outcomeUnknown
        }
    }
}
