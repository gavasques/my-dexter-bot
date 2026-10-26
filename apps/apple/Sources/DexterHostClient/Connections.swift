import Foundation
import CryptoKit
import DexterClientIdentity

// App connections (UX-P1-09), owner-loopback contract version 1. Mirrors `packages/contracts/src/connections.ts`.
// Connecting never grants a bot anything; bot access is a separate owner mutation with expected revision and receipt.
// Authorization links are transient; tokens, codes, verifiers, headers and provider keys never reach this client.

public enum ConnectionRouteKind: String, Codable, Sendable { case managed, directMCP = "direct_mcp" }
public struct ConnectionRoute: Codable, Equatable, Sendable {
    public let kind: ConnectionRouteKind
    /// Managed provider with an implemented Dexter adapter (closed set). Nil for the direct route.
    public let provider: String?
    public static let managedProviders: Set<String> = ["composio"]
    private enum CodingKeys: String, CodingKey { case kind, provider }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = try c.decode(ConnectionRouteKind.self, forKey: .kind)
        provider = try c.decodeIfPresent(String.self, forKey: .provider)
        switch kind {
        case .managed: guard let provider, Self.managedProviders.contains(provider) else { throw HostClientError.contractMismatch }
        case .directMCP: guard provider == nil else { throw HostClientError.contractMismatch }
        }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(kind, forKey: .kind); try c.encodeIfPresent(provider, forKey: .provider)
    }
}
public enum ConnectionToolEffect: String, Codable, Sendable { case read, write }
/// `providerVerified`: read from the provider's official identity endpoint with this account's authorized access (UX-P1-11).
/// `providerDisplayName`: provider label only, not a verified email. `unconfirmed`: the route exposes no identity.
public enum ConnectionIdentityConfirmation: String, Codable, Sendable { case providerVerified = "provider_verified", providerDisplayName = "provider_display_name", unconfirmed }
public enum ConnectionIdentityKind: String, Codable, Sendable { case email, username, workspace, tenant, displayName = "display_name" }
public enum ConnectionIdentitySource: String, Codable, Sendable { case identityEndpoint = "identity_endpoint", providerLabel = "provider_label" }
public enum ConnectionPlatformState: String, Codable, Sendable { case unconfigured, available, unavailable }
public struct ConnectionToolSummary: Codable, Equatable, Sendable, Identifiable {
    public let name: String, description: String
    public let effect: ConnectionToolEffect
    public var id: String { name }
}
public struct ConnectionAvailability: Codable, Equatable, Sendable {
    public enum State: String, Codable, Sendable { case available, unavailable }
    public enum Reason: String, Codable, Sendable { case platformUnconfigured = "platform_unconfigured", platformUnavailable = "platform_unavailable", noEligibleProfile = "no_eligible_profile" }
    public let state: State
    public let reason: Reason?
}
public struct ConnectionCatalogEntry: Codable, Equatable, Sendable, Identifiable {
    public enum Verification: String, Codable, Sendable { case unproven, proven }
    public let serviceId: String, displayName: String, description: String
    public let route: ConnectionRoute
    public let authorization: String
    public let identity: ConnectionIdentityConfirmation
    public let tools: [ConnectionToolSummary]
    /// `unproven`: no recorded real login + authorized operation for this integration. Not "Disponível" for release.
    public let verification: Verification
    public let availability: ConnectionAvailability
    public var id: String { serviceId }
    var isValid: Bool {
        connectionServiceIDIsValid(serviceId) && connectionTextIsValid(displayName, max: 80) && description.count <= 280 && authorization == "oauth_link"
            && (1...32).contains(tools.count) && Set(tools.map(\.name)).count == tools.count
            && tools.allSatisfy { connectionToolNameIsValid($0.name) && connectionTextIsValid($0.description, max: 280) }
            && (availability.state == .available) == (availability.reason == nil)
    }
}
public struct ConnectionCatalog: Codable, Equatable, Sendable {
    public enum Freshness: String, Codable, Sendable { case fresh, stale, never }
    public let version: Int, hostId: String
    public let platform: ConnectionPlatformState
    public let revision: Int
    public let pin: String?
    public let fetchedAt: Int64?
    public let freshness: Freshness
    public let services: [ConnectionCatalogEntry]
    var isValid: Bool {
        version == 1 && connectionHostIDIsValid(hostId) && revision >= 0 && services.count <= 64 && Set(services.map(\.serviceId)).count == services.count
            && services.allSatisfy(\.isValid) && (pin.map(connectionHashIsValid) ?? true)
            && ((revision == 0) == (pin == nil)) && ((freshness == .never) == (pin == nil)) && (fetchedAt.map { $0 >= 0 } ?? true)
    }
}

public enum ConnectionAuthorizationState: String, Codable, Sendable {
    case starting, awaitingUser = "awaiting_user", verifying, connected, failed, expired, cancelled, mismatch, unknown
    public var isTerminal: Bool { [.connected, .failed, .expired, .cancelled, .mismatch].contains(self) }
}
public enum ConnectionAuthorizationReason: String, Codable, Sendable {
    case userCancelled = "user_cancelled", providerFailed = "provider_failed", providerRefused = "provider_refused", linkExpired = "link_expired"
    case accountMismatch = "account_mismatch", outcomeUnknown = "outcome_unknown", catalogChanged = "catalog_changed"
    case platformUnavailable = "platform_unavailable", notStarted = "not_started", linkNotRecoverable = "link_not_recoverable"
}
public enum ConnectionAuthorizationCallbackState: String, Codable, Sendable { case none, returned, cancelled }
public struct ConnectionAuthorization: Codable, Equatable, Sendable, Identifiable {
    public let version: Int, hostId: String, id: String, clientRequestId: String, requestHash: String, serviceId: String
    public let route: ConnectionRoute
    public let catalogRevision: Int, catalogPin: String, profileId: String
    public let state: ConnectionAuthorizationState
    public let reason: ConnectionAuthorizationReason?
    /// Transient official authorization page (host memory only). Present only while awaiting the owner.
    public let authorizationURL: String?
    public let linkAvailable: Bool
    public let expiresAt: Int64?
    public let callback: ConnectionAuthorizationCallbackState
    public let accountId: String?, replacesAccountId: String?
    /// The bot's setup request this login was started for, when correlated (grants nothing by itself).
    public let setupRequestId: String?
    public let createdAt: Int64, updatedAt: Int64
    /// Opens only an https page; never a custom scheme, credentials or fragment.
    public var authorizationPage: URL? {
        guard state == .awaitingUser, linkAvailable, let authorizationURL, let url = URL(string: authorizationURL),
              url.scheme == "https", url.user == nil, url.password == nil, url.fragment == nil else { return nil }
        return url
    }
    var isValid: Bool {
        version == 1 && connectionHostIDIsValid(hostId) && id.range(of: "^auth_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", options: .regularExpression) != nil
            && connectionRequestIDIsValid(clientRequestId) && connectionHashIsValid(requestHash) && connectionServiceIDIsValid(serviceId)
            && catalogRevision >= 0 && connectionHashIsValid(catalogPin) && !profileId.isEmpty && profileId.utf8.count <= 128
            && (authorizationURL == nil || (linkAvailable && state == .awaitingUser)) && (linkAvailable == (authorizationURL != nil))
            && (state == .connected) == (accountId != nil) && (accountId.map(connectionAccountIDIsValid) ?? true)
            && (replacesAccountId.map(connectionAccountIDIsValid) ?? true) && createdAt >= 0 && updatedAt >= createdAt
            && (setupRequestId.map(connectionWorkflowIDIsValid) ?? true)
    }
}
/// Owner request. Nil fields are encoded as explicit JSON null (the host contract requires every key).
public struct StartConnectionAuthorizationInput: Encodable, Equatable, Sendable {
    public let expectedHostID: String, clientRequestId: String, serviceId: String, catalogPin: String
    public let profileId: String?, label: String?, replacesAccountId: String?
    /// The awaiting setup request this login answers (optional key: omitted, never null, when absent).
    public let setupRequestId: String?
    public init(catalog: ConnectionCatalog, serviceId: String, clientRequestId: String = UUID().uuidString.lowercased(),
                profileId: String? = nil, label: String? = nil, replacesAccountId: String? = nil, setupRequestId: String? = nil) {
        expectedHostID = catalog.hostId; self.clientRequestId = clientRequestId; self.serviceId = serviceId; catalogPin = catalog.pin ?? ""
        self.profileId = profileId; self.label = label; self.replacesAccountId = replacesAccountId; self.setupRequestId = setupRequestId
    }
    private enum CodingKeys: String, CodingKey { case expectedHostID, clientRequestId, serviceId, catalogPin, profileId, label, replacesAccountId, setupRequestId }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(expectedHostID, forKey: .expectedHostID); try c.encode(clientRequestId, forKey: .clientRequestId)
        try c.encode(serviceId, forKey: .serviceId); try c.encode(catalogPin, forKey: .catalogPin)
        try c.encode(profileId, forKey: .profileId); try c.encode(label, forKey: .label); try c.encode(replacesAccountId, forKey: .replacesAccountId)
        try c.encodeIfPresent(setupRequestId, forKey: .setupRequestId)
    }
    var isValid: Bool {
        connectionHostIDIsValid(expectedHostID) && connectionRequestIDIsValid(clientRequestId) && connectionServiceIDIsValid(serviceId)
            && connectionHashIsValid(catalogPin) && (profileId.map { !$0.isEmpty && $0.utf8.count <= 128 } ?? true)
            && (label.map { connectionTextIsValid($0, max: 80) } ?? true) && (replacesAccountId.map(connectionAccountIDIsValid) ?? true)
            && (setupRequestId.map(connectionWorkflowIDIsValid) ?? true)
    }
    /// Same canonical object the host hashes: `setupRequestId` is part of it only when present.
    var requestHash: String? {
        var object: [String: Any] = ["expectedHostID": expectedHostID, "clientRequestId": clientRequestId, "serviceId": serviceId, "catalogPin": catalogPin,
                                     "profileId": profileId as Any? ?? NSNull(), "label": label as Any? ?? NSNull(), "replacesAccountId": replacesAccountId as Any? ?? NSNull()]
        if let setupRequestId { object["setupRequestId"] = setupRequestId }
        return connectionCanonicalHash(object)
    }
}
public struct ConnectionAuthorizationCallbackInput: Encodable, Equatable, Sendable {
    public enum Outcome: String, Encodable, Sendable { case returned, cancelled }
    public let expectedHostID: String
    public let outcome: Outcome
    public let providerAccountRef: String?
    public init(hostID: String, outcome: Outcome, providerAccountRef: String? = nil) {
        expectedHostID = hostID; self.outcome = outcome; self.providerAccountRef = providerAccountRef
    }
    private enum CodingKeys: String, CodingKey { case expectedHostID, outcome, providerAccountRef }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(expectedHostID, forKey: .expectedHostID); try c.encode(outcome, forKey: .outcome); try c.encode(providerAccountRef, forKey: .providerAccountRef)
    }
    var isValid: Bool {
        connectionHostIDIsValid(expectedHostID) && (providerAccountRef.map { $0.range(of: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$", options: .regularExpression) != nil } ?? true)
    }
}

/// `identityMismatch`: the provider now verifies another identity behind this account; it was stopped (reconnect to continue).
public enum ConnectionAccountStatus: String, Codable, Sendable {
    case connected, needsReconnect = "needs_reconnect", disconnecting, disconnected, replaced, identityMismatch = "identity_mismatch", unknown
}
public enum ConnectionBotAccessState: String, Codable, Sendable { case enabled, disabled, partial }
public struct ConnectionBotAccess: Codable, Equatable, Sendable, Identifiable {
    public let botId: String
    /// Derived by the host from the hub grants of every pinned tool: the grant authority, not a cached flag.
    public let access: ConnectionBotAccessState
    /// Exact tools this bot may use on this account now, from the current valid grants. Nil = not reported (unknown),
    /// never "all" and never "none".
    public let toolNames: [String]?
    public var id: String { botId }
}
public struct ConnectionUpstreamDisconnect: Codable, Equatable, Sendable {
    public enum Upstream: String, Codable, Sendable { case notRequested = "not_requested", deleted, alreadyAbsent = "already_absent", unknown }
    public enum Revocation: String, Codable, Sendable { case notRequested = "not_requested", requested, unknown }
    public let upstream: Upstream
    /// `requested`: the provider started a revocation job it does not let us poll. Never shown as confirmed.
    public let revocation: Revocation
}
public struct ConnectionAccountIdentity: Codable, Equatable, Sendable {
    public let confirmation: ConnectionIdentityConfirmation
    /// Verified value or provider label (see `confirmation`/`kind`). Never derived from the owner's label, alias or ids.
    public let value: String?
    public let kind: ConnectionIdentityKind?
    public let source: ConnectionIdentitySource?
    /// Direct OAuth: validated authorization-server issuer (who issued the tokens) — not the account identity.
    public let issuer: String?
    public let checkedAt: Int64?
    var isConsistent: Bool {
        switch confirmation {
        case .unconfirmed: return value == nil && kind == nil && source == nil
        case .providerDisplayName: return value != nil && kind == .displayName && source == .providerLabel
        case .providerVerified: return value != nil && kind != nil && kind != .displayName && source == .identityEndpoint
        }
    }
}
/// `appKeychain`: native OAuth tokens confirmed in this app's Data Protection Keychain custody (UX-P1-10).
public enum ConnectionPersistence: String, Codable, Sendable {
    case managedService = "managed_service", volatileUntilHostRestart = "volatile_until_host_restart", appKeychain = "app_keychain", hostPersistent = "host_persistent"
}
public enum ConnectionManagement: String, Codable, Sendable { case connections, nativeMCP = "native_mcp" }
public struct ConnectionAccountTool: Codable, Equatable, Sendable {
    public let name: String
    public let effect: ConnectionToolEffect
    /// Published manifest hash of this pinned tool, when the host reports it.
    public let manifestHash: String?
}
public struct ConnectionAccount: Codable, Equatable, Sendable, Identifiable {
    public let version: Int, hostId: String, id: String, serviceId: String, displayName: String
    public let route: ConnectionRoute
    public let label: String
    public let identity: ConnectionAccountIdentity
    public let status: ConnectionAccountStatus
    public let statusCheckedAt: Int64?
    public let persistence: ConnectionPersistence
    /// `nativeMCP`: read-only projection; operations stay on the native MCP routes (`nativeServerId`).
    public let manage: ConnectionManagement
    public let nativeServerId: String?
    public let revision: Int
    public let profileId: String?
    public let tools: [ConnectionAccountTool]
    public let bots: [ConnectionBotAccess]
    public let previousAccountId: String?
    /// Gateway destinations of this account: map an action's `destination` to the account used.
    public let gatewayConnectionIds: [String]
    public let identityChanged: Bool?
    public let disconnect: ConnectionUpstreamDisconnect?
    public let createdAt: Int64, updatedAt: Int64
    var isValid: Bool {
        guard version == 1, connectionHostIDIsValid(hostId), connectionAccountIDIsValid(id), connectionTextIsValid(displayName, max: 80),
              connectionTextIsValid(label, max: 80), revision >= 0, tools.count <= 32, bots.count <= 500, Set(bots.map(\.botId)).count == bots.count,
              identity.value.map({ connectionTextIsValid($0, max: 254) }) ?? true, identity.isConsistent, gatewayConnectionIds.count <= 32,
              identity.issuer.map({ connectionTextIsValid($0, max: 2048) && URL(string: $0)?.scheme.map { ["https", "http"].contains($0) } == true }) ?? true,
              previousAccountId.map(connectionAccountIDIsValid) ?? true, createdAt >= 0,
              tools.allSatisfy({ $0.manifestHash.map(connectionHashIsValid) ?? true }),
              bots.allSatisfy({ bot in bot.toolNames.map { names in names.count <= 32 && Set(names).count == names.count
                  && Set(names).isSubset(of: Set(tools.map(\.name))) } ?? true }) else { return false }
        switch manage {
        case .connections: return id.hasPrefix("acct_") && route.kind == .managed && persistence == .managedService && nativeServerId == nil && profileId != nil && revision >= 1
            && identity.issuer == nil
        case .nativeMCP: return id.hasPrefix("mcp_") && route.kind == .directMCP && persistence != .managedService && nativeServerId != nil && id == "mcp_\(nativeServerId!)" && bots.isEmpty
        }
    }
}
public struct ConnectionAccounts: Codable, Equatable, Sendable {
    public let version: Int, hostId: String
    public let items: [ConnectionAccount]
}
public struct SetConnectionBotAccessInput: Encodable, Equatable, Sendable {
    public let expectedHostID: String, clientRequestId: String
    public let expectedRevision: Int
    public let botId: String
    public let enabled: Bool
    /// Exact pinned tools of THIS account the bot may use (sorted); every other tool of the account becomes deny. Nil keeps
    /// the legacy meaning (every tool pinned now). Never a wildcard for tools pinned later.
    public let toolNames: [String]?
    public init(account: ConnectionAccount, botId: String, enabled: Bool, toolNames: [String]? = nil, clientRequestId: String = UUID().uuidString.lowercased()) {
        expectedHostID = account.hostId; self.clientRequestId = clientRequestId; expectedRevision = account.revision; self.botId = botId; self.enabled = enabled
        self.toolNames = enabled ? toolNames.map { Array(Set($0)).sorted() } : nil
    }
    private enum CodingKeys: String, CodingKey { case expectedHostID, clientRequestId, expectedRevision, botId, enabled, toolNames }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(expectedHostID, forKey: .expectedHostID); try c.encode(clientRequestId, forKey: .clientRequestId)
        try c.encode(expectedRevision, forKey: .expectedRevision); try c.encode(botId, forKey: .botId); try c.encode(enabled, forKey: .enabled)
        try c.encodeIfPresent(toolNames, forKey: .toolNames)
    }
    var isValid: Bool {
        connectionHostIDIsValid(expectedHostID) && connectionRequestIDIsValid(clientRequestId) && expectedRevision >= 1 && expectedRevision < 9_007_199_254_740_991
            && connectionRequestIDIsValid(botId)
            && (toolNames.map { !$0.isEmpty && $0.count <= 32 && Set($0).count == $0.count && $0.allSatisfy(connectionToolNameIsValid) } ?? true)
    }
    /// Same canonical object the host hashes (`{id, ...input}`): `toolNames` only when present.
    func requestHash(accountID: String) -> String? {
        var object: [String: Any] = ["id": accountID, "expectedHostID": expectedHostID, "clientRequestId": clientRequestId, "expectedRevision": expectedRevision,
                                     "botId": botId, "enabled": enabled]
        if let toolNames { object["toolNames"] = toolNames }
        return connectionCanonicalHash(object)
    }
}
public struct DisconnectConnectionAccountInput: Encodable, Equatable, Sendable {
    public let expectedHostID: String, clientRequestId: String
    public let expectedRevision: Int
    public init(account: ConnectionAccount, clientRequestId: String = UUID().uuidString.lowercased()) {
        expectedHostID = account.hostId; self.clientRequestId = clientRequestId; expectedRevision = account.revision
    }
    var isValid: Bool {
        connectionHostIDIsValid(expectedHostID) && connectionRequestIDIsValid(clientRequestId) && expectedRevision >= 1 && expectedRevision < 9_007_199_254_740_991
    }
    func requestHash(accountID: String) -> String? {
        connectionCanonicalHash(["id": accountID, "expectedHostID": expectedHostID, "clientRequestId": clientRequestId, "expectedRevision": expectedRevision])
    }
}
public struct SetConnectionLabelInput: Encodable, Equatable, Sendable {
    public let expectedHostID: String, clientRequestId: String
    public let expectedRevision: Int
    public let label: String
    public init(account: ConnectionAccount, label: String, clientRequestId: String = UUID().uuidString.lowercased()) {
        expectedHostID = account.hostId; self.clientRequestId = clientRequestId; expectedRevision = account.revision; self.label = label
    }
    var isValid: Bool {
        connectionHostIDIsValid(expectedHostID) && connectionRequestIDIsValid(clientRequestId) && expectedRevision >= 1 && expectedRevision < 9_007_199_254_740_991
            && connectionTextIsValid(label, max: 80)
    }
    func requestHash(accountID: String) -> String? {
        connectionCanonicalHash(["id": accountID, "expectedHostID": expectedHostID, "clientRequestId": clientRequestId, "expectedRevision": expectedRevision, "label": label])
    }
}
public struct ConnectionReceipt: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable { case access, disconnect, label }
    public struct Access: Codable, Equatable, Sendable {
        public let botId: String; public let enabled: Bool; public let tools: Int
        /// The exact tools of the request, when it named them.
        public let toolNames: [String]?
    }
    public let version: Int, hostId: String, clientRequestId: String
    public let kind: Kind
    public let accountId: String, requestHash: String
    public let previousRevision: Int, revision: Int
    /// Terminal outcome of an access request, from the host's recovery. Absent (historical receipts) means applied.
    /// `notApplied`: no grant was committed (revision stays the previous one). `superseded`: the grants were committed but
    /// the account or a grant changed since; recovery repeats nothing and does not bump the revision.
    public enum AccessOutcome: String, Codable, Sendable { case applied, notApplied = "not_applied", superseded }
    public let accessOutcome: AccessOutcome?
    public let access: Access?
    public let disconnect: ConnectionUpstreamDisconnect?
    public let label: String?
    public let createdAt: Int64
    /// The outcome an access receipt states (absent = applied). Only `applied` means the requested access is in place.
    public var effectiveAccessOutcome: AccessOutcome { accessOutcome ?? .applied }
    func matches(accountID: String, input: SetConnectionLabelInput) -> Bool {
        version == 1 && kind == .label && hostId == input.expectedHostID && clientRequestId == input.clientRequestId && accountId == accountID
            && requestHash == input.requestHash(accountID: accountID) && previousRevision == input.expectedRevision && revision == input.expectedRevision + 1
            && accessOutcome == nil && access == nil && disconnect == nil && label == input.label && createdAt >= 0
    }
    /// The receipt of exactly this access request, in any terminal outcome. Each outcome has its own revision rule:
    /// applied = previous + 1; not applied = previous, zero tools; superseded = the account's current revision (never below
    /// the previous one). The original bot, enabled flag and exact tool names are always the request's.
    func matches(accountID: String, input: SetConnectionBotAccessInput) -> Bool {
        guard version == 1, kind == .access, hostId == input.expectedHostID, clientRequestId == input.clientRequestId, accountId == accountID,
              requestHash == input.requestHash(accountID: accountID), previousRevision == input.expectedRevision,
              let access, access.botId == input.botId, access.enabled == input.enabled, (0...32).contains(access.tools),
              disconnect == nil, label == nil, createdAt >= 0, input.toolNames.map({ $0 == access.toolNames }) ?? true else { return false }
        switch effectiveAccessOutcome {
        case .applied: return revision == input.expectedRevision + 1
        case .notApplied: return revision == input.expectedRevision && access.tools == 0
        case .superseded: return revision >= input.expectedRevision
        }
    }
    func matches(accountID: String, input: DisconnectConnectionAccountInput) -> Bool {
        version == 1 && kind == .disconnect && hostId == input.expectedHostID && clientRequestId == input.clientRequestId && accountId == accountID
            && requestHash == input.requestHash(accountID: accountID) && previousRevision == input.expectedRevision && revision >= input.expectedRevision + 1
            && accessOutcome == nil && access == nil && disconnect != nil && label == nil && createdAt >= 0
    }
    /// Public form of `matches` for the editor's GET reconciliation of the same access request.
    public func isReceipt(of input: SetConnectionBotAccessInput, accountID: String) -> Bool { matches(accountID: accountID, input: input) }
}
public struct ConnectionsStatus: Codable, Equatable, Sendable {
    public enum Direct: String, Codable, Sendable { case nativeMCP = "native_mcp", unconfigured }
    public enum NativeOAuthPersistence: String, Codable, Sendable { case volatile, persistent, unconfigured }
    public let version: Int, hostId: String
    public let platform: ConnectionPlatformState
    public let managedProviders: [String]
    public let direct: Direct
    /// `volatile`: native OAuth tokens are lost when the host restarts (durable custody UX-P1-10 not delivered).
    public let nativeOAuthPersistence: NativeOAuthPersistence
    public let openAuthorizations: Int
    var isValid: Bool {
        version == 1 && connectionHostIDIsValid(hostId) && managedProviders.allSatisfy(ConnectionRoute.managedProviders.contains)
            && (platform == .unconfigured) == managedProviders.isEmpty && (0...10_000).contains(openAuthorizations)
    }
}

extension HostClient {
    /// Owner loopback, or a paired client granted `connections.read`.
    public func connectionsStatus() async throws -> ConnectionsStatus {
        try requireConnections(.connectionsRead)
        let value: ConnectionsStatus = try await request("/v1/connections/status", timeout: 15, localAttachmentRequest: true)
        guard value.isValid else { throw HostClientError.contractMismatch }; return value
    }
    public func connectionsCatalog() async throws -> ConnectionCatalog {
        try requireConnections(.connectionsRead)
        let value: ConnectionCatalog = try await request("/v1/connections/catalog", timeout: 30, localAttachmentRequest: true)
        guard value.isValid else { throw HostClientError.contractMismatch }; return value
    }
    /// One provider write per `clientRequestId`. Any doubt is `mutationOutcomeUnknown`: read `connectionAuthorization`, never re-send blindly.
    public func startConnectionAuthorization(_ input: StartConnectionAuthorizationInput) async throws -> ConnectionAuthorization {
        try requireConnections(.connectionsManage)
        guard input.isValid, let hash = input.requestHash else { throw HostClientError.invalidRequest }
        let value: ConnectionAuthorization = try await connectionsMutation("/v1/connections/authorizations", method: "POST", body: input)
        guard value.isValid, value.hostId == input.expectedHostID, value.clientRequestId == input.clientRequestId, value.requestHash == hash,
              value.serviceId == input.serviceId, value.catalogPin == input.catalogPin, value.replacesAccountId == input.replacesAccountId,
              value.setupRequestId == input.setupRequestId,
              input.profileId.map({ $0 == value.profileId }) ?? true else { throw HostClientError.mutationOutcomeUnknown }
        return value
    }
    /// Read-only reconciliation with the provider through the host. Never creates another authorization.
    public func connectionAuthorization(clientRequestID: String) async throws -> ConnectionAuthorization {
        try requireConnections(.connectionsManage)
        guard connectionRequestIDIsValid(clientRequestID) else { throw HostClientError.invalidRequest }
        let value: ConnectionAuthorization = try await request("/v1/connections/authorizations/\(connectionPathSegment(clientRequestID))", timeout: 30, localAttachmentRequest: true)
        guard value.isValid, value.clientRequestId == clientRequestID else { throw HostClientError.contractMismatch }; return value
    }
    /// Owner signal that the official page returned or was cancelled. A hint to verify; never proof and never a grant.
    public func reportConnectionAuthorization(clientRequestID: String, _ input: ConnectionAuthorizationCallbackInput) async throws -> ConnectionAuthorization {
        try requireConnections(.connectionsManage)
        guard connectionRequestIDIsValid(clientRequestID), input.isValid else { throw HostClientError.invalidRequest }
        let value: ConnectionAuthorization = try await connectionsMutation("/v1/connections/authorizations/\(connectionPathSegment(clientRequestID))/callback", method: "POST", body: input)
        guard value.isValid, value.clientRequestId == clientRequestID, value.hostId == input.expectedHostID else { throw HostClientError.mutationOutcomeUnknown }
        return value
    }
    public func connectionAccounts() async throws -> ConnectionAccounts {
        try requireConnections(.connectionsRead)
        let value: ConnectionAccounts = try await request("/v1/connections/accounts", timeout: 15, localAttachmentRequest: true)
        guard value.version == 1, connectionHostIDIsValid(value.hostId), value.items.count <= 200, Set(value.items.map(\.id)).count == value.items.count,
              value.items.allSatisfy({ $0.isValid && $0.hostId == value.hostId }) else { throw HostClientError.contractMismatch }
        return value
    }
    /// Live status read through the host (provider read for managed accounts).
    public func connectionAccount(id: String) async throws -> ConnectionAccount {
        try requireConnections(.connectionsRead)
        guard connectionAccountIDIsValid(id) else { throw HostClientError.invalidRequest }
        let value: ConnectionAccount = try await request("/v1/connections/accounts/\(connectionPathSegment(id))", timeout: 30, localAttachmentRequest: true)
        guard value.isValid, value.id == id else { throw HostClientError.contractMismatch }; return value
    }
    /// Owner CAS on the account revision. Enabling grants `ask` on every pinned tool; the bot's approval mode still applies.
    public func setConnectionBotAccess(accountID: String, _ input: SetConnectionBotAccessInput) async throws -> ConnectionReceipt {
        try requireConnections(.connectionsManage)
        guard connectionAccountIDIsValid(accountID), accountID.hasPrefix("acct_"), input.isValid else { throw HostClientError.invalidRequest }
        let value: ConnectionReceipt = try await connectionsMutation("/v1/connections/accounts/\(connectionPathSegment(accountID))/access", method: "PATCH", body: input)
        guard value.matches(accountID: accountID, input: input) else { throw HostClientError.mutationOutcomeUnknown }; return value
    }
    /// Owner display name (CAS + receipt). The name engines see stays fixed at confirmation (service · identity).
    public func setConnectionLabel(accountID: String, _ input: SetConnectionLabelInput) async throws -> ConnectionReceipt {
        try requireConnections(.connectionsManage)
        guard connectionAccountIDIsValid(accountID), accountID.hasPrefix("acct_"), input.isValid else { throw HostClientError.invalidRequest }
        let value: ConnectionReceipt = try await connectionsMutation("/v1/connections/accounts/\(connectionPathSegment(accountID))/label", method: "PATCH", body: input)
        guard value.matches(accountID: accountID, input: input) else { throw HostClientError.mutationOutcomeUnknown }; return value
    }
    /// Local revocation first, then one provider delete. An unknown outcome is settled by reading the account (no receipt until then).
    public func disconnectConnectionAccount(accountID: String, _ input: DisconnectConnectionAccountInput) async throws -> ConnectionReceipt {
        try requireConnections(.connectionsManage)
        guard connectionAccountIDIsValid(accountID), accountID.hasPrefix("acct_"), input.isValid else { throw HostClientError.invalidRequest }
        let value: ConnectionReceipt = try await connectionsMutation("/v1/connections/accounts/\(connectionPathSegment(accountID))/disconnect", method: "POST", body: input)
        guard value.matches(accountID: accountID, input: input) else { throw HostClientError.mutationOutcomeUnknown }; return value
    }
    /// Original receipt of an access/disconnect request. Nil means unconfirmed, never "did not happen".
    public func connectionReceipt(clientRequestID: String) async throws -> ConnectionReceipt? {
        try requireConnections(.connectionsRead)
        guard connectionRequestIDIsValid(clientRequestID) else { throw HostClientError.invalidRequest }
        do {
            let value: ConnectionReceipt = try await request("/v1/connections/receipts/\(connectionPathSegment(clientRequestID))", timeout: 15, localAttachmentRequest: true)
            guard value.version == 1, value.clientRequestId == clientRequestID, connectionAccountIDIsValid(value.accountId), connectionHashIsValid(value.requestHash) else {
                throw HostClientError.contractMismatch
            }
            return value
        } catch HostClientError.notFound { return nil }
    }

    /// Owner loopback, or a paired client whose owner-granted scopes include `scope` (the paired router checks it again).
    func requireConnections(_ scope: ClientScope) throws {
        switch accessPolicy {
        case .loopbackDevelopment: return
        case .pairedHost(let binding): guard binding.scopes.contains(scope) else { throw HostClientError.forbidden }
        case .unpairedHost: throw HostClientError.forbidden
        }
    }
    /// What this client may do with the base's connections, from its access policy alone (the host remains the authority).
    public var connectionsAccess: (read: Bool, manage: Bool, mcpRead: Bool, mcpManage: Bool) {
        switch accessPolicy {
        case .loopbackDevelopment: (true, true, true, true)
        case .pairedHost(let binding):
            (binding.scopes.contains(.connectionsRead), binding.scopes.contains(.connectionsManage),
             binding.scopes.contains(.mcpRead), binding.scopes.contains(.mcpManage))
        case .unpairedHost: (false, false, false, false)
        }
    }
    func connectionsMutation<Value: Decodable & Sendable>(_ path: String, method: String, body: any Encodable) async throws -> Value {
        do { return try await request(path, method: method, body: body, timeout: 45, localAttachmentRequest: true, connectionMutationErrors: true) }
        catch is CancellationError { throw HostClientError.mutationOutcomeUnknown }
        catch let error as HostClientError {
            // 503 includes the host's `outcome_unknown`: read the original request instead of sending it again.
            switch error { case .offline, .hostFailure, .contractMismatch, .notReady: throw HostClientError.mutationOutcomeUnknown; default: throw error }
        }
    }
}

func connectionPathSegment(_ value: String) -> String {
    let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~")
    return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
}
func connectionHostIDIsValid(_ value: String) -> Bool {
    !value.isEmpty && value.utf8.count <= 128 && !value.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
}
private func connectionRequestIDIsValid(_ value: String) -> Bool { value.range(of: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$", options: .regularExpression) != nil }
func connectionServiceIDIsValid(_ value: String) -> Bool { value.range(of: "^[a-z][a-z0-9_-]{0,63}$", options: .regularExpression) != nil }
func connectionToolNameIsValid(_ value: String) -> Bool { value.range(of: "^[a-z][a-z0-9_.-]{1,127}$", options: .regularExpression) != nil }
func connectionHashIsValid(_ value: String) -> Bool { value.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil }
func connectionAccountIDIsValid(_ value: String) -> Bool {
    value.range(of: "^(acct_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|mcp_[a-z]([a-z0-9-]{0,38}[a-z0-9])?)$", options: .regularExpression) != nil
}
private func connectionTextIsValid(_ value: String, max: Int) -> Bool {
    !value.isEmpty && value.utf16.count <= max && !value.unicodeScalars.contains { $0.value < 0x20 || (0x7f...0x9f).contains($0.value) }
}
/// Same canonical form as the host (`sortedKeys`, no slash escaping), so request hashes bind receipts to this exact request.
private func connectionCanonicalHash(_ value: [String: Any]) -> String? {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes]) else { return nil }
    return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}
