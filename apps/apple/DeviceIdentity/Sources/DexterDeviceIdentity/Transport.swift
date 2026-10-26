import Foundation
import Security
import CryptoKit
import Network
import Darwin

public enum DeviceRoute: String, Codable, Sendable, CaseIterable {
    case pairClaim = "/v1/pair/claim", pairStatus = "/v1/pair/status", poll = "/v1/device/poll", receipt = "/v1/device/receipt"
}
public enum RemoteDeviceFailure: String, Error, Sendable {
    case invalidInput = "invalid_input", forbidden, notFound = "not_found", conflict, unavailable, timeout
    case tlsPinMismatch = "tls_pin_mismatch", protocolError = "protocol_error", unsupported, outcomeUnknown = "outcome_unknown"
}
public struct PinnedHost: Sendable {
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
              fingerprint.range(of:"^[0-9a-f]{64}$",options:.regularExpression) != nil else { throw IdentityFailure.invalidInput }
        guard SHA256.hash(data:certificateDER).map({String(format:"%02x",$0)}).joined() == fingerprint else { throw IdentityFailure.pinMismatch }
        self.url = url; hostname = host; self.certificateDER = certificateDER; self.fingerprint = fingerprint
    }
}

/// One Network.framework connection per call, TLS1.3 only, no tickets/resumption/early data.
/// Fixed HTTP1.1 framing matches DeviceHost; chunked/redirect/ambiguous framing fails closed.
public struct NativeDeviceTransport: Sendable {
    private let identity: NativeIdentity, host: PinnedHost
    public init(identity: NativeIdentity, host: PinnedHost) { self.identity = identity; self.host = host }
    public func post(route: DeviceRoute, body: Data, timeoutSeconds: Double) async throws -> Data {
        try DeviceRequestValidation.check(body:body,timeoutSeconds:timeoutSeconds)
        if Task.isCancelled { throw IdentityFailure.cancelled }
        return try await ConnectionRequest(identity:identity,host:host).run(route:route,body:body,timeout:timeoutSeconds)
    }
}

private final class ConnectionRequest: @unchecked Sendable {
    private let queue = DispatchQueue(label:"com.dexter.device-identity.request")
    private let identity: NativeIdentity, host: PinnedHost
    private var connection: NWConnection?
    private var continuation: CheckedContinuation<Data,any Error>?
    private var result: Result<Data,any Error>?
    private var timer: DispatchWorkItem?
    private var received = Data(), sent = false, verified = false, stopped = false
    init(identity:NativeIdentity,host:PinnedHost) { self.identity = identity; self.host = host }
    func run(route:DeviceRoute,body:Data,timeout:Double) async throws -> Data {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { c in
                queue.async { self.start(c,route:route,body:body,timeout:timeout) }
            }
        } onCancel: { self.queue.async { self.finish(.failure(IdentityFailure.cancelled)) } }
    }
    private func start(_ c:CheckedContinuation<Data,any Error>,route:DeviceRoute,body:Data,timeout:Double) {
        continuation = c
        if let result { continuation = nil; c.resume(with:result); return }
        guard let native = sec_identity_create(identity.identity), let port = NWEndpoint.Port(rawValue:UInt16(host.url.port ?? 443)) else { finish(.failure(IdentityFailure.invalidInput)); return }
        let tls = NWProtocolTLS.Options(), options = tls.securityProtocolOptions
        TransportSecurityPolicy.configureProtocol(
            minimum:{ sec_protocol_options_set_min_tls_protocol_version(options,$0) },
            maximum:{ sec_protocol_options_set_max_tls_protocol_version(options,$0) },
            resumption:{ sec_protocol_options_set_tls_resumption_enabled(options,$0) },
            tickets:{ sec_protocol_options_set_tls_tickets_enabled(options,$0) },
            falseStart:{ sec_protocol_options_set_tls_false_start_enabled(options,$0) })
        sec_protocol_options_add_tls_application_protocol(options,"http/1.1")
        sec_protocol_options_set_tls_server_name(options,host.hostname)
        sec_protocol_options_set_local_identity(options,native)
        sec_protocol_options_set_verify_block(options,{ [weak self] _, trust, complete in
            guard let self, self.result == nil else { complete(false); return }
            let ref = sec_trust_copy_ref(trust).takeRetainedValue()
            guard let chain = SecTrustCopyCertificateChain(ref) as? [SecCertificate], let leaf = chain.first,
                  (SecCertificateCopyData(leaf) as Data) == self.host.certificateDER,
                  let anchor = SecCertificateCreateWithData(nil,self.host.certificateDER as CFData),
                  SecTrustSetPolicies(ref,SecPolicyCreateSSL(true,self.host.hostname as CFString)) == errSecSuccess,
                  SecTrustSetAnchorCertificates(ref,[anchor] as CFArray) == errSecSuccess,
                  TransportSecurityPolicy.configureTrust(anchorOnly:{ SecTrustSetAnchorCertificatesOnly(ref,$0) },
                    networkFetch:{ SecTrustSetNetworkFetchAllowed(ref,$0) }),
                  SecTrustEvaluateWithError(ref,nil) else { self.finish(.failure(IdentityFailure.pinMismatch)); complete(false); return }
            self.verified = true; complete(true)
        },queue)
        let parameters = NWParameters(tls:tls,tcp:NWProtocolTCP.Options())
        let connection = NWConnection(host:NWEndpoint.Host(host.hostname),port:port,using:parameters); self.connection = connection
        let authority = host.hostname.contains(":") ? "[\(host.hostname)]" : host.hostname
        let header = "POST \(route.rawValue) HTTP/1.1\r\nHost: \(authority):\(host.url.port ?? 443)\r\nContent-Type: application/json\r\nAccept: application/json\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
        let request = Data(header.utf8)+body
        connection.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                guard self.result == nil, self.verified, !self.sent else { if !self.verified { self.finish(.failure(IdentityFailure.pinMismatch)) }; return }
                self.sent = true
                connection.send(content:request,completion:.contentProcessed { [weak self] error in
                    guard let self, self.result == nil else { return }
                    if error != nil { self.finish(.failure(IdentityFailure.unavailable)) } else { self.receive() }
                })
            case .waiting, .failed: self.finish(.failure(IdentityFailure.unavailable))
            case .cancelled: self.stopped = true; self.releaseContinuation()
            default: break
            }
        }
        let timer = DispatchWorkItem { [weak self] in self?.finish(.failure(IdentityFailure.timeout)) }; self.timer = timer
        queue.asyncAfter(deadline:.now()+timeout,execute:timer); connection.start(queue:queue)
    }
    private func finish(_ result:Result<Data,any Error>) {
        guard self.result == nil else { return }; self.result = result; timer?.cancel()
        if let connection { connection.cancel() } else { stopped = true; releaseContinuation() }
    }
    private func releaseContinuation() {
        guard stopped, let result, let c = continuation else { return }
        continuation = nil; connection?.stateUpdateHandler = nil; connection = nil; c.resume(with:result)
    }
    private func receive() {
        guard result == nil, let connection else { return }
        connection.receive(minimumIncompleteLength:1,maximumLength:16_384) { [weak self] data, _, complete, error in
            guard let self, self.result == nil else { return }
            if let data {
                guard data.count <= 278_528-self.received.count else { self.finish(.failure(IdentityFailure.protocolError)); return }
                self.received.append(data)
            }
            do { if let body = try HTTPResponse.decode(self.received,eof:complete) { self.finish(.success(body)); return } }
            catch let failure as RemoteDeviceFailure { self.finish(.failure(failure)); return }
            catch { self.finish(.failure(IdentityFailure.protocolError)); return }
            if error != nil || complete { self.finish(.failure(IdentityFailure.unavailable)) } else { self.receive() }
        }
    }
}

/// Deliberately finite framing: exactly one Content-Length, no transfer/content encoding, no redirects.
enum HTTPResponse {
    static func decode(_ bytes:Data,eof:Bool) throws -> Data? {
        guard let end = bytes.range(of:Data("\r\n\r\n".utf8)) else {
            if bytes.count > 16_384 || eof { throw IdentityFailure.protocolError }; return nil
        }
        guard end.upperBound <= 16_384, let header = String(data:bytes[..<end.lowerBound],encoding:.ascii) else { throw IdentityFailure.protocolError }
        let lines = header.components(separatedBy:"\r\n")
        guard lines.allSatisfy({ line in line.utf8.allSatisfy { $0 >= 32 && $0 <= 126 } }) else { throw IdentityFailure.protocolError }
        let statusParts = lines.first?.split(separator:" ",maxSplits:2) ?? []
        guard statusParts.count == 3, statusParts[0] == "HTTP/1.1", statusParts[1].count == 3, let status = Int(statusParts[1]),
              status == 200 || (400...599).contains(status) else { throw IdentityFailure.protocolError }
        var fields:[String:String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of:":"), !line.hasPrefix(" "), !line.hasPrefix("\t") else { throw IdentityFailure.protocolError }
            let name = String(line[..<colon]).lowercased(), value = String(line[line.index(after:colon)...]).trimmingCharacters(in:.whitespaces)
            guard name.range(of:"^[a-z0-9-]+$",options:.regularExpression) != nil, fields[name] == nil else { throw IdentityFailure.protocolError }; fields[name] = value
        }
        guard fields["transfer-encoding"] == nil, fields["content-encoding"] == nil,
              fields["content-type"]?.split(separator:";").first?.trimmingCharacters(in:.whitespaces).lowercased() == "application/json",
              let length = fields["content-length"], length.range(of:"^(0|[1-9][0-9]{0,6})$",options:.regularExpression) != nil,
              let count = Int(length), count <= 262_144 else { throw IdentityFailure.protocolError }
        let body = Data(bytes[end.upperBound...]); guard body.count <= count else { throw IdentityFailure.protocolError }
        if body.count < count { if eof { throw IdentityFailure.protocolError }; return nil }
        guard eof else { return nil } // Connection: close: inspect the entire finite response before publishing.
        guard let value = try? JSONSerialization.jsonObject(with:body) as? [String:Any] else { throw IdentityFailure.protocolError }
        if status != 200 {
            guard let code = value["error"] as? String, let known = RemoteDeviceFailure(rawValue:code) else { throw IdentityFailure.protocolError }; throw known
        }
        return body
    }
}
