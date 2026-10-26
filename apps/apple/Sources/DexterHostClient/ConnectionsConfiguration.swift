import Foundation
import CryptoKit

// Owner-private configuration of the trusted connections service (Conectar apps). Mirrors
// `packages/contracts/src/connections-configuration.ts` (version 1). METADATA only: the installation capability never
// crosses this API; it lives in the app's Keychain custody and reaches the host only over the owned private pipe.
// Saving is not connecting: `runtime` says what the running host composed; connectivity is `/v1/connections/status`.

public let connectionsPlatformCredentialRef = "connections-platform"
public enum ConnectionsRuntimeState: String, Codable, Sendable {
    case inactive, active, restartRequired = "restart_required", configuredExternally = "configured_externally"
}
public enum ConnectionsRuntimeReason: String, Codable, Sendable {
    case disabled, privateChannelUnavailable = "private_channel_unavailable", requiresMcpEngines = "requires_mcp_engines"
    case exclusiveUpstream = "exclusive_upstream", originBoundToOtherConnections = "origin_bound_to_other_connections"
    case configurationUnavailable = "configuration_unavailable"
}
public enum ConnectionsCustodyChannel: String, Codable, Sendable { case appPrivateChannel = "app_private_channel", unavailable }
public enum ConnectionsCustodyState: String, Codable, Sendable { case absent, ready, locked }
public enum ConnectionsPrivateOperation: String, Codable, Sendable { case set, lock }
public enum ConnectionsPrivateOutcome: String, Codable, Sendable { case ready, locked, refused }

public struct ConnectionsConfiguration: Codable, Equatable, Sendable {
    public let revision: Int
    public let generation: Int
    public let origin: String?
    public let enabled: Bool
    public let credentialRef: String
    public let updatedAt: Int64?
    public var isValid: Bool {
        memoryBackendRevision(revision) && memoryBackendRevision(generation) && credentialRef == connectionsPlatformCredentialRef
            && (!enabled || origin != nil) && (origin.map { (try? connectionsPlatformOrigin($0)) == $0 } ?? true) && (updatedAt.map { $0 >= 0 } ?? true)
    }
}
public struct ConnectionsRuntimeStatus: Codable, Equatable, Sendable {
    public let state: ConnectionsRuntimeState
    public let reason: ConnectionsRuntimeReason?
    public let origin: String?
    public let generation: Int?
    public var isValid: Bool {
        guard origin.map({ (try? connectionsPlatformOrigin($0)) == $0 }) ?? true, generation.map(memoryBackendRevision) ?? true else { return false }
        switch state {
        case .active: return reason == nil && origin != nil && generation != nil
        case .inactive: return reason != nil && origin == nil && generation == nil
        case .configuredExternally: return reason == nil && generation == nil
        case .restartRequired: return reason == nil
        }
    }
}
public struct ConnectionsCustodyStatus: Codable, Equatable, Sendable {
    public let channel: ConnectionsCustodyChannel
    public let state: ConnectionsCustodyState
    public let generation: Int?
    public var isValid: Bool { (channel == .appPrivateChannel || state == .absent) && (state == .ready) == (generation != nil) && (generation.map(memoryBackendRevision) ?? true) }
}
public struct ConnectionsPrivateRequestStatus: Codable, Equatable, Sendable {
    public let requestId: String
    public let operation: ConnectionsPrivateOperation
    public let generation: Int
    public let state: ConnectionsPrivateOutcome
}
public struct ConnectionsConfigurationStatus: Codable, Equatable, Sendable {
    public let version: Int
    public let hostId: String
    public let ownerId: String
    public let configuration: ConnectionsConfiguration
    public let runtime: ConnectionsRuntimeStatus
    public let custody: ConnectionsCustodyStatus
    public let privateRequest: ConnectionsPrivateRequestStatus?
    public var isValid: Bool {
        version == 1 && memoryBackendID(hostId) && memoryBackendID(ownerId) && configuration.isValid && runtime.isValid && custody.isValid
            && (privateRequest.map { memoryBackendUUID($0.requestId) && memoryBackendRevision($0.generation) } ?? true)
    }
    /// The exact scope a capability is accepted for right now (the running service), or nil.
    public var activeCredentialScope: (origin: String, generation: Int)? {
        guard runtime.state == .active, let origin = runtime.origin, let generation = runtime.generation else { return nil }
        return (origin, generation)
    }
}
public struct ConnectionsConfigurationInput: Encodable, Equatable, Sendable {
    public let expectedHostId: String
    public let clientRequestId: String
    public let expectedRevision: Int
    public let origin: String?
    public let enabled: Bool
    public let renewCredential: Bool
    public init(expectedHostId: String, clientRequestId: String, expectedRevision: Int, origin: String?, enabled: Bool, renewCredential: Bool) throws {
        guard memoryBackendID(expectedHostId), clientRequestId.range(of: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$", options: .regularExpression) != nil,
              memoryBackendRevision(expectedRevision), expectedRevision < 9_007_199_254_740_991,
              !enabled || origin != nil, !renewCredential || origin != nil else { throw HostClientError.invalidRequest }
        self.expectedHostId = expectedHostId; self.clientRequestId = clientRequestId; self.expectedRevision = expectedRevision
        self.origin = try origin.map(connectionsPlatformOrigin); self.enabled = enabled; self.renewCredential = renewCredential
    }
    private enum CodingKeys: String, CodingKey { case expectedHostId, clientRequestId, expectedRevision, origin, enabled, renewCredential }
    /// Explicit `null` origin: the host hashes the exact canonical body, so absence and null must not differ.
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(expectedHostId, forKey: .expectedHostId); try c.encode(clientRequestId, forKey: .clientRequestId)
        try c.encode(expectedRevision, forKey: .expectedRevision); try c.encode(origin, forKey: .origin)
        try c.encode(enabled, forKey: .enabled); try c.encode(renewCredential, forKey: .renewCredential)
    }
    /// SHA-256 of the canonical sorted-key JSON body, as recorded by the host receipt.
    public var requestHash: String? {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        guard let bytes = try? encoder.encode(self) else { return nil }
        return SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }
}
public struct ConnectionsConfigurationReceipt: Codable, Equatable, Sendable {
    public let hostId: String
    public let ownerId: String
    public let clientRequestId: String
    public let requestHash: String
    public let previousRevision: Int
    public let previousGeneration: Int
    public let configuration: ConnectionsConfiguration
    public let restartRequired: Bool
    public let committedAt: Int64
    public func matches(_ input: ConnectionsConfigurationInput, ownerID: String) -> Bool {
        hostId == input.expectedHostId && ownerId == ownerID && clientRequestId == input.clientRequestId && previousRevision == input.expectedRevision
            && configuration.isValid && configuration.revision == previousRevision + 1 && configuration.origin == input.origin && configuration.enabled == input.enabled
            && configuration.generation >= previousGeneration && committedAt >= 0 && configuration.updatedAt == committedAt && requestHash == input.requestHash
    }
}
public struct ConnectionsConfigurationResult: Decodable, Sendable {
    public let receipt: ConnectionsConfigurationReceipt
    public let status: ConnectionsConfigurationStatus
}

/// Same closed rule as the host: exact `https://<lowercase dns name>`, no port, path, query, credentials or IP literal.
public func connectionsPlatformOrigin(_ value: String) throws -> String {
    guard (10...300).contains(value.utf8.count), let c = URLComponents(string: value), c.scheme == "https", c.user == nil, c.password == nil,
          c.port == nil, c.query == nil, c.fragment == nil, c.path.isEmpty, let host = c.host, value == "https://" + host else { throw HostClientError.invalidRequest }
    let labels = host.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
    guard host.utf8.count <= 253, labels.count >= 2, host != "localhost", !host.hasSuffix(".localhost"),
          labels.last.map({ $0.range(of: "^[0-9]+$", options: .regularExpression) == nil }) == true,
          labels.allSatisfy({ $0.range(of: "^(?!-)[a-z0-9-]{1,63}(?<!-)$", options: .regularExpression) != nil }) else { throw HostClientError.invalidRequest }
    return value
}

extension HostClient {
    /// Owner loopback only (a paired client is refused before any byte).
    public func connectionsConfigurationStatus() async throws -> ConnectionsConfigurationStatus {
        guard case .loopbackDevelopment = accessPolicy else { throw HostClientError.forbidden }
        let value: ConnectionsConfigurationStatus = try await request("/v1/connections/platform-configuration", timeout: 15,
                                                                       cachePolicy: .reloadIgnoringLocalCacheData, localAttachmentRequest: true)
        guard value.isValid else { throw HostClientError.contractMismatch }; return value
    }
    /// CAS + receipt. Any doubt (transport, cancellation, foreign body) is `mutationOutcomeUnknown`: read the receipt, never resend.
    public func updateConnectionsConfiguration(_ input: ConnectionsConfigurationInput, ownerID: String) async throws -> ConnectionsConfigurationResult {
        guard case .loopbackDevelopment = accessPolicy else { throw HostClientError.forbidden }
        let value: ConnectionsConfigurationResult
        do { value = try await request("/v1/connections/platform-configuration", method: "PUT", body: input, timeout: 15, localAttachmentRequest: true) }
        catch is CancellationError { throw HostClientError.mutationOutcomeUnknown }
        catch let error as HostClientError { switch error { case .offline, .hostFailure, .contractMismatch: throw HostClientError.mutationOutcomeUnknown; default: throw error } }
        guard value.receipt.matches(input, ownerID: ownerID), value.status.isValid,
              value.status.configuration == value.receipt.configuration else { throw HostClientError.mutationOutcomeUnknown }
        return value
    }
    /// GET only. nil = unconfirmed (never "did not happen").
    public func connectionsConfigurationReceipt(_ input: ConnectionsConfigurationInput, ownerID: String) async throws -> ConnectionsConfigurationReceipt? {
        guard case .loopbackDevelopment = accessPolicy else { throw HostClientError.forbidden }
        do {
            let value: ConnectionsConfigurationReceipt = try await request("/v1/connections/platform-configuration/receipts/\(input.clientRequestId)", timeout: 15,
                                                                           cachePolicy: .reloadIgnoringLocalCacheData, localAttachmentRequest: true)
            guard value.matches(input, ownerID: ownerID) else { throw HostClientError.contractMismatch }
            return value
        } catch HostClientError.notFound { return nil }
    }
}
