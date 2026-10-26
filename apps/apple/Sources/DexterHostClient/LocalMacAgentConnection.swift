import CryptoKit
import Foundation
import Security

/// Public trust of the owner's currently listening Mac-agent channel. This is not a pairing offer:
/// no code, claim, private key or permission is contained here, and parsing it grants no authority.
public struct LocalMacAgentConnectionDescription: Equatable, Sendable {
    public let installationID: String
    public let hostURL: String
    public let hostFingerprint: String
    public let certificateDER: Data

    /// Validate the closed host DTO and its public certificate pin. When supplied, the installation
    /// must match the host already captured by the caller. A changed endpoint does not authorize a new pin.
    public init(json text: String, expectedInstallationID: String? = nil) throws {
        let data = Data(text.utf8)
        guard !data.isEmpty, data.count <= 32768,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == ["schema", "installationId", "hostUrl", "hostFingerprint", "hostCertPem"],
              object["schema"] as? String == "dexter.local-mac-agent-connection/1",
              let installation = object["installationId"] as? String,
              installation.range(of: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$", options: .regularExpression) != nil,
              expectedInstallationID.map({ $0 == installation }) ?? true,
              let host = object["hostUrl"] as? String, Self.validEndpoint(host),
              let fingerprint = object["hostFingerprint"] as? String,
              fingerprint.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
              let pem = object["hostCertPem"] as? String, pem.utf8.count <= 16384,
              let der = Self.singleCertificateDER(pem),
              SecCertificateCreateWithData(nil, der as CFData) != nil,
              SHA256.hash(data: der).map({ String(format: "%02x", $0) }).joined() == fingerprint else {
            throw HostClientError.contractMismatch
        }
        installationID = installation
        hostURL = host
        hostFingerprint = fingerprint
        certificateDER = der
    }

    private static func validEndpoint(_ value: String) -> Bool {
        // The production channel is loopback-only. Require the literal address/port published by
        // its listener: no DNS name, credentials, alternate path, query, fragment or normalized alias.
        guard value.utf8.count <= 128, let url = URL(string: value),
              url.scheme == "https", let port = url.port, (1...65535).contains(port),
              url.user == nil, url.password == nil, url.path.isEmpty,
              url.query == nil, url.fragment == nil else { return false }
        return value == "https://127.0.0.1:\(port)" || value == "https://[::1]:\(port)"
    }

    private static func singleCertificateDER(_ pem: String) -> Data? {
        let lines = pem.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        guard lines.count >= 3, lines.first == "-----BEGIN CERTIFICATE-----", lines.last == "-----END CERTIFICATE-----" else { return nil }
        let body = lines.dropFirst().dropLast()
        guard body.allSatisfy({ $0.range(of: "^[A-Za-z0-9+/=]+$", options: .regularExpression) != nil }) else { return nil }
        return Data(base64Encoded: body.joined())
    }
}

public extension HostClient {
    /// Metadata-only owner GET. No redirect, cache, automatic replay, pairing offer or implicit approval.
    /// The caller must compare installation/pin/DER with its existing authorized binding before rebinding.
    func localMacAgentConnection() async throws -> LocalMacAgentConnectionDescription {
        guard case .loopbackDevelopment = accessPolicy else { throw HostClientError.forbidden }
        let value: JSONValue = try await request("/v1/local-mac-agent/connection", timeout: 15,
                                                cachePolicy: .reloadIgnoringLocalCacheData,
                                                localAttachmentRequest: true)
        guard let data = try? JSONEncoder().encode(value), data.count <= 32768,
              let text = String(data: data, encoding: .utf8) else { throw HostClientError.contractMismatch }
        return try LocalMacAgentConnectionDescription(json: text)
    }
}
