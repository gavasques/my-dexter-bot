import Foundation
import Security
import CryptoKit

public enum ClientIdentityFailure: String, Error, Sendable { case invalidInput, missing, incomplete, conflict, locked, unavailable, expired, policyUnconfirmed, pinMismatch, protocolError, timeout, cancelled, closed, outcomeUnknown, forbidden }
public enum ClientRole: String, Codable, Sendable, CaseIterable { case clientIOS = "client-ios", clientMac = "client-mac" }
public enum ClientScope: String, Codable, Sendable, CaseIterable {
    case chatRead = "chat.read", chatWrite = "chat.write", approvalsRead = "approvals.read", approvalsDecide = "approvals.decide"
    case devicesRead = "devices.read", devicesManage = "devices.manage", grantsRead = "grants.read", grantsManage = "grants.manage"
    /// Output folders of the base: read (status, ledger, listing, content) / manage (destination + receipts). Owner-granted only.
    case outputsRead = "outputs.read", outputsManage = "outputs.manage"
    /// Connections of the base: read (status, catalog, accounts, receipts, setup requests and their choices) / manage
    /// (managed sign-in through the provider link, bot access, label, disconnect, complete/cancel setup requests).
    /// Owner-granted only; credentials, project keys and native OAuth custody never cross the paired channel.
    case connectionsRead = "connections.read", connectionsManage = "connections.manage"
    /// Native MCP of the base: read (servers, tools, selections, public sign-in metadata, private inputs) / manage
    /// (answer a private input of a running action). Owner-granted only.
    case mcpRead = "mcp.read", mcpManage = "mcp.manage"
    /// The eight scopes that predate output folders. `allCases` also holds owner-granted-only scopes, so an "every scope"
    /// default/fixture names this list explicitly; nothing here grants or infers `outputs.*`, `connections.*` or `mcp.*`.
    public static let legacyPairing: [ClientScope] = [.chatRead, .chatWrite, .approvalsRead, .approvalsDecide, .devicesRead, .devicesManage, .grantsRead, .grantsManage]
}
func finiteID(_ value: String) -> Bool {
    !value.utf8.isEmpty && value.utf8.count <= 128 && value.utf8.allSatisfy { (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || [45,46,58,95].contains($0) }
    && value.utf8.first.map { (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) } == true
}
func fingerprintValid(_ value: String) -> Bool { value.utf8.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) } }
func sha256(_ bytes: Data) -> String { SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() }

/// Namespace selection is local storage addressing, never host authorization.
public struct ClientIdentityScope: Sendable, Equatable {
    public let installationID: String
    public let localBindingID: String
    public let hostFingerprint: String
    public let role: ClientRole
    public let tag: Data
    public let certificateLabel: String
    public init(installationID: String, localBindingID: String, role: ClientRole, hostFingerprint: String) throws {
        guard fingerprintValid(hostFingerprint), finiteID(installationID), localBindingID.utf8.count == 32,
              localBindingID.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else { throw ClientIdentityFailure.invalidInput }
        self.installationID = installationID; self.localBindingID = localBindingID; self.role = role; self.hostFingerprint = hostFingerprint
        let digest = sha256(Data("\(installationID)\n\(localBindingID)\n\(role.rawValue)\n\(hostFingerprint)".utf8))
        tag = Data("com.dexter.app-client-identity.v1.\(digest).private".utf8)
        certificateLabel = "com.dexter.app-client-identity.v1.\(digest).certificate"
    }
    public static func newLocalBindingID() -> String { UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased() }
}

/// Immutable Security handles, no private-key export API and no production ephemeral fallback.
public final class ClientNativeIdentity: @unchecked Sendable, CustomStringConvertible {
    let identity: SecIdentity
    public let certificateDER: Data
    public let fingerprint: String
    public let policy: String
    init(key: SecKey, certificate: SecCertificate, policy: String, now: Date = Date()) throws {
        guard let actualPublic = SecKeyCopyPublicKey(key), let certificatePublic = SecCertificateCopyKey(certificate),
              let a = SecKeyCopyExternalRepresentation(actualPublic, nil) as Data?,
              let b = SecKeyCopyExternalRepresentation(certificatePublic, nil) as Data?, a == b,
              let identity = SecIdentityCreate(nil, certificate, key) else { throw ClientIdentityFailure.conflict }
        certificateDER = SecCertificateCopyData(certificate) as Data
        try CertificateProfile.validate(certificateDER, usage: .client, now: now)
        self.identity = identity; fingerprint = sha256(certificateDER); self.policy = policy
    }
    public var description: String { "ClientNativeIdentity(publicFingerprint:\(fingerprint),policy:\(policy))" }
    static func ephemeralFixture(now: Date = Date()) throws -> ClientNativeIdentity {
        var error: Unmanaged<CFError>?
        guard let key = SecKeyCreateRandomKey([kSecAttrKeyType:kSecAttrKeyTypeECSECPrimeRandom,kSecAttrKeySizeInBits:256] as CFDictionary, &error) else { throw ClientIdentityFailure.unavailable }
        return try ClientNativeIdentity(key:key,certificate:ClientCertificate.make(key:key,label:"DexterClientSynthetic",now:now),policy:"ephemeral_memory_fixture",now:now)
    }
}
public protocol ClientIdentityStorage: Sendable {
    func load(_ scope: ClientIdentityScope) async throws -> ClientNativeIdentity?
    func provision(_ scope: ClientIdentityScope) async throws -> ClientNativeIdentity
}
public actor ClientIdentityLifecycle {
    public let scope: ClientIdentityScope
    private let storage: any ClientIdentityStorage
    public init(scope: ClientIdentityScope, storage: any ClientIdentityStorage) { self.scope = scope; self.storage = storage }
    public func loadOnly() async throws -> ClientNativeIdentity {
        guard let identity = try await storage.load(scope) else { throw ClientIdentityFailure.missing }
        try CertificateProfile.validate(identity.certificateDER,usage:.client,now:Date())
        return identity
    }
    public func provisionExplicitly() async throws -> ClientNativeIdentity {
        guard try await storage.load(scope) == nil else { throw ClientIdentityFailure.conflict }
        return try await storage.provision(scope)
    }
}
