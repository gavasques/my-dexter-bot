import Foundation
import Security
import CryptoKit

public enum IdentityFailure: String, Error, Sendable { case invalidInput, missing, conflict, unavailable, locked, signingIdentityUnavailable, nonExportabilityUnconfirmed, pinMismatch, protocolError, timeout, cancelled }

/// A trusted host-selected installation, not a deviceId or authority asserted by a request body.
public struct IdentityScope: Sendable, Equatable {
    public let installationID: String
    public let tag: Data
    public let certificateLabel: String
    public let laboratory: Bool
    public init(installationID: String, laboratoryID: String? = nil) throws {
        guard installationID.range(of: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$", options: .regularExpression) != nil else { throw IdentityFailure.invalidInput }
        if let laboratoryID, laboratoryID.range(of: "^[0-9a-f]{32}$", options: .regularExpression) == nil { throw IdentityFailure.invalidInput }
        self.installationID = installationID; laboratory = laboratoryID != nil
        let digest = SHA256.hash(data: Data(installationID.utf8)).map { String(format: "%02x", $0) }.joined()
        let prefix = laboratoryID.map { "com.dexter.device-identity.lab.\($0).v1" } ?? "com.dexter.device-identity.v1"
        tag = Data("\(prefix).\(digest).private".utf8)
        certificateLabel = "\(prefix).\(digest).certificate"
    }
}

/// Immutable Security references are shared only with the private URLSession delegate. No key export API.
public final class NativeIdentity: @unchecked Sendable, CustomStringConvertible {
    let identity: SecIdentity
    let certificate: SecCertificate
    public let certificateDER: Data
    public let fingerprint: String
    public let policy: String
    init(key: SecKey, certificate: SecCertificate, policy: String) throws {
        // Exact certificate-to-key binding by public key bytes before any SecIdentity is formed.
        guard let actualPublic = SecKeyCopyPublicKey(key), let certificatePublic = SecCertificateCopyKey(certificate),
              let a = SecKeyCopyExternalRepresentation(actualPublic, nil) as Data?, let b = SecKeyCopyExternalRepresentation(certificatePublic, nil) as Data?, a == b,
              let identity = SecIdentityCreate(nil, certificate, key) else { throw IdentityFailure.conflict }
        self.identity = identity; self.certificate = certificate
        certificateDER = SecCertificateCopyData(certificate) as Data
        fingerprint = SHA256.hash(data: certificateDER).map { String(format: "%02x", $0) }.joined()
        self.policy = policy
    }
    public var description: String { "NativeIdentity(\(fingerprint),\(policy))" }
    public var certificatePEM: String {
        let b64 = certificateDER.base64EncodedString()
        return "-----BEGIN CERTIFICATE-----\n" + stride(from: 0, to: b64.count, by: 64).map { offset in
            let from = b64.index(b64.startIndex, offsetBy: offset), to = b64.index(from, offsetBy: min(64, b64.count-offset))
            return String(b64[from..<to])
        }.joined(separator: "\n") + "\n-----END CERTIFICATE-----\n"
    }
    static func ephemeralFixture(now: Date = Date()) throws -> NativeIdentity {
        var error: Unmanaged<CFError>?
        guard let key = SecKeyCreateRandomKey([kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom, kSecAttrKeySizeInBits: 256] as CFDictionary, &error) else { throw IdentityFailure.unavailable }
        let certificate = try ClientCertificate.make(key: key, label: "DexterSynthetic", now: now)
        return try NativeIdentity(key: key, certificate: certificate, policy: "ephemeral_fixture_only")
    }
}

public protocol IdentityStorage: Sendable {
    func load(_ scope: IdentityScope) async throws -> NativeIdentity?
    func provision(_ scope: IdentityScope) async throws -> NativeIdentity
}

public actor IdentityLifecycle {
    private let scope: IdentityScope
    private let storage: any IdentityStorage
    public init(scope: IdentityScope, storage: any IdentityStorage) { self.scope = scope; self.storage = storage }
    public func loadOnly() async throws -> NativeIdentity {
        guard let value = try await storage.load(scope) else { throw IdentityFailure.missing }
        return value
    }
    public func provisionExplicitly() async throws -> NativeIdentity {
        guard try await storage.load(scope) == nil else { throw IdentityFailure.conflict }
        return try await storage.provision(scope)
    }
}
