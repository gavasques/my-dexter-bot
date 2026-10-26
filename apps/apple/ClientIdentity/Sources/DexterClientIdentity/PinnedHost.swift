import Foundation
import Security
import CryptoKit
import Darwin

public struct PinnedClientHost: Sendable {
    public let url: URL
    let hostname: String
    public let certificateDER: Data
    public let fingerprint: String
    public init(url: URL, certificateDER: Data, fingerprint: String) throws {
        let rawHost = url.host ?? ""
        let host = rawHost.hasPrefix("[") && rawHost.hasSuffix("]") ? String(rawHost.dropFirst().dropLast()) : rawHost
        var ipv4 = in_addr(), ipv6 = in6_addr()
        let literal = host.withCString { inet_pton(AF_INET,$0,&ipv4) == 1 || inet_pton(AF_INET6,$0,&ipv6) == 1 }
        let labels = host.split(separator:".",omittingEmptySubsequences:false)
        let validHost = literal || (host.utf8.count <= 253 && !labels.isEmpty && labels.allSatisfy {
            $0.range(of:"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$",options:.regularExpression) != nil
        })
        guard url.scheme == "https", validHost, url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/", url.port.map({(1...65535).contains($0)}) ?? true,
              certificateDER.count <= 16_384, SecCertificateCreateWithData(nil,certificateDER as CFData) != nil,
              fingerprint.range(of:"^[0-9a-f]{64}$",options:.regularExpression) != nil else { throw ClientIdentityFailure.invalidInput }
        guard SHA256.hash(data:certificateDER).map({String(format:"%02x",$0)}).joined() == fingerprint else { throw ClientIdentityFailure.pinMismatch }
        try CertificateProfile.validate(certificateDER,usage:.server,now:Date())
        self.url = url; hostname = host; self.certificateDER = certificateDER; self.fingerprint = fingerprint
    }
}

