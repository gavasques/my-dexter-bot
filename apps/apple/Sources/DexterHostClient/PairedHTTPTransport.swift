import Foundation
import DexterClientIdentity

protocol PairedNativeSending: Sendable {
    func send(_ request: ClientRequest) async throws -> ClientTransportResponse
    func close() -> ClientTransportClose
}
struct NativePairedSender: PairedNativeSending {
    let native: NativeHostTransport
    func send(_ request: ClientRequest) async throws -> ClientTransportResponse { try await native.send(request) }
    func close() -> ClientTransportClose { native.close() }
}

/// An approved factory-produced binding is required. No URLRequest header/principal is forwarded.
public final class PairedHTTPTransport: HTTPTransport, @unchecked Sendable {
    public let binding: PairedHostBinding
    private let sender: any PairedNativeSending
    private let lock = NSLock()
    private var active = 0
    private var drainWaiters: [CheckedContinuation<Void,Never>] = []
    private var closed = false
    private var closeTask: Task<Void,Never>?
    public init(binding: PairedHostBinding, lifecycle: ClientIdentityLifecycle) async throws {
        let native = try await ClientConnectionFactory.paired(binding:binding,lifecycle:lifecycle)
        self.binding = binding; sender = NativePairedSender(native:native)
    }
    init(binding: PairedHostBinding, sender: any PairedNativeSending) { self.binding = binding; self.sender = sender }
    public func send(_ request: URLRequest) async throws -> TransportResponse {
        try admit(); defer { finish() }
        let prepared: ClientRequest
        do { prepared = try Self.prepare(request,binding:binding) } catch { throw HostClientError.invalidRequest }
        let result: ClientTransportResponse
        do { result = try await sender.send(prepared) }
        catch let failure as ClientIdentityFailure {
            switch failure {
            case .outcomeUnknown: throw HostClientError.mutationOutcomeUnknown
            case .closed,.cancelled: throw CancellationError()
            case .forbidden: throw HostClientError.forbidden
            case .invalidInput: throw HostClientError.invalidRequest
            case .pinMismatch,.conflict,.expired,.protocolError: throw HostClientError.contractMismatch
            default: throw HostClientError.offline
            }
        }
        do { try assertOpen() } catch { if Self.mutating(prepared.route) { throw HostClientError.mutationOutcomeUnknown }; throw error }
        if let error = Self.authorityUnknown(result) { throw error }
        do { try Self.validateBoundResponse(result,route:prepared.route,binding:binding) }
        catch { if Self.mutating(prepared.route) { throw HostClientError.mutationOutcomeUnknown }; throw error }
        return TransportResponse(statusCode:result.statusCode,data:result.data)
    }
    private func assertOpen() throws { lock.lock(); defer { lock.unlock() }; guard !closed else { throw CancellationError() } }
    public func beginClose() -> Task<Void,Never> {
        lock.lock(); if let closeTask { lock.unlock(); return closeTask }; closed = true
        let nativeClose = sender.close(), task = Task { await nativeClose.wait(); await self.waitForDrain() }; closeTask = task; lock.unlock(); return task
    }
    private func admit() throws { lock.lock(); defer { lock.unlock() }; guard !closed else { throw CancellationError() }; active += 1 }
    private func finish() {
        lock.lock(); active -= 1
        let ready = active == 0 ? drainWaiters : []; if active == 0 { drainWaiters = [] }; lock.unlock()
        ready.forEach { $0.resume() }
    }
    private func waitForDrain() async {
        await withCheckedContinuation { continuation in
            lock.lock(); if active == 0 { lock.unlock(); continuation.resume() } else { drainWaiters.append(continuation); lock.unlock() }
        }
    }
    static func mutating(_ route: ClientRoute) -> Bool {
        switch route {
        case .health,.contracts,.bots,.bot,.thread,.messages,.turns,.turn,.events,.turnEvents,.actions,.action,.devices,.device,.grants,.pairStatus,
             .outputStatus,.outputLocations,.outputNamespaces,.outputEntries,.outputItem,.outputContent,.outputReceipt,
             .connectionsStatus,.connectionsCatalog,.connectionAccounts,.connectionAccount,.connectionReceipt,.connectionSetupRequests,
             .connectionSetupRequest,.connectionSetupChoices,.connectionAuthorization,.mcpServers,.mcpTools,.mcpBotSelection,.mcpCredentials,
             .mcpCommandStatus,.mcpInputRequests,.mcpInputPage,.mcpInputRequest: false
        default: true
        }
    }
    static func authorityUnknown(_ result: ClientTransportResponse) -> HostClientError? {
        guard let value = try? JSONSerialization.jsonObject(with:result.data) as? [String:Any], value["error"] is String, value["effect"] as? String == "unknown" else { return nil }; return .mutationOutcomeUnknown
    }
    static func validateBoundResponse(_ result: ClientTransportResponse, route: ClientRoute, binding: PairedHostBinding) throws {
        guard (200..<300).contains(result.statusCode) else { return }
        // Output file bytes are bound to their identity pin by the caller; never parsed as JSON.
        if case .outputContent = route { return }
        guard let value = try? JSONSerialization.jsonObject(with:result.data) as? [String:Any] else { throw HostClientError.contractMismatch }
        if case .health = route {
            guard value["protocolVersion"] as? Int == 1, value["mode"] as? String == "paired-client", value["remotePairing"] as? String == "implemented",
                  value["installationId"] as? String == binding.installationID, let client = value["client"] as? [String:Any],
                  client["deviceId"] as? String == binding.deviceID, client["role"] as? String == binding.role.rawValue,
                  client["scopes"] as? [String] == binding.scopes.map(\.rawValue), client["pinGeneration"] as? Int == binding.pinGeneration,
                  client["bindingRevision"] as? Int == binding.bindingRevision else { throw HostClientError.contractMismatch }
        }
        if let owner = value["ownerId"] as? String, owner != binding.ownerID { throw HostClientError.contractMismatch }
        if let items = value["items"] as? [[String:Any]], items.contains(where:{ ($0["ownerId"] as? String).map { $0 != binding.ownerID } ?? false }) { throw HostClientError.contractMismatch }
        if case .presence = route, value["deviceId"] as? String != binding.deviceID { throw HostClientError.contractMismatch }
    }
    static func prepare(_ request: URLRequest, binding: PairedHostBinding) throws -> ClientRequest {
        guard let url = request.url, let c = URLComponents(url:url,resolvingAgainstBaseURL:false), let origin = URLComponents(url:binding.host.url,resolvingAgainstBaseURL:false),
              c.scheme == "https", c.host?.lowercased() == origin.host?.lowercased(), c.port == origin.port,
              c.user == nil, c.password == nil, c.fragment == nil, request.httpBodyStream == nil else { throw HostClientError.invalidRequest }
        let binaryContent = (request.httpMethod ?? "GET") == "GET" && c.path == "/v1/output-files/content"
        for (key,value) in request.allHTTPHeaderFields ?? [:] {
            guard ["accept","content-type"].contains(key.lowercased()),
                  value.lowercased() == "application/json" || binaryContent && key.lowercased() == "accept" && value.lowercased() == "application/octet-stream" else { throw HostClientError.invalidRequest }
        }
        let method = request.httpMethod ?? "GET", path = c.path.split(separator:"/",omittingEmptySubsequences:false).map(String.init)
        guard path.first == "", !path.contains(".."), !c.path.contains("//"), c.path.utf8.count <= 1024 else { throw HostClientError.invalidRequest }
        var query: [String:String] = [:]
        for item in c.queryItems ?? [] { guard let value = item.value, query[item.name] == nil else { throw HostClientError.invalidRequest }; query[item.name] = value }
        func id(_ index: Int) throws -> ClientResourceID { guard path.count > index else { throw HostClientError.invalidRequest }; return try ClientResourceID(path[index]) }
        func numericPage() throws -> ClientPage {
            guard Set(query.keys).isSubset(of:["after","limit"]) else { throw HostClientError.invalidRequest }
            func decimal(_ key: String,_ fallback: Int) throws -> Int { guard let v = query[key] else { return fallback }; guard v.range(of:"^(0|[1-9][0-9]{0,15})$",options:.regularExpression) != nil, let n = Int(v) else { throw HostClientError.invalidRequest }; return n }
            return try ClientPage(after:decimal("after",0),limit:decimal("limit",100))
        }
        func listPage() throws -> ClientListPage {
            guard Set(query.keys).isSubset(of:["after","limit"]), query["limit"].map({$0.range(of:"^[1-9][0-9]{0,2}$",options:.regularExpression) != nil}) ?? true else { throw HostClientError.invalidRequest }
            return try ClientListPage(after:query["after"].map(ClientResourceID.init),limit:query["limit"].flatMap(Int.init) ?? 100)
        }
        let route: ClientRoute
        switch (method,c.path) {
        case ("GET","/health"): route = .health
        case ("GET","/v1/contracts"): route = .contracts
        case ("GET","/v1/bots"): route = .bots(try listPage())
        case ("POST","/v1/bots"): route = .createBot
        case ("GET","/v1/actions"): route = .actions(try listPage())
        case ("GET","/v1/devices"): route = .devices(try listPage())
        case ("GET","/v1/events"): route = .events(try numericPage())
        case ("POST","/app-client/v1/presence"): route = .presence
        case ("GET","/v1/device-grants"):
            guard Set(query.keys) == ["botId"], let bot = query["botId"] else { throw HostClientError.invalidRequest }; route = .grants(try ClientResourceID(bot))
        case ("PUT","/v1/device-grants"): route = .putGrant
        case ("GET","/v1/output-files/status"): route = .outputStatus
        case ("GET","/v1/output-files/locations"): route = .outputLocations
        case ("GET","/v1/output-files/namespaces"): route = .outputNamespaces(try ClientOutputQuery(query,allowed:["generation"]))
        case ("GET","/v1/output-files/entries"): route = .outputEntries(try ClientOutputQuery(query,allowed:["generation","namespace","path","after","limit"]))
        case ("GET","/v1/output-files/item"): route = .outputItem(try ClientOutputQuery(query,allowed:["generation","namespace","path"]))
        case ("GET","/v1/output-files/content"): route = .outputContent(try ClientOutputQuery(query,allowed:["generation","namespace","path","pin","offset","length"]))
        case ("PUT","/v1/output-files/destination"): route = .outputDestination
        case ("GET","/v1/connections/status"): route = .connectionsStatus
        case ("GET","/v1/connections/catalog"): route = .connectionsCatalog
        case ("GET","/v1/connections/accounts"): route = .connectionAccounts
        case ("GET","/v1/connections/setup-requests"): route = .connectionSetupRequests
        case ("POST","/v1/connections/authorizations"): route = .startConnectionAuthorization
        case ("GET","/v1/mcp/servers"): route = .mcpServers
        case ("GET","/v1/mcp/input-requests"):
            if query.isEmpty { route = .mcpInputRequests }
            else {
                guard Set(query.keys).isSubset(of:["after","limit","view"]), ["active","history"].contains(query["view"] ?? "active") else { throw HostClientError.invalidRequest }
                let history = query.removeValue(forKey:"view") == "history"
                route = .mcpInputPage(try listPage(),history:history)
            }
        default:
            guard path.count >= 4, path[1] == "v1" else { throw HostClientError.invalidRequest }
            switch (method,path[2],path.count,path.last!) {
            case ("GET","bots",4,_): route = .bot(try id(3))
            case ("POST","bots",5,"threads"): route = .createThread(try id(3))
            case ("GET","threads",4,_): route = .thread(try id(3))
            case ("GET","threads",5,"messages"): route = .messages(try id(3),try numericPage())
            case ("POST","threads",5,"messages"): route = .appendMessage(try id(3))
            case ("GET","threads",5,"turns"): route = .turns(try id(3),try numericPage())
            case ("POST","threads",5,"turns"): route = .startTurn(try id(3))
            case ("POST","threads",5,"resume-queued"): route = .resumeQueued(try id(3))
            case ("GET","turns",4,_): route = .turn(try id(3))
            case ("POST","turns",5,"cancel"): route = .cancelTurn(try id(3))
            case ("GET","turns",5,"events"): route = .turnEvents(try id(3),try numericPage())
            case ("GET","actions",4,_): route = .action(try id(3))
            case ("POST","actions",5,"decisions"): route = .decideAction(try id(3))
            case ("GET","devices",4,_): route = .device(try id(3))
            case ("PATCH","devices",4,_): route = .renameDevice(try id(3))
            case ("POST","devices",5,"revoke"): route = .revokeDevice(try id(3))
            case ("GET","output-files",5,_) where path[3] == "receipts": route = .outputReceipt(try id(4))
            case ("GET","connections",5,_) where path[3] == "accounts": route = .connectionAccount(try id(4))
            case ("GET","connections",5,_) where path[3] == "receipts": route = .connectionReceipt(try id(4))
            case ("GET","connections",5,_) where path[3] == "setup-requests": route = .connectionSetupRequest(try id(4))
            case ("GET","connections",6,"choices") where path[3] == "setup-requests": route = .connectionSetupChoices(try id(4))
            case ("GET","connections",5,_) where path[3] == "authorizations": route = .connectionAuthorization(try id(4))
            case ("POST","connections",6,"callback") where path[3] == "authorizations": route = .reportConnectionAuthorization(try id(4))
            case ("PATCH","connections",6,"access") where path[3] == "accounts": route = .setConnectionAccess(try id(4))
            case ("PATCH","connections",6,"label") where path[3] == "accounts": route = .setConnectionLabel(try id(4))
            case ("POST","connections",6,"disconnect") where path[3] == "accounts": route = .disconnectConnection(try id(4))
            case ("POST","connections",6,"complete") where path[3] == "setup-requests": route = .completeConnectionSetup(try id(4))
            case ("POST","connections",6,"cancel") where path[3] == "setup-requests": route = .cancelConnectionSetup(try id(4))
            case ("GET","mcp",6,"tools") where path[3] == "servers": route = .mcpTools(try id(4))
            case ("GET","mcp",6,"credentials") where path[3] == "servers": route = .mcpCredentials(try id(4))
            case ("GET","mcp",6,"command-status") where path[3] == "servers": route = .mcpCommandStatus(try id(4))
            case ("GET","mcp",7,_) where path[3] == "servers" && path[5] == "bots": route = .mcpBotSelection(try id(4), try id(6))
            case ("GET","mcp",5,_) where path[3] == "input-requests": route = .mcpInputRequest(try id(4))
            case ("POST","mcp",6,"respond") where path[3] == "input-requests": route = .respondMcpInput(try id(4))
            default: throw HostClientError.invalidRequest
            }
        }
        switch route {
        case .bots,.actions,.devices,.messages,.turns,.events,.turnEvents,.grants,.outputNamespaces,.outputEntries,.outputItem,.outputContent,.mcpInputPage: break
        default: guard query.isEmpty else { throw HostClientError.invalidRequest }
        }
        do { return try ClientRequest(route:route,body:request.httpBody ?? Data()) } catch { throw HostClientError.invalidRequest }
    }
}
