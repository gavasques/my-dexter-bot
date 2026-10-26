import Foundation
import CoreFoundation

public struct ClientResourceID: Sendable, Equatable {
    public let value: String
    public init(_ value: String) throws { guard finiteID(value), !value.contains("..") else { throw ClientIdentityFailure.invalidInput }; self.value = value }
}
public struct ClientPage: Sendable, Equatable {
    public let after: Int, limit: Int
    public init(after: Int = 0, limit: Int = 100) throws { guard after >= 0, after <= 9_007_199_254_740_991, (1...100).contains(limit) else { throw ClientIdentityFailure.invalidInput }; self.after = after; self.limit = limit }
    var query: String { "?after=\(after)&limit=\(limit)" }
}
/// Closed query of one output-folders route: allowed keys only, bounded well-formed values, encoded so every byte outside
/// `[A-Za-z0-9_.-]` is percent-escaped (the paired listener accepts no other query characters).
public struct ClientOutputQuery: Sendable, Equatable {
    public let items: [String: String]
    public init(_ items: [String: String], allowed: Set<String>) throws {
        guard Set(items.keys).isSubset(of: allowed), items.allSatisfy({ !$0.value.isEmpty && $0.value.utf16.count <= 1024
            && !$0.value.unicodeScalars.contains(where: { $0.value < 0x20 || (0x7f...0x9f).contains($0.value) }) }) else { throw ClientIdentityFailure.invalidInput }
        self.items = items
    }
    var query: String {
        guard !items.isEmpty else { return "" }
        let unreserved = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-".utf8)
        func encode(_ text: String) -> String { text.utf8.map { unreserved.contains($0) ? String(UnicodeScalar($0)) : String(format: "%%%02X", $0) }.joined() }
        return "?" + items.keys.sorted().map { "\(encode($0))=\(encode(items[$0]!))" }.joined(separator: "&")
    }
}
public struct ClientListPage: Sendable, Equatable {
    public let after: ClientResourceID?, limit: Int
    public init(after: ClientResourceID? = nil, limit: Int = 100) throws { guard (1...100).contains(limit) else { throw ClientIdentityFailure.invalidInput }; self.after = after; self.limit = limit }
    var query: String { after.map { "?after=\($0.value)&limit=\(limit)" } ?? "?limit=\(limit)" }
}
public enum ClientRoute: Sendable {
    case pairClaim, pairStatus, presence, health, contracts
    case bots(ClientListPage), bot(ClientResourceID), createBot, createThread(ClientResourceID), thread(ClientResourceID)
    case messages(ClientResourceID,ClientPage), appendMessage(ClientResourceID), turns(ClientResourceID,ClientPage), startTurn(ClientResourceID)
    case turn(ClientResourceID), cancelTurn(ClientResourceID), resumeQueued(ClientResourceID), events(ClientPage), turnEvents(ClientResourceID,ClientPage)
    case actions(ClientListPage), action(ClientResourceID), decideAction(ClientResourceID), devices(ClientListPage), device(ClientResourceID), renameDevice(ClientResourceID), revokeDevice(ClientResourceID)
    case grants(ClientResourceID), putGrant
    /// Output folders (exact scopes `outputs.read` / `outputs.manage`).
    case outputStatus, outputLocations, outputNamespaces(ClientOutputQuery), outputEntries(ClientOutputQuery), outputItem(ClientOutputQuery)
    case outputContent(ClientOutputQuery), outputDestination, outputReceipt(ClientResourceID)
    /// Connections (exact scopes `connections.read` / `connections.manage`).
    case connectionsStatus, connectionsCatalog, connectionAccounts, connectionAccount(ClientResourceID), connectionReceipt(ClientResourceID)
    case connectionSetupRequests, connectionSetupRequest(ClientResourceID), connectionSetupChoices(ClientResourceID)
    case startConnectionAuthorization, connectionAuthorization(ClientResourceID), reportConnectionAuthorization(ClientResourceID)
    case setConnectionAccess(ClientResourceID), setConnectionLabel(ClientResourceID), disconnectConnection(ClientResourceID)
    case completeConnectionSetup(ClientResourceID), cancelConnectionSetup(ClientResourceID)
    /// Native MCP (exact scopes `mcp.read` / `mcp.manage`).
    case mcpServers, mcpTools(ClientResourceID), mcpBotSelection(ClientResourceID, ClientResourceID), mcpCredentials(ClientResourceID)
    case mcpCommandStatus(ClientResourceID)
    case mcpInputRequests, mcpInputPage(ClientListPage, history: Bool), mcpInputRequest(ClientResourceID), respondMcpInput(ClientResourceID)
    /// Reviewed per-route envelopes; generic routes keep their original 64/256 KiB ceilings.
    var requestByteLimit: Int { if case .respondMcpInput = self { 8 * 65_536 + 4096 } else { 65_536 } }
    var responseByteLimit: Int { switch self { case .mcpInputRequest,.respondMcpInput: 1024 * 1024 + 4096; default: 262_144 } }
    // Private-answer budgets measure compact host JSON. Foundation's optional slash escapes must not inflate it.
    // Other routes retain their existing canonical representation and byte ceilings.
    var canonicalJSONWritingOptions: JSONSerialization.WritingOptions {
        if case .respondMcpInput = self { return [.sortedKeys, .withoutEscapingSlashes] }
        return .sortedKeys
    }
    var method: String {
        switch self {
        case .renameDevice,.setConnectionAccess,.setConnectionLabel: "PATCH"
        case .putGrant,.outputDestination: "PUT"
        case .pairClaim,.pairStatus,.presence,.createBot,.createThread,.appendMessage,.startTurn,.cancelTurn,.resumeQueued,.decideAction,.revokeDevice: "POST"
        case .startConnectionAuthorization,.reportConnectionAuthorization,.disconnectConnection,.completeConnectionSetup,.cancelConnectionSetup,.respondMcpInput: "POST"
        default: "GET"
        }
    }
    var path: String {
        switch self {
        case .pairClaim: "/app-client/v1/pair/claim"
        case .pairStatus: "/app-client/v1/pair/status"
        case .presence: "/app-client/v1/presence"
        case .health: "/health"
        case .contracts: "/v1/contracts"
        case .bots(let p): "/v1/bots"+p.query
        case .createBot: "/v1/bots"
        case .bot(let id): "/v1/bots/"+id.value
        case .createThread(let id): "/v1/bots/\(id.value)/threads"
        case .thread(let id): "/v1/threads/"+id.value
        case .messages(let id,let p): "/v1/threads/\(id.value)/messages"+p.query
        case .appendMessage(let id): "/v1/threads/\(id.value)/messages"
        case .turns(let id,let p): "/v1/threads/\(id.value)/turns"+p.query
        case .startTurn(let id): "/v1/threads/\(id.value)/turns"
        case .turn(let id): "/v1/turns/"+id.value
        case .cancelTurn(let id): "/v1/turns/\(id.value)/cancel"
        case .resumeQueued(let id): "/v1/threads/\(id.value)/resume-queued"
        case .events(let p): "/v1/events"+p.query
        case .turnEvents(let id,let p): "/v1/turns/\(id.value)/events"+p.query
        case .actions(let p): "/v1/actions"+p.query
        case .action(let id): "/v1/actions/"+id.value
        case .decideAction(let id): "/v1/actions/\(id.value)/decisions"
        case .devices(let p): "/v1/devices"+p.query
        case .device(let id),.renameDevice(let id): "/v1/devices/"+id.value
        case .revokeDevice(let id): "/v1/devices/\(id.value)/revoke"
        case .grants(let id): "/v1/device-grants?botId="+id.value
        case .putGrant: "/v1/device-grants"
        case .outputStatus: "/v1/output-files/status"
        case .outputLocations: "/v1/output-files/locations"
        case .outputNamespaces(let q): "/v1/output-files/namespaces"+q.query
        case .outputEntries(let q): "/v1/output-files/entries"+q.query
        case .outputItem(let q): "/v1/output-files/item"+q.query
        case .outputContent(let q): "/v1/output-files/content"+q.query
        case .outputDestination: "/v1/output-files/destination"
        case .outputReceipt(let id): "/v1/output-files/receipts/"+id.value
        case .connectionsStatus: "/v1/connections/status"
        case .connectionsCatalog: "/v1/connections/catalog"
        case .connectionAccounts: "/v1/connections/accounts"
        case .connectionAccount(let id): "/v1/connections/accounts/"+id.value
        case .connectionReceipt(let id): "/v1/connections/receipts/"+id.value
        case .connectionSetupRequests: "/v1/connections/setup-requests"
        case .connectionSetupRequest(let id): "/v1/connections/setup-requests/"+id.value
        case .connectionSetupChoices(let id): "/v1/connections/setup-requests/\(id.value)/choices"
        case .startConnectionAuthorization: "/v1/connections/authorizations"
        case .connectionAuthorization(let id): "/v1/connections/authorizations/"+id.value
        case .reportConnectionAuthorization(let id): "/v1/connections/authorizations/\(id.value)/callback"
        case .setConnectionAccess(let id): "/v1/connections/accounts/\(id.value)/access"
        case .setConnectionLabel(let id): "/v1/connections/accounts/\(id.value)/label"
        case .disconnectConnection(let id): "/v1/connections/accounts/\(id.value)/disconnect"
        case .completeConnectionSetup(let id): "/v1/connections/setup-requests/\(id.value)/complete"
        case .cancelConnectionSetup(let id): "/v1/connections/setup-requests/\(id.value)/cancel"
        case .mcpServers: "/v1/mcp/servers"
        case .mcpTools(let id): "/v1/mcp/servers/\(id.value)/tools"
        case .mcpBotSelection(let id, let bot): "/v1/mcp/servers/\(id.value)/bots/\(bot.value)"
        case .mcpCredentials(let id): "/v1/mcp/servers/\(id.value)/credentials"
        case .mcpCommandStatus(let id): "/v1/mcp/servers/\(id.value)/command-status"
        case .mcpInputRequests: "/v1/mcp/input-requests"
        case .mcpInputPage(let page, let history): "/v1/mcp/input-requests" + page.query + "&view=" + (history ? "history" : "active")
        case .mcpInputRequest(let id): "/v1/mcp/input-requests/"+id.value
        case .respondMcpInput(let id): "/v1/mcp/input-requests/\(id.value)/respond"
        }
    }
    var mutating: Bool { if case .pairStatus = self { return false }; return method != "GET" }
    var pairing: Bool { switch self { case .pairClaim,.pairStatus: true; default: false } }
    var scope: ClientScope? {
        switch self {
        case .pairClaim,.pairStatus,.presence,.health,.contracts: nil
        case .createBot,.createThread,.appendMessage,.startTurn,.cancelTurn,.resumeQueued: .chatWrite
        case .bots,.bot,.thread,.messages,.turns,.turn,.events,.turnEvents: .chatRead
        case .actions,.action: .approvalsRead
        case .decideAction: .approvalsDecide
        case .devices,.device: .devicesRead
        case .renameDevice,.revokeDevice: .devicesManage
        case .grants: .grantsRead
        case .putGrant: .grantsManage
        case .outputStatus,.outputLocations,.outputNamespaces,.outputEntries,.outputItem,.outputContent: .outputsRead
        case .outputDestination,.outputReceipt: .outputsManage
        case .connectionsStatus,.connectionsCatalog,.connectionAccounts,.connectionAccount,.connectionReceipt,
             .connectionSetupRequests,.connectionSetupRequest,.connectionSetupChoices: .connectionsRead
        case .startConnectionAuthorization,.connectionAuthorization,.reportConnectionAuthorization,.setConnectionAccess,.setConnectionLabel,
             .disconnectConnection,.completeConnectionSetup,.cancelConnectionSetup: .connectionsManage
        case .mcpServers,.mcpTools,.mcpBotSelection,.mcpCredentials,.mcpCommandStatus,.mcpInputRequests,.mcpInputPage,.mcpInputRequest: .mcpRead
        case .respondMcpInput: .mcpManage
        }
    }
}
public struct ClientRequest: Sendable {
    public let route: ClientRoute
    public let body: Data
    public init(route: ClientRoute, body: Data = Data()) throws {
        guard body.count <= route.requestByteLimit else { throw ClientIdentityFailure.invalidInput }
        let canonical: Data
        if route.method == "GET" { guard body.isEmpty else { throw ClientIdentityFailure.invalidInput }; canonical = Data() }
        else {
            guard let object = try? JSONSerialization.jsonObject(with:body) as? [String:Any] else { throw ClientIdentityFailure.invalidInput }
            try Self.validate(object,route:route)
            canonical = try JSONSerialization.data(withJSONObject:object,options:route.canonicalJSONWritingOptions)
            guard canonical.count <= route.requestByteLimit else { throw ClientIdentityFailure.invalidInput }
        }
        self.route = route; self.body = canonical
    }
    static func object(_ value: [String:Any], allowed: Set<String>, required: Set<String>? = nil) throws {
        guard Set(value.keys).isSubset(of:allowed), (required ?? allowed).isSubset(of:Set(value.keys)) else { throw ClientIdentityFailure.invalidInput }
    }
    static func name(_ value: Any?) -> Bool {
        guard let value = value as? String else { return false }
        return !value.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty && value.utf16.count <= 120 && value.utf8.count <= 480
            && !value.unicodeScalars.contains(where:{CharacterSet.controlCharacters.contains($0)})
    }
    static func validate(_ object: [String:Any], route: ClientRoute) throws {
        switch route {
        case .pairClaim:
            try self.object(object,allowed:["offerId","code","name"])
            guard (object["offerId"] as? String).map(finiteID) == true, let code = object["code"] as? String,
                  (16...256).contains(code.utf8.count), code.utf8.allSatisfy({(33...126).contains($0)}), name(object["name"]) else { throw ClientIdentityFailure.invalidInput }
        case .pairStatus:
            try self.object(object,allowed:["claimId"]); guard (object["claimId"] as? String).map(finiteID) == true else { throw ClientIdentityFailure.invalidInput }
        case .presence:
            try self.object(object,allowed:["state"]); guard object["state"] as? String == "foreground" else { throw ClientIdentityFailure.invalidInput }
        case .createBot:
            try self.object(object,allowed:["name","profileId","engine"])
            guard name(object["name"]), (object["profileId"] as? String).map(finiteID) == true, ["claude","codex"].contains(object["engine"] as? String ?? "") else { throw ClientIdentityFailure.invalidInput }
        case .appendMessage,.startTurn:
            let key: String; if case .appendMessage = route { key = "clientMessageId" } else { key = "clientRequestId" }
            try self.object(object,allowed:[key,"content"])
            guard (object[key] as? String).map(finiteID) == true, let content = object["content"] as? String, !content.isEmpty, content.utf16.count <= 32_768 else { throw ClientIdentityFailure.invalidInput }
        case .renameDevice:
            try self.object(object,allowed:["name"]); guard name(object["name"]) else { throw ClientIdentityFailure.invalidInput }
        case .decideAction:
            try self.object(object,allowed:["decision","requestHash"])
            guard ["allow","deny"].contains(object["decision"] as? String ?? ""), (object["requestHash"] as? String).map(fingerprintValid) == true else { throw ClientIdentityFailure.invalidInput }
        case .putGrant:
            try self.object(object,allowed:["botId","tool","destination","policy","expiresAt","expectedRevision"],required:["botId","tool","destination","policy","expiresAt","expectedRevision"])
            guard (object["botId"] as? String).map(finiteID) == true, (object["destination"] as? String).map(finiteID) == true,
                  let tool = object["tool"] as? String, tool.range(of:"^[a-z][a-z0-9_.-]{1,127}$",options:.regularExpression) != nil,
                  ["allow","ask","deny"].contains(object["policy"] as? String ?? ""), (object["expectedRevision"] is NSNull || Self.integer(object["expectedRevision"],minimum:1)) else { throw ClientIdentityFailure.invalidInput }
            if let expiry = object["expiresAt"], !(expiry is NSNull), !Self.integer(expiry,minimum:0) { throw ClientIdentityFailure.invalidInput }
        case .outputDestination:
            try self.object(object,allowed:["expectedHostID","clientRequestId","expectedRevision","destination"])
            guard let host = object["expectedHostID"] as? String, !host.isEmpty, host.utf8.count <= 128, (object["clientRequestId"] as? String).map(finiteID) == true,
                  Self.integer(object["expectedRevision"],minimum:1), let destination = object["destination"] as? [String:Any] else { throw ClientIdentityFailure.invalidInput }
            switch destination["kind"] as? String {
            case "host_data_default": try self.object(destination,allowed:["kind"])
            case "owner_path":
                try self.object(destination,allowed:["kind","path"])
                guard let path = destination["path"] as? String, path.hasPrefix("/"), path.utf16.count <= 1024, !path.contains("\\"),
                      !path.unicodeScalars.contains(where:{ $0.value < 0x20 || (0x7f...0x9f).contains($0.value) }) else { throw ClientIdentityFailure.invalidInput }
            default: throw ClientIdentityFailure.invalidInput
            }
        case .startConnectionAuthorization:
            try self.object(object,allowed:["expectedHostID","clientRequestId","serviceId","catalogPin","profileId","label","replacesAccountId","setupRequestId"],
                            required:["expectedHostID","clientRequestId","serviceId","catalogPin","profileId","label","replacesAccountId"])
            if let setup = object["setupRequestId"] { guard (setup as? String).map(finiteID) == true else { throw ClientIdentityFailure.invalidInput } }
            guard Self.host(object["expectedHostID"]), (object["clientRequestId"] as? String).map(finiteID) == true, (object["serviceId"] as? String).map(finiteID) == true,
                  (object["catalogPin"] as? String).map(fingerprintValid) == true, Self.optionalID(object["profileId"]), Self.optionalID(object["replacesAccountId"]),
                  object["label"] is NSNull || name(object["label"]) else { throw ClientIdentityFailure.invalidInput }
        case .reportConnectionAuthorization:
            try self.object(object,allowed:["expectedHostID","outcome","providerAccountRef"])
            guard Self.host(object["expectedHostID"]), ["returned","cancelled"].contains(object["outcome"] as? String ?? ""), Self.optionalID(object["providerAccountRef"]) else { throw ClientIdentityFailure.invalidInput }
        case .setConnectionAccess:
            try self.object(object,allowed:["expectedHostID","clientRequestId","expectedRevision","botId","enabled","toolNames"],
                            required:["expectedHostID","clientRequestId","expectedRevision","botId","enabled"])
            guard Self.host(object["expectedHostID"]), (object["clientRequestId"] as? String).map(finiteID) == true, Self.integer(object["expectedRevision"],minimum:1),
                  (object["botId"] as? String).map(finiteID) == true, Self.boolean(object["enabled"]) else { throw ClientIdentityFailure.invalidInput }
            if let names = object["toolNames"] {
                guard let list = names as? [String], (1...32).contains(list.count), Set(list).count == list.count, list.allSatisfy(finiteID) else { throw ClientIdentityFailure.invalidInput }
            }
        case .setConnectionLabel:
            try self.object(object,allowed:["expectedHostID","clientRequestId","expectedRevision","label"])
            guard Self.host(object["expectedHostID"]), (object["clientRequestId"] as? String).map(finiteID) == true, Self.integer(object["expectedRevision"],minimum:1),
                  name(object["label"]) else { throw ClientIdentityFailure.invalidInput }
        case .disconnectConnection,.cancelConnectionSetup:
            try self.object(object,allowed:["expectedHostID","clientRequestId","expectedRevision"])
            guard Self.host(object["expectedHostID"]), (object["clientRequestId"] as? String).map(finiteID) == true, Self.integer(object["expectedRevision"],minimum:1) else { throw ClientIdentityFailure.invalidInput }
        case .completeConnectionSetup:
            try self.object(object,allowed:["expectedHostID","clientRequestId","expectedRevision","selections"])
            guard Self.host(object["expectedHostID"]), (object["clientRequestId"] as? String).map(finiteID) == true, Self.integer(object["expectedRevision"],minimum:1),
                  let selections = object["selections"] as? [[String:Any]], (1...5).contains(selections.count) else { throw ClientIdentityFailure.invalidInput }
            for selection in selections {
                try self.object(selection,allowed:["connectionId","expectedRevision","tools"])
                guard (selection["connectionId"] as? String).map(finiteID) == true, Self.integer(selection["expectedRevision"],minimum:1),
                      let tools = selection["tools"] as? [[String:Any]], (1...256).contains(tools.count) else { throw ClientIdentityFailure.invalidInput }
                for tool in tools {
                    try self.object(tool,allowed:["name","manifestHash"])
                    guard (tool["name"] as? String).map(finiteID) == true, (tool["manifestHash"] as? String).map(fingerprintValid) == true else { throw ClientIdentityFailure.invalidInput }
                }
            }
        case .respondMcpInput:
            try self.object(object,allowed:["expectedHostID","clientRequestId","expectedRevision","actionId","requestHash","responses","approval"],
                            required:["expectedHostID","clientRequestId","expectedRevision","actionId","requestHash","responses"])
            if let approval = object["approval"] { guard approval as? String == "approve_exact_input" else { throw ClientIdentityFailure.invalidInput } }
            guard Self.host(object["expectedHostID"]), (object["clientRequestId"] as? String).map(finiteID) == true, Self.integer(object["expectedRevision"],minimum:1),
                  (object["actionId"] as? String).map(finiteID) == true, (object["requestHash"] as? String).map(fingerprintValid) == true,
                  let responses = object["responses"] as? [String:Any], (1...16).contains(responses.count) else { throw ClientIdentityFailure.invalidInput }
            for (key, value) in responses {
                guard !key.isEmpty, key.utf8.count <= 128, let response = value as? [String:Any],
                      let action = response["action"] as? String, ["accept","decline","cancel"].contains(action) else { throw ClientIdentityFailure.invalidInput }
                try self.object(response,allowed:action == "accept" ? ["action","content"] : ["action"])
                if action == "accept" { guard response["content"] is [String:Any], object["approval"] as? String == "approve_exact_input" else { throw ClientIdentityFailure.invalidInput } }
            }
        case .createThread,.cancelTurn,.resumeQueued,.revokeDevice:
            try self.object(object,allowed:[])
        default: throw ClientIdentityFailure.invalidInput
        }
    }
    static func host(_ value: Any?) -> Bool {
        guard let host = value as? String else { return false }
        return !host.isEmpty && host.utf8.count <= 128 && !host.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) })
    }
    static func optionalID(_ value: Any?) -> Bool { value is NSNull || (value as? String).map(finiteID) == true }
    static func boolean(_ value: Any?) -> Bool {
        guard let number = value as? NSNumber else { return false }
        return CFGetTypeID(number) == CFBooleanGetTypeID()
    }
    static func integer(_ value: Any?, minimum: Int) -> Bool {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return false }
        let n = number.doubleValue; return n.isFinite && n.rounded() == n && n >= Double(minimum) && n <= 9_007_199_254_740_991
    }
    static func json(route: ClientRoute, value: [String:Any]) throws -> ClientRequest { try ClientRequest(route:route,body:JSONSerialization.data(withJSONObject:value,options:route.canonicalJSONWritingOptions)) }
}
