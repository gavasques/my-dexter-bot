import DexterHostClient
import Foundation
import Observation

/// The conversation and host generation that received the owner's new click. No credentials or persisted intent.
public struct McpAuthorizationContext: Equatable, Sendable {
    public let hostID: String
    public let botID: String
    public let threadID: String
    public let hostAddress: String
    public let composerScope: UUID
    public let hostGeneration: UInt64
    public let threadGeneration: UInt64
    public let readinessEpoch: UInt64

    public init(hostID: String, botID: String, threadID: String, hostAddress: String, composerScope: UUID,
                hostGeneration: UInt64, threadGeneration: UInt64, readinessEpoch: UInt64) {
        self.hostID = hostID; self.botID = botID; self.threadID = threadID; self.hostAddress = hostAddress
        self.composerScope = composerScope; self.hostGeneration = hostGeneration
        self.threadGeneration = threadGeneration; self.readinessEpoch = readinessEpoch
    }
}

public struct McpAuthorizationPresentation: Identifiable, Equatable, Sendable {
    public let id: UUID
    public let handoff: McpAuthorizationHandoff
    public let context: McpAuthorizationContext
}

/// App-wide, process-only eligibility. History, reloads and restart never arm this coordinator.
@MainActor @Observable public final class McpAuthorizationHandoffCoordinator {
    private struct Pending {
        let action: Action
        let context: McpAuthorizationContext
    }
    public private(set) var presentation: McpAuthorizationPresentation?
    @ObservationIgnored private var pending: [String: Pending] = [:]
    @ObservationIgnored private var consumed: Set<String> = []
    @ObservationIgnored private var launched: Set<String> = []
    @ObservationIgnored private let now: @MainActor () -> Int64
    public init(now: @escaping @MainActor () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1_000) }) { self.now = now }
    private func key(host: String, action: String) -> String { host + "\u{1F}" + action }

    /// Called before exactly one new local Allow request, while its chat is foreground. Never called by recovery reads.
    @discardableResult public func arm(_ action: Action, context: McpAuthorizationContext?, foreground: Bool) -> Bool {
        guard foreground, let context, action.state == .awaitingApproval,
              action.request.botId == context.botID, action.request.threadId == context.threadID,
              Self.isAuthorizationRequest(action), let expiry = action.approvalExpiresAt, expiry > now() else { return false }
        let id = key(host: context.hostID, action: action.id)
        guard !consumed.contains(id), pending[id] == nil, pending.count + consumed.count < 512 else { return false }
        pending[id] = Pending(action: action, context: context)
        return true
    }

    public static func isAuthorizationRequest(_ action: Action) -> Bool {
        guard action.request.tool == "dexter.harness.mcp.authorize", action.request.destination == "dexter-harness-owner-proposals",
              case .object(let input)? = action.request.arguments["input"],
              Set(input.keys).isSubset(of: ["serverId", "expectedInstancePin", "actionId"]),
              case .string(let server)? = input["serverId"], !server.isEmpty,
              server.range(of: "^[a-z](?:[a-z0-9-]{0,38}[a-z0-9])?$", options: .regularExpression) != nil,
              case .string(let pin)? = input["expectedInstancePin"], McpAuthorizationHandoff.validHash(pin) else { return false }
        if let value = input["actionId"] { guard case .string(let id) = value, !id.isEmpty else { return false } }
        return true
    }

    /// The original decision response or later exact action observation may finish an already armed intent.
    public func receive(_ action: Action, context: McpAuthorizationContext?, foreground: Bool) {
        guard let context else { invalidate(); return }
        let id = key(host: context.hostID, action: action.id)
        guard let original = pending[id] else { return }
        guard foreground, original.context == context,
              original.action.request == action.request, original.action.requestHash == action.requestHash,
              original.action.grantRevision == action.grantRevision else { pending.removeValue(forKey: id); return }
        guard action.state != .awaitingApproval && action.state != .ready && action.state != .running else { return }
        pending.removeValue(forKey: id)
        guard let handoff = action.mcpAuthorizationHandoff, handoff.hostId == context.hostID,
              handoff.expiresAt > now(), !consumed.contains(id), presentation == nil else { return }
        presentation = McpAuthorizationPresentation(id: UUID(), handoff: handoff, context: context)
    }

    /// Only the key main window may claim the sheet. Claim precedes all private calls and is never persisted/replayed.
    public func take(_ token: UUID, context: McpAuthorizationContext?, foreground: Bool) -> McpAuthorizationPresentation? {
        guard let request = presentation, request.id == token else { return nil }
        presentation = nil
        guard foreground, request.context == context, request.handoff.expiresAt > now() else { return nil }
        let id = key(host: request.context.hostID, action: request.handoff.actionId)
        guard consumed.insert(id).inserted else { return nil }
        return request
    }

    /// The same claimed sheet may be remounted by SwiftUI; it must never create a second private POST.
    public func claimLaunch(_ request: McpAuthorizationPresentation, context: McpAuthorizationContext?, foreground: Bool) -> Bool {
        let id = key(host: request.context.hostID, action: request.handoff.actionId)
        guard foreground, request.context == context, request.handoff.expiresAt > now(),
              consumed.contains(id), launched.insert(id).inserted else { return false }
        return true
    }

    public func abandon(actionID: String, hostID: String?) {
        guard let hostID else { return }
        pending.removeValue(forKey: key(host: hostID, action: actionID))
        if presentation?.handoff.actionId == actionID, presentation?.handoff.hostId == hostID { presentation = nil }
    }

    /// Context change or Stop abandons automatic presentation; receipts and credentials remain unchanged.
    public func invalidate() { pending = [:]; presentation = nil }
}

/// One private POST per mounted human intent. A failed opener retries the confirmed URL, never the POST.
@MainActor @Observable public final class McpOAuthLaunchSession {
    public enum Phase: Equatable, Sendable { case idle, starting, prepared, browserOpened, browserUnavailable, expired, failed, invalidated }
    public private(set) var phase: Phase = .idle
    public private(set) var authorization: McpOAuthAuthorization?
    public private(set) var mutationSent = false
    public let intentID = UUID()
    public private(set) var diagnostic: McpAuthenticationDiagnosticError?
    public private(set) var canMakeManualRetry = false
    @ObservationIgnored private let start: @MainActor () async throws -> McpOAuthAuthorization
    @ObservationIgnored private let open: @MainActor (URL) -> Bool
    @ObservationIgnored private let isCurrent: @MainActor () -> Bool
    @ObservationIgnored private let isForeground: @MainActor () -> Bool
    @ObservationIgnored private let now: @MainActor () -> Double
    @ObservationIgnored private let expiresAt: Int64?
    @ObservationIgnored private let serverID: String?
    @ObservationIgnored private var closed = false
    @ObservationIgnored private var manualRetryCreated = false
    public init(serverID: String? = nil, expiresAt: Int64? = nil, start: @escaping @MainActor () async throws -> McpOAuthAuthorization,
                open: @escaping @MainActor (URL) -> Bool, isCurrent: @escaping @MainActor () -> Bool,
                isForeground: @escaping @MainActor () -> Bool,
                now: @escaping @MainActor () -> Double = { Date().timeIntervalSince1970 * 1_000 }) {
        self.serverID = serverID; self.expiresAt = expiresAt; self.start = start; self.open = open
        self.isCurrent = isCurrent; self.isForeground = isForeground; self.now = now
    }
    private var valid: Bool { !closed && !Task.isCancelled && isCurrent() }
    /// The SDK invokes this immediately before entering transport, after any preflight awaits/serialization.
    public func assertMayDispatch() throws {
        guard valid, isForeground(), phase == .starting else { throw CancellationError() }
        guard expiresAt.map({ Double($0) > now() }) ?? true else { throw HostClientError.approvalExpired }
    }
    public func begin() async {
        await prepare()
        if phase == .prepared { continueInBrowser() }
    }
    /// The view releases its busy state before opening the confirmed link.
    public func prepare() async {
        guard phase == .idle, !mutationSent, valid, isForeground() else { return }
        guard expiresAt.map({ Double($0) > now() }) ?? true else { phase = .expired; return }
        mutationSent = true; phase = .starting
        do {
            let value = try await start()
            guard valid else { phase = .invalidated; return }
            guard value.expiresAt > now(), expiresAt.map({ Double($0) > now() }) ?? true else { phase = .expired; return }
            authorization = value
            phase = .prepared
        } catch {
            guard valid else { phase = .invalidated; return }
            if error as? HostClientError == .approvalExpired { phase = .expired; return }
            diagnostic = error as? McpAuthenticationDiagnosticError
            phase = .failed
        }
    }
    /// GET-only reconciliation of a *known response*, not of an ambiguous POST. A stale lastError cannot turn
    /// a lost ACK into a confirmed failure. The original pin must still be CAS-checked by each new manual POST.
    public func reconcileForManualRetry(_ credentials: McpCredentialStatus) {
        canMakeManualRetry = phase == .failed && diagnostic != nil && !manualRetryCreated && valid && serverID == credentials.serverId
            && credentials.auth == "oauth" && ["locked", "expired", "unauthorized", "unavailable"].contains(credentials.state)
    }
    /// One distinct human gesture consumes reconciliation. It never resets or replays the original intent.
    public func makeManualRetry(start replacement: (@MainActor () async throws -> McpOAuthAuthorization)? = nil) -> McpOAuthLaunchSession? {
        guard canMakeManualRetry, valid, isForeground() else { return nil }
        canMakeManualRetry = false
        manualRetryCreated = true
        return McpOAuthLaunchSession(serverID: serverID, start: replacement ?? start, open: open,
                                    isCurrent: isCurrent, isForeground: isForeground, now: now)
    }
    public func continueInBrowser() {
        guard valid, isForeground(), let authorization else { return }
        guard authorization.expiresAt > now(), expiresAt.map({ Double($0) > now() }) ?? true else {
            self.authorization = nil; phase = .expired; return
        }
        phase = open(authorization.authorizationUrl) ? .browserOpened : .browserUnavailable
    }
    public func invalidate() { closed = true; authorization = nil; canMakeManualRetry = false; phase = .invalidated }
}

/// Effective per-account custody only. Global custody configuration does not prove this account was persisted.
public enum McpOAuthPersistencePresentation {
    public static func message(_ persistence: ConnectionPersistence?, connected: Bool) -> String {
        guard connected else { return neutral }
        switch persistence {
        case .appKeychain: return String(localized: "A autorização desta conexão está guardada no cofre deste app e pode ser restaurada ao reiniciar o host.")
        case .hostPersistent: return String(localized: "A autorização desta conexão está guardada no armazenamento protegido do host.")
        case .volatileUntilHostRestart: return String(localized: "A autorização desta conexão está somente na memória do host. Depois de reiniciá-lo, entre novamente.")
        case .managedService, nil: return neutral
        }
    }
    private static var neutral: String {
        String(localized: "Autorize no seu navegador. A forma de guardar esta autorização ainda não foi confirmada para esta conexão.")
    }
}
