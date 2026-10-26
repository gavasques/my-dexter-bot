import CryptoKit
import Foundation

/// Public scope read from owner-loopback /health; never serialized as registration authority.
public struct McpRegistrationNamespace: Hashable, Sendable {
    public let baseURL: URL
    public let installationID: String
    public let ownerID: String
    public init(baseURL: URL, health: HostHealth) throws {
        guard case .object(let state)? = health.state, case .string(let owner)? = state["ownerId"],
              case .string(let host)? = state["hostId"], host == health.hostId,
              McpRegistrationJSON.validID(host), McpRegistrationJSON.validID(owner), health.mode == "local-development" else {
            throw HostClientError.contractMismatch
        }
        self.baseURL = baseURL; installationID = host; ownerID = owner
    }
    var originHash: String {
        // This domain exactly matches NativeMCP owner_local; it does not confer authority.
        McpRegistrationJSON.hash(.object(["version": .integer(1), "installationId": .string(installationID),
            "ownerId": .string(ownerID), "origin": .object(["kind": .string("owner_local")])]))
    }
}

/// Immutable, bounded, nonsecret original body. An ID belongs to one reviewed intention, not one network attempt.
public struct McpRegistrationRequest: Equatable, Sendable {
    public let requestID: String
    public let definition: JSONValue
    public let serverID: String
    public let bodyData: Data
    public let inputHash: String
    public init(definition: JSONValue, requestID: String = "mac:" + UUID().uuidString.lowercased()) throws {
        guard McpRegistrationJSON.validID(requestID), case .object(let d) = definition,
              Set(d.keys).isSubset(of: ["id", "name", "transport", "runsOn", "auth", "readOnlyTools", "enabledTools", "disabledTools", "limits"]),
              case .string(let id) = d["id"], id.range(of: "^[a-z](?:[a-z0-9-]{0,38}[a-z0-9])?$", options: .regularExpression) != nil,
              case .string(let name) = d["name"], McpRegistrationJSON.printable(name, max: 120), !name.isEmpty,
              case .object(let transport) = d["transport"] else { throw HostClientError.invalidRequest }
        guard case .string(let placement) = d["runsOn"], ["any", "owner_mac", "cloud"].contains(placement),
              case .string(let auth) = d["auth"], ["none", "broker", "oauth"].contains(auth) else { throw HostClientError.invalidRequest }
        for key in ["readOnlyTools", "enabledTools", "disabledTools"] {
            if let field = d[key] {
                if key == "enabledTools", field == .null { continue }
                guard case .array(let values) = field, values.count <= 256,
                      values.allSatisfy({ if case .string(let name) = $0 { return !name.isEmpty && McpRegistrationJSON.printable(name, max: 128) }; return false }) else { throw HostClientError.invalidRequest }
            }
        }
        if let limits = d["limits"] {
            let maxima: [String: Int64] = ["connectTimeoutMs": 120000, "callTimeoutMs": 600000, "maxResultBytes": 16777216, "maxMessageBytes": 33554432]
            guard case .object(let values) = limits, Set(values.keys).isSubset(of: Set(maxima.keys)),
                  values.allSatisfy({ key, value in if case .integer(let n) = value { return n >= 1 && n <= maxima[key]! }; return false }) else { throw HostClientError.invalidRequest }
        }
        try Self.checkPublicTransport(transport)
        // Only safe integral JSON is accepted for configuration; no opaque blobs or floating point coercion.
        let original = try McpRegistrationJSON.canonical(definition)
        guard original.utf8.count <= 32768 else { throw HostClientError.invalidRequest }
        self.requestID = requestID; self.definition = definition; serverID = id
        inputHash = McpRegistrationJSON.hashData(Data(original.utf8))
        bodyData = Data(try McpRegistrationJSON.canonical(.object(["requestId": .string(requestID),
            "expectedInstancePin": .null, "definition": definition])).utf8)
    }
    public init(httpDraft: McpHttpDraft, requestID: String = "mac:" + UUID().uuidString.lowercased()) throws {
        // First-party draft carries informational legacy provenance, not authority. The new operation assigns manual.
        guard case .object(var d) = httpDraft.definition else { throw HostClientError.invalidRequest }
        d.removeValue(forKey: "source"); try self.init(definition: .object(d), requestID: requestID)
    }
    public static func reviewedImport(_ definition: JSONValue) throws -> JSONValue {
        guard case .object(var d) = definition else { throw HostClientError.invalidRequest }
        d.removeValue(forKey: "source")
        return .object(d)
    }
    private static func checkPublicTransport(_ t: [String: JSONValue]) throws {
        let slots: [String: JSONValue]
        switch t["type"] {
        case .string("streamable_http"):
            guard Set(t.keys).isSubset(of: ["type", "url", "headers"]), case .string(let raw) = t["url"],
                  !raw.contains("?"), !raw.contains("#"), !raw.contains("\\"), raw.utf16.count <= 2048,
                  let u = URLComponents(string: raw), let host = u.host, u.user == nil, u.password == nil,
                  u.scheme == "https" || (u.scheme == "http" && ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)) else {
                throw HostClientError.invalidRequest
            }
            if let headers = t["headers"] { guard case .object(let v) = headers else { throw HostClientError.invalidRequest }; slots = v } else { slots = [:] }
        case .string("stdio"):
            guard Set(t.keys).isSubset(of: ["type", "command", "args", "cwd", "env", "searchPath"]),
                  case .string(let command) = t["command"], !command.isEmpty, McpRegistrationJSON.printable(command, max: 1024) else { throw HostClientError.invalidRequest }
            if let args = t["args"] {
                guard case .array(let values) = args, values.count <= 64 else { throw HostClientError.invalidRequest }
                var previous: String?
                for value in values {
                    guard case .string(let arg) = value, McpRegistrationJSON.printable(arg, max: 4096),
                          !McpRegistrationJSON.looksSecret(arg, previous: previous) else { throw HostClientError.invalidRequest }
                    previous = arg
                }
            }
            if let cwd = t["cwd"], cwd != .null { guard case .string(let path) = cwd, path.hasPrefix("/"), McpRegistrationJSON.printable(path, max: 4096) else { throw HostClientError.invalidRequest } }
            if let search = t["searchPath"] {
                guard case .array(let paths) = search, !paths.isEmpty, paths.count <= 16, paths.allSatisfy({ if case .string(let path) = $0 { return path.hasPrefix("/") && !path.contains(":") && McpRegistrationJSON.printable(path, max: 4096) }; return false }) else { throw HostClientError.invalidRequest }
            }
            if let env = t["env"] { guard case .object(let v) = env else { throw HostClientError.invalidRequest }; slots = v } else { slots = [:] }
        default: throw HostClientError.invalidRequest
        }
        guard slots.count <= 64 else { throw HostClientError.invalidRequest }
        for (key, slot) in slots {
            guard McpRegistrationJSON.printable(key, max: 128), case .object(let v) = slot,
                  Set(v.keys).isSubset(of: ["kind", "key", "prefix"]), v["kind"] == .string("secret"),
                  case .string(let slotKey) = v["key"], slotKey.range(of: "^[a-z0-9][a-z0-9_.-]{0,63}$", options: .regularExpression) != nil else { throw HostClientError.invalidRequest }
            if let prefix = v["prefix"] { guard case .string(let value) = prefix, ["", "Bearer "].contains(value) else { throw HostClientError.invalidRequest } }
        }
    }
}

public struct McpRegistrationReceipt: Decodable, Equatable, Sendable {
    public let receiptID: String, requestKeyHash: String, requestIDHash: String, requestHash: String, inputHash: String, originHash: String
    public let instanceID: String, generation: String, definitionPin: String, instancePin: String
    public let registeredAt: Int64
    public init(from decoder: any Decoder) throws {
        let value = try JSONValue(from: decoder)
        guard case .object(let d) = value,
              Set(d.keys) == ["version", "operation", "receiptId", "requestKeyHash", "requestIdHash", "requestHash", "inputHash", "originHash", "instanceId", "generation", "definitionPin", "instancePin", "registeredAt"],
              d["version"] == .integer(1), d["operation"] == .string("mcp.register"),
              case .integer(let time) = d["registeredAt"], (0...9_007_199_254_740_991).contains(time) else { throw HostClientError.contractMismatch }
        func string(_ key: String, pattern: String) throws -> String {
            guard case .string(let v) = d[key], v.range(of: pattern, options: .regularExpression) != nil else { throw HostClientError.contractMismatch }; return v
        }
        let hash = "^[0-9a-f]{64}$", uuid = "^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$"
        receiptID = try string("receiptId", pattern: uuid); generation = try string("generation", pattern: uuid)
        requestKeyHash = try string("requestKeyHash", pattern: hash); requestIDHash = try string("requestIdHash", pattern: hash)
        requestHash = try string("requestHash", pattern: hash); inputHash = try string("inputHash", pattern: hash)
        originHash = try string("originHash", pattern: hash); definitionPin = try string("definitionPin", pattern: hash); instancePin = try string("instancePin", pattern: hash)
        instanceID = try string("instanceId", pattern: "^[a-z](?:[a-z0-9-]{0,38}[a-z0-9])?$"); registeredAt = time
    }
    public func validate(for request: McpRegistrationRequest, namespace: McpRegistrationNamespace) throws {
        let idHash = McpRegistrationJSON.hash(.object(["requestId": .string(request.requestID)]))
        guard instanceID == request.serverID, inputHash == request.inputHash, requestIDHash == idHash, originHash == namespace.originHash,
              requestKeyHash == McpRegistrationJSON.hash(.object(["operation": .string("mcp.register"), "originHash": .string(originHash), "requestIdHash": .string(idHash)])),
              requestHash == McpRegistrationJSON.hash(.object(["version": .integer(1), "operation": .string("mcp.register"), "expectedInstancePin": .null, "definitionPin": .string(definitionPin), "inputHash": .string(inputHash)])),
              instancePin == McpRegistrationJSON.hashData(Data("{\"definitionHash\":\"\(definitionPin)\",\"generation\":\"\(generation)\"}".utf8)) else { throw HostClientError.contractMismatch }
    }
}
public struct McpRegistrationObservation: Decodable, Equatable, Sendable {
    public enum InstanceState: String, Decodable, Sendable { case registered, removed, replaced }
    public let receipt: McpRegistrationReceipt
    public let instanceState: InstanceState
    public init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: McpRegistrationKey.self)
        guard Set(values.allKeys.map(\.stringValue)) == ["receipt", "instanceState"] else { throw HostClientError.contractMismatch }
        receipt = try values.decode(McpRegistrationReceipt.self, forKey: .init("receipt"))
        instanceState = try values.decode(InstanceState.self, forKey: .init("instanceState"))
    }
}
struct McpRegistrationKey: CodingKey {
    let stringValue: String; let intValue: Int? = nil
    init(_ value: String) { stringValue = value }
    init?(stringValue: String) { self.init(stringValue) }
    init?(intValue: Int) { return nil }
}

/// Native hash JSON domains, restricted to the public integral configuration accepted above.
enum McpRegistrationJSON {
    static func validID(_ value: String) -> Bool { value.range(of: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$", options: .regularExpression) != nil }
    static func printable(_ value: String, max: Int) -> Bool { value.utf16.count <= max && value.unicodeScalars.allSatisfy { $0.value >= 32 && $0.value != 127 } }
    static func looksSecret(_ value: String, previous: String?) -> Bool {
        let names = "token|secret|passw|pwd|api[-_]?key|apikey|access[-_]?key|auth|bearer|credential|private[-_]?key|session|cookie"
        let flag = "^--?[A-Za-z0-9_.-]+$"
        if let equal = value.firstIndex(of: "="), value.hasPrefix("-"), String(value[..<equal]).range(of: names, options: [.regularExpression, .caseInsensitive]) != nil { return true }
        if let previous, previous.range(of: flag, options: .regularExpression) != nil, previous.range(of: names, options: [.regularExpression, .caseInsensitive]) != nil, !value.hasPrefix("-") { return true }
        return value.range(of: "^(?:gh[pousr]_|github_pat_|sk-|sk_live_|sk_test_|rk_live_|xox[abprs]-|AKIA|ASIA|AIza|glpat-|ya29\\.|eyJ[A-Za-z0-9_-]{8,}\\.)|://[^/@\\s]+:[^/@\\s]+@", options: .regularExpression) != nil
            || (value.range(of: "^[A-Za-z0-9_+=-]{32,}$", options: .regularExpression) != nil && value.rangeOfCharacter(from: .decimalDigits) != nil && value.rangeOfCharacter(from: .letters) != nil)
    }
    static func canonical(_ value: JSONValue) throws -> String {
        switch value {
        case .null: return "null"
        case .bool(let v): return v ? "true" : "false"
        case .integer(let v): guard (-9_007_199_254_740_991...9_007_199_254_740_991).contains(v) else { throw HostClientError.invalidRequest }; return String(v)
        case .number: throw HostClientError.invalidRequest
        case .string(let v):
            let encoder = JSONEncoder(); encoder.outputFormatting = [.withoutEscapingSlashes]
            return String(decoding: try encoder.encode(v), as: UTF8.self)
        case .array(let v): return "[" + (try v.map(canonical)).joined(separator: ",") + "]"
        case .object(let v):
            func index(_ key: String) -> UInt32? { guard let i = UInt32(key), i < UInt32.max, String(i) == key else { return nil }; return i }
            let keys = v.keys.sorted { a, b in
                switch (index(a), index(b)) { case (.some(let a), .some(let b)): return a < b; case (.some, .none): return true; case (.none, .some): return false; case (.none, .none): return a.utf16.lexicographicallyPrecedes(b.utf16) }
            }
            return "{" + (try keys.map { try canonical(.string($0)) + ":" + canonical(v[$0]!) }).joined(separator: ",") + "}"
        }
    }
    static func hash(_ value: JSONValue) -> String { hashData(Data((try! canonical(value)).utf8)) }
    static func hashData(_ value: Data) -> String { SHA256.hash(data: value).map { String(format: "%02x", $0) }.joined() }
}

struct McpRegistrationPostResponse: Decodable, Sendable {
    let receipt: McpRegistrationReceipt
    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: McpRegistrationKey.self)
        guard Set(c.allKeys.map(\.stringValue)) == ["receipt"] else { throw HostClientError.contractMismatch }
        receipt = try c.decode(McpRegistrationReceipt.self, forKey: .init("receipt"))
    }
}
struct McpRegistrationReadResponse: Decodable, Sendable {
    let registration: McpRegistrationObservation?
    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: McpRegistrationKey.self)
        guard Set(c.allKeys.map(\.stringValue)) == ["registration"] else { throw HostClientError.contractMismatch }
        registration = try c.decodeIfPresent(McpRegistrationObservation.self, forKey: .init("registration"))
    }
}
