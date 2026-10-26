import Foundation
import Security
import Network

public struct ClientTransportResponse: Sendable { public let statusCode: Int; public let data: Data }
/// Same handle and underlying task for every close call; resolves only after native cancellation and callback drain.
public final class ClientTransportClose: Sendable {
    public let task: Task<Void,Never>
    init(_ task: Task<Void,Never>) { self.task = task }
    public func wait() async { await task.value }
}
/// Internal immutable per-transport instrumentation; never changes TLS/framing authority.
struct ClientTransportProbe: Sendable {
    let now: @Sendable () -> Date
    let event: @Sendable (String) -> Void
    let receiveCompletion: @Sendable (@escaping @Sendable () -> Void) -> Void
}
public final class NativeHostTransport: @unchecked Sendable {
    private let lock = NSLock()
    private let identity: ClientNativeIdentity, host: PinnedClientHost
    private let binding: PairedHostBinding?
    private let probe: ClientTransportProbe?
    private var active: [UUID:ConnectionRequest] = [:]
    private var closed = false, closeHandle: ClientTransportClose?
    private var waiters: [CheckedContinuation<Void,Never>] = []
    public init(identity: ClientNativeIdentity, host: PinnedClientHost) { self.identity = identity; self.host = host; binding = nil; probe = nil }
    init(identity: ClientNativeIdentity, host: PinnedClientHost, probe: ClientTransportProbe) { self.identity = identity; self.host = host; binding = nil; self.probe = probe }
    public init(identity: ClientNativeIdentity, binding: PairedHostBinding) throws {
        guard identity.fingerprint == binding.clientFingerprint else { throw ClientIdentityFailure.conflict }
        self.identity = identity; self.host = binding.host; self.binding = binding; probe = nil
    }
    public func send(_ request: ClientRequest, timeoutSeconds: Double = 30) async throws -> ClientTransportResponse {
        guard timeoutSeconds.isFinite, (0.001...120).contains(timeoutSeconds) else { throw ClientIdentityFailure.invalidInput }
        if Task.isCancelled { throw ClientIdentityFailure.cancelled }
        let id = UUID(), connection = ConnectionRequest(identity:identity,host:host,probe:probe)
        try admit(id,connection,request)
        do { try CertificateProfile.validate(identity.certificateDER,usage:.client,now:probe?.now() ?? Date()); try CertificateProfile.validate(host.certificateDER,usage:.server,now:probe?.now() ?? Date()) } catch { remove(id); throw error }
        defer { remove(id) }
        let response = try await connection.run(request:request,timeout:timeoutSeconds)
        try deliveryAllowed(mutating:request.route.mutating)
        return response
    }
    private func deliveryAllowed(mutating: Bool) throws {
        lock.lock(); defer { lock.unlock() }; guard !closed else { throw mutating ? ClientIdentityFailure.outcomeUnknown : ClientIdentityFailure.closed }
    }
    private func admit(_ id: UUID, _ connection: ConnectionRequest, _ request: ClientRequest) throws {
        lock.lock(); defer { lock.unlock() }
        guard !closed else { throw ClientIdentityFailure.closed }
        guard active.count < 8 else { throw ClientIdentityFailure.unavailable }
        if let binding {
            guard !request.route.pairing, request.route.scope.map({binding.scopes.contains($0)}) ?? true else { throw ClientIdentityFailure.forbidden }
        } else { guard request.route.pairing else { throw ClientIdentityFailure.forbidden } }
        active[id] = connection
    }
    private func remove(_ id: UUID) {
        lock.lock(); active.removeValue(forKey:id)
        let done = active.isEmpty ? waiters : []; if active.isEmpty { waiters.removeAll() }; lock.unlock()
        for waiter in done { waiter.resume() }
    }
    private func drain() async { await withCheckedContinuation { continuation in
        lock.lock(); if active.isEmpty { lock.unlock(); continuation.resume() } else { waiters.append(continuation); lock.unlock() }
    } }
    @discardableResult public func close() -> ClientTransportClose {
        lock.lock(); if let closeHandle { lock.unlock(); return closeHandle }
        closed = true
        let requests = Array(active.values)
        let handle = ClientTransportClose(Task { await self.drain() }); closeHandle = handle; lock.unlock()
        for request in requests { request.cancel() }; return handle
    }
}

private final class ConnectionRequest: @unchecked Sendable {
    private let queue = DispatchQueue(label:"com.dexter.app-client-identity.request")
    private let identity: ClientNativeIdentity, host: PinnedClientHost
    private let probe: ClientTransportProbe?
    private var connection: NWConnection?
    private var continuation: CheckedContinuation<ClientTransportResponse,any Error>?
    private var result: Result<ClientTransportResponse,any Error>?
    private var timer: DispatchWorkItem?
    private var received = Data(), sent = false, verified = false, stopped = false
    private var callbacks = 0, releasing = false
    private var mutating = false
    private var responseByteLimit = 262_144
    init(identity:ClientNativeIdentity,host:PinnedClientHost,probe:ClientTransportProbe?) { self.identity = identity; self.host = host; self.probe = probe }
    func run(request:ClientRequest,timeout:Double) async throws -> ClientTransportResponse {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { c in
                queue.async { self.start(c,request:request,timeout:timeout) }
            }
        } onCancel: { self.queue.async { self.finish(.failure(ClientIdentityFailure.cancelled)) } }
    }
    func cancel() { queue.async { self.finish(.failure(ClientIdentityFailure.cancelled)) } }
    private func start(_ c:CheckedContinuation<ClientTransportResponse,any Error>,request:ClientRequest,timeout:Double) {
        continuation = c; mutating = request.route.mutating; responseByteLimit = request.route.responseByteLimit
        if let result { continuation = nil; c.resume(with:result); return }
        guard let native = sec_identity_create(identity.identity), let port = NWEndpoint.Port(rawValue:UInt16(host.url.port ?? 443)) else { finish(.failure(ClientIdentityFailure.invalidInput)); return }
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
                  SecTrustEvaluateWithError(ref,nil) else { self.finish(.failure(ClientIdentityFailure.pinMismatch)); complete(false); return }
            self.verified = true; complete(true)
        },queue)
        let parameters = NWParameters(tls:tls,tcp:NWProtocolTCP.Options())
        let connection = NWConnection(host:NWEndpoint.Host(host.hostname),port:port,using:parameters); self.connection = connection
        let bytes = ClientHTTPWire.requestBytes(request,host:host)
        connection.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                guard self.result == nil, self.verified, !self.sent else { if !self.verified { self.finish(.failure(ClientIdentityFailure.pinMismatch)) }; return }
                self.sent = true
                self.callbacks += 1
                connection.send(content:bytes,completion:.contentProcessed { [weak self] error in
                    guard let self else { return }; defer { self.callbacks -= 1; self.releaseContinuation() }; guard self.result == nil else { return }
                    if error != nil { self.finish(.failure(ClientIdentityFailure.unavailable)) } else { self.receive() }
                })
            case .waiting, .failed: self.finish(.failure(ClientIdentityFailure.unavailable))
            case .cancelled: self.probe?.event("cancelled"); self.stopped = true; self.releaseContinuation()
            default: break
            }
        }
        let timer = DispatchWorkItem { [weak self] in self?.finish(.failure(ClientIdentityFailure.timeout)) }; self.timer = timer
        queue.asyncAfter(deadline:.now()+timeout,execute:timer); connection.start(queue:queue)
    }
    private func finish(_ result:Result<ClientTransportResponse,any Error>) {
        guard self.result == nil else { return }; if case .failure(let error) = result, sent && mutating {
            if error as? ClientIdentityFailure == .cancelled || error as? ClientIdentityFailure == .timeout || error as? ClientIdentityFailure == .unavailable || error as? ClientIdentityFailure == .protocolError { self.result = .failure(ClientIdentityFailure.outcomeUnknown) } else { self.result = result }
        } else { self.result = result }; timer?.cancel()
        if let connection { connection.cancel() } else { stopped = true; releaseContinuation() }
    }
    private func releaseContinuation() {
        guard stopped, callbacks == 0, result != nil, continuation != nil, !releasing else { return }
        releasing = true
        // Barrier after the current queue callback returns. No elapsed grace counts as drain.
        queue.async {
            self.releasing = false
            guard self.stopped, self.callbacks == 0, let result = self.result, let c = self.continuation else { return }
            self.continuation = nil; self.connection?.stateUpdateHandler = nil; self.connection = nil; self.probe?.event("resume"); c.resume(with:result)
        }
    }
    private func receiveCallbackFinished() {
        if let probe {
            probe.event("recv-held")
            probe.receiveCompletion { self.queue.async {
                probe.event("recv-released"); self.callbacks -= 1; self.releaseContinuation(); probe.event("recv-exit")
            } }
        } else { callbacks -= 1; releaseContinuation() }
    }
    private func receive() {
        guard result == nil, let connection else { return }
        callbacks += 1
        connection.receive(minimumIncompleteLength:1,maximumLength:16_384) { [weak self] data, _, complete, error in
            guard let self else { return }; defer { self.receiveCallbackFinished() }; guard self.result == nil else { return }
            if let data {
                guard data.count <= self.responseByteLimit + 16_384-self.received.count else { self.finish(.failure(ClientIdentityFailure.protocolError)); return }
                self.received.append(data)
            }
            do { if let response = try ClientHTTPResponse.decode(self.received,eof:complete,maxBodyBytes:self.responseByteLimit) { self.finish(.success(response)); return } }
            catch { self.finish(.failure(ClientIdentityFailure.protocolError)); return }
            if error != nil || complete { self.finish(.failure(ClientIdentityFailure.unavailable)) } else { self.receive() }
        }
    }
}

/// Deliberately finite framing: exactly one Content-Length, no transfer/content encoding, no redirects.
enum ClientHTTPResponse {
    static func decode(_ bytes:Data,eof:Bool,maxBodyBytes:Int = 262_144) throws -> ClientTransportResponse? {
        guard let end = bytes.range(of:Data("\r\n\r\n".utf8)) else {
            if bytes.count > 16_384 || eof { throw ClientIdentityFailure.protocolError }; return nil
        }
        guard end.upperBound <= 16_384, let header = String(data:bytes[..<end.lowerBound],encoding:.ascii) else { throw ClientIdentityFailure.protocolError }
        let lines = header.components(separatedBy:"\r\n")
        guard lines.allSatisfy({ line in line.utf8.allSatisfy { $0 >= 32 && $0 <= 126 } }) else { throw ClientIdentityFailure.protocolError }
        let statusParts = lines.first?.split(separator:" ",maxSplits:2) ?? []
        guard statusParts.count == 3, statusParts[0] == "HTTP/1.1", statusParts[1].count == 3, let status = Int(statusParts[1]),
              (200...299).contains(status) || (400...599).contains(status) else { throw ClientIdentityFailure.protocolError }
        var fields:[String:String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of:":"), !line.hasPrefix(" "), !line.hasPrefix("\t") else { throw ClientIdentityFailure.protocolError }
            let name = String(line[..<colon]).lowercased(), value = String(line[line.index(after:colon)...]).trimmingCharacters(in:.whitespaces)
            guard name.range(of:"^[a-z0-9-]+$",options:.regularExpression) != nil, fields[name] == nil else { throw ClientIdentityFailure.protocolError }; fields[name] = value
        }
        guard fields["transfer-encoding"] == nil, fields["content-encoding"] == nil,
              fields["connection"]?.lowercased() == "close",
              fields["content-type"]?.split(separator:";").first?.trimmingCharacters(in:.whitespaces).lowercased() == "application/json",
              let length = fields["content-length"], length.range(of:"^(0|[1-9][0-9]{0,6})$",options:.regularExpression) != nil,
              let count = Int(length), count <= maxBodyBytes else { throw ClientIdentityFailure.protocolError }
        let body = Data(bytes[end.upperBound...]); guard body.count <= count else { throw ClientIdentityFailure.protocolError }
        if body.count < count { if eof { throw ClientIdentityFailure.protocolError }; return nil }
        guard eof else { return nil } // Connection: close: inspect the entire finite response before publishing.
        guard (try? JSONSerialization.jsonObject(with:body)) != nil else { throw ClientIdentityFailure.protocolError }
        return ClientTransportResponse(statusCode:status,data:body)
    }
}

/// Header authority preserves the trusted origin's explicit/default port distinction.
/// No caller headers, redirect target or principal is serialized.
enum ClientHTTPWire {
    static func requestBytes(_ request: ClientRequest, host: PinnedClientHost) -> Data {
        let hostname = host.hostname.contains(":") ? "[\(host.hostname)]" : host.hostname
        let authority = hostname + (host.url.port.map { ":\($0)" } ?? "")
        let header = "\(request.route.method) \(request.route.path) HTTP/1.1\r\nHost: \(authority)\r\nContent-Type: application/json\r\nAccept: application/json\r\nContent-Length: \(request.body.count)\r\nConnection: close\r\n\r\n"
        return Data(header.utf8) + request.body
    }
}
