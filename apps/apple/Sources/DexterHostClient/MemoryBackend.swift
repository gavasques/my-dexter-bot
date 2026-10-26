import Foundation
import CryptoKit

public enum MemoryBackendState: String, Codable, Sendable {
    case disabled, privateUnlockRequired = "private_unlock_required", configuredUnverified = "configured_unverified"
    case restartRequired = "restart_required", configuredExternally = "configured_externally"
}
public enum MemoryBackendPrivateOperation: String, Codable, Sendable { case create, unlock, lock }
public struct MemoryBackendSettings: Codable, Equatable, Sendable {
    public let revision: Int
    public let origin: String?
    public let enabled: Bool
    public let updatedAt: Int64?
    public var isValid: Bool { memoryBackendRevision(revision) && (!enabled || origin != nil) && (origin.map { (try? memoryBackendOrigin($0)) == $0 } ?? true) && (updatedAt.map { $0 >= 0 } ?? true) }
}
public struct MemoryBackendPrivateRequestStatus: Codable, Equatable, Sendable {
    public let requestId: String
    public let operation: MemoryBackendPrivateOperation
    public let revision: Int
    public let state: String
}
public struct MemoryBackendStatus: Codable, Equatable, Sendable {
    public let backend: String
    public let settings: MemoryBackendSettings
    public let state: MemoryBackendState
    public let scope: String
    public let administrativeOperations: String
    public let semanticRecall: String
    public let externalServiceOwned: Bool
    public let privateRequest: MemoryBackendPrivateRequestStatus?
    public let generation: Int
    public var isValid: Bool {
        backend == "openviking" && settings.isValid && scope == "host_owned_account_per_bot_users"
        && administrativeOperations == "owner_local_only" && semanticRecall == "unproven" && !externalServiceOwned && memoryBackendRevision(generation)
        && (privateRequest.map { memoryBackendUUID($0.requestId) && memoryBackendRevision($0.revision) && $0.revision > 0 && ["pending","dispatched","unknown","ready","locked","refused"].contains($0.state) } ?? true)
    }
}
public struct MemoryBackendSettingsInput: Codable, Equatable, Sendable {
    public let expectedHostId: String
    public let clientRequestId: String
    public let expectedRevision: Int
    public let origin: String
    public let enabled: Bool
    public init(expectedHostId: String, clientRequestId: String, expectedRevision: Int, origin: String, enabled: Bool) throws {
        guard memoryBackendID(expectedHostId), memoryBackendID(clientRequestId), memoryBackendRevision(expectedRevision), expectedRevision < 9_007_199_254_740_991 else { throw HostClientError.invalidRequest }
        self.expectedHostId = expectedHostId; self.clientRequestId = clientRequestId; self.expectedRevision = expectedRevision
        self.origin = try memoryBackendOrigin(origin); self.enabled = enabled
    }
}
public struct MemoryBackendSettingReceipt: Codable, Equatable, Sendable {
    public let hostId: String
    public let ownerId: String
    public let clientRequestId: String
    public let requestHash: String
    public let previousRevision: Int
    public let settings: MemoryBackendSettings
    public let committedAt: Int64
    public func matches(_ input: MemoryBackendSettingsInput, ownerID: String) -> Bool {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        guard hostId == input.expectedHostId, ownerId == ownerID, clientRequestId == input.clientRequestId,
              previousRevision == input.expectedRevision, settings.isValid, settings.revision == previousRevision+1,
              settings.origin == input.origin, settings.enabled == input.enabled, committedAt >= 0, settings.updatedAt == committedAt,
              let bytes = try? encoder.encode(input) else { return false }
        return requestHash == SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }
}
public struct MemoryBackendSettingsResult: Decodable, Sendable {
    public let receipt: MemoryBackendSettingReceipt
    public let status: MemoryBackendStatus
}
private struct MemoryBackendReceiptResponse: Decodable { let receipt: MemoryBackendSettingReceipt? }
public func memoryBackendUUID(_ value: String) -> Bool { value.range(of: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", options: .regularExpression) != nil }
public func memoryBackendID(_ value: String) -> Bool { value.range(of: "^[A-Za-z0-9_.:-]{1,128}$", options: .regularExpression) != nil }
public func memoryBackendRevision(_ value: Int) -> Bool { value >= 0 && value <= 9_007_199_254_740_991 }
/// Same closed origin policy as the host: HTTPS origin or explicit HTTP IP-loopback port, optional trailing slash.
public func memoryBackendOrigin(_ value: String) throws -> String {
    guard !value.isEmpty, value.utf8.count <= 512, value.range(of: "[?#@\\\\\\s]", options: .regularExpression) == nil,
          let c = URLComponents(string: value), c.user == nil, c.password == nil, c.query == nil, c.fragment == nil,
          c.path.isEmpty || c.path == "/", let scheme = c.scheme, let host = c.host, !host.isEmpty,
          c.port.map({ $0 > 0 && $0 <= 65535 }) ?? true,
          scheme == "https" || scheme == "http" && ["127.0.0.1","[::1]","::1"].contains(host) && c.port != nil && c.port != 80 else { throw HostClientError.invalidRequest }
    let normalizedHost = host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host.lowercased()
    let port = c.port == 443 && scheme == "https" ? nil : c.port
    let origin = scheme + "://" + normalizedHost + (port.map { ":\($0)" } ?? "")
    guard value == origin || value == origin + "/" else { throw HostClientError.invalidRequest }; return origin
}
extension HostClient {
    public func memoryBackendStatus() async throws -> MemoryBackendStatus {
        guard case .loopbackDevelopment = accessPolicy else { throw HostClientError.forbidden }
        let value: MemoryBackendStatus = try await request("/v1/memory-backend/status", timeout: 15, localAttachmentRequest: true)
        guard value.isValid else { throw HostClientError.contractMismatch }; return value
    }
    public func updateMemoryBackendSettings(_ input: MemoryBackendSettingsInput, ownerID: String) async throws -> MemoryBackendSettingsResult {
        guard case .loopbackDevelopment = accessPolicy else { throw HostClientError.forbidden }
        let value: MemoryBackendSettingsResult
        do { value = try await request("/v1/memory-backend/settings", method: "PATCH", body: input, timeout: 15, localAttachmentRequest: true) }
        catch is CancellationError { throw HostClientError.mutationOutcomeUnknown }
        catch let error as HostClientError { switch error { case .offline, .hostFailure, .contractMismatch: throw HostClientError.mutationOutcomeUnknown; default: throw error } }
        guard value.receipt.matches(input, ownerID: ownerID), value.status.isValid,
              value.status.settings == value.receipt.settings else { throw HostClientError.mutationOutcomeUnknown }; return value
    }
    public func memoryBackendSettingReceipt(_ input: MemoryBackendSettingsInput, ownerID: String) async throws -> MemoryBackendSettingReceipt? {
        guard case .loopbackDevelopment = accessPolicy else { throw HostClientError.forbidden }
        let response: MemoryBackendReceiptResponse = try await request("/v1/memory-backend/receipts/\(input.clientRequestId)", timeout: 15, localAttachmentRequest: true)
        let value = response.receipt
        if let value, !value.matches(input, ownerID: ownerID) { throw HostClientError.contractMismatch }; return value
    }
}
