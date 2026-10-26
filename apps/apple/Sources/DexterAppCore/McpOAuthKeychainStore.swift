#if os(macOS)
import CryptoKit
import Foundation
import LocalAuthentication
import Security
import DexterKeychainRuntime

// UX-P1-10: the app is the custodian of native MCP OAuth tokens. One Data Protection Keychain generic-password item per
// host + owner + MCP instance, in this signed app's exact access group, non-synchronizing, this-device-only. The owned
// host child reaches it only through its private launcher pipes (request on stdout, result frame on stdin). No defaults,
// files, logs, argv, environment, clipboard or HTTP; no login-Keychain fallback when the signed group is unavailable.

public enum McpOAuthCustodyAvailability: String, Sendable { case available, signingIdentityUnavailable, unavailable }
public enum McpOAuthCustodyFailure: Error, Equatable, Sendable { case invalidScope, signingIdentityUnavailable, unavailable, refused }

public struct McpOAuthCustodyScope: Equatable, Hashable, Sendable {
    public let hostID: String
    public let ownerID: String
    public init(hostID: String, ownerID: String) throws {
        guard mcpOAuthCustodyID(hostID), mcpOAuthCustodyID(ownerID) else { throw McpOAuthCustodyFailure.invalidScope }
        self.hostID = hostID; self.ownerID = ownerID
    }
    public var keychainService: String {
        func hash(_ value: String) -> String { SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined() }
        return "com.dexter.mcp-oauth.v1.host." + hash(hostID) + ".owner." + hash(ownerID)
    }
}

/// Opaque record bytes per MCP instance. Implementations never enumerate, export or log them.
@MainActor public protocol McpOAuthCustodyStore: AnyObject {
    func availability(scope: McpOAuthCustodyScope) -> McpOAuthCustodyAvailability
    func read(scope: McpOAuthCustodyScope, serverID: String) throws -> Data?
    func write(scope: McpOAuthCustodyScope, serverID: String, record: Data) throws
    /// True when an item existed. Removes every generation of the instance (one item per instance).
    func delete(scope: McpOAuthCustodyScope, serverID: String) throws -> Bool
}

/// Production custody. Same Data Protection pattern as the private-memory wrapping key, but tokens rotate, so an
/// existing item is updated in place; background restore never prompts (interaction not allowed).
@MainActor public final class NativeMcpOAuthKeychain: McpOAuthCustodyStore {
    private static let probeAccount = "custody-probe"
    private let runtimeIdentity: () -> RuntimeSigningIdentity
    public init(runtimeIdentity: @escaping () -> RuntimeSigningIdentity = { .current() }) { self.runtimeIdentity = runtimeIdentity }

    private func accessGroup() throws -> String {
        do { return try runtimeIdentity().exactDataProtectionAccessGroup() }
        catch { throw McpOAuthCustodyFailure.signingIdentityUnavailable }
    }
    /// Exact attributes of one item. Pure: no Security call; exercised by tests without touching any Keychain.
    nonisolated static func attributes(scope: McpOAuthCustodyScope, account: String, accessGroup: String) -> [CFString: Any] {
        [kSecClass: kSecClassGenericPassword, kSecAttrService: scope.keychainService, kSecAttrAccount: account,
         kSecAttrAccessGroup: accessGroup, kSecAttrSynchronizable: false, kSecUseDataProtectionKeychain: true]
    }
    private func query(_ scope: McpOAuthCustodyScope, account: String) throws -> [CFString: Any] {
        var value = Self.attributes(scope: scope, account: account, accessGroup: try accessGroup())
        let context = LAContext(); context.interactionNotAllowed = true
        value[kSecUseAuthenticationContext] = context
        return value
    }
    private func item(_ scope: McpOAuthCustodyScope, account: String, data: Bool) throws -> [CFString: Any]? {
        var request = try query(scope, account: account)
        request[kSecReturnAttributes] = true; request[kSecMatchLimit] = kSecMatchLimitOne
        if data { request[kSecReturnData] = true }
        var output: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &output)
        if status == errSecMissingEntitlement { throw McpOAuthCustodyFailure.signingIdentityUnavailable }
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let value = output as? [CFString: Any],
              value[kSecAttrService] as? String == scope.keychainService, value[kSecAttrAccount] as? String == account,
              value[kSecAttrAccessGroup] as? String == (try accessGroup()), value[kSecAttrSynchronizable] as? Bool == false,
              value[kSecAttrAccessible] as? String == (kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String),
              data || value[kSecValueData] == nil else { throw McpOAuthCustodyFailure.unavailable }
        return value
    }
    /// Metadata-only probe of the exact signed group: entitlement and Keychain reachability, never a value.
    public func availability(scope: McpOAuthCustodyScope) -> McpOAuthCustodyAvailability {
        do { _ = try item(scope, account: Self.probeAccount, data: false); return .available }
        catch McpOAuthCustodyFailure.signingIdentityUnavailable { return .signingIdentityUnavailable }
        catch { return .unavailable }
    }
    public func read(scope: McpOAuthCustodyScope, serverID: String) throws -> Data? {
        guard mcpOAuthCustodyServer(serverID) else { throw McpOAuthCustodyFailure.refused }
        guard let value = try item(scope, account: "server." + serverID, data: true) else { return nil }
        guard let bytes = value[kSecValueData] as? Data, (1...mcpOAuthCustodyMaxRecord).contains(bytes.count) else { throw McpOAuthCustodyFailure.unavailable }
        return bytes
    }
    public func write(scope: McpOAuthCustodyScope, serverID: String, record: Data) throws {
        guard mcpOAuthCustodyServer(serverID), (1...mcpOAuthCustodyMaxRecord).contains(record.count) else { throw McpOAuthCustodyFailure.refused }
        let account = "server." + serverID
        let base = try query(scope, account: account)
        if try item(scope, account: account, data: false) != nil {
            let status = SecItemUpdate(base as CFDictionary, [kSecValueData: record] as CFDictionary)
            if status == errSecMissingEntitlement { throw McpOAuthCustodyFailure.signingIdentityUnavailable }
            guard status == errSecSuccess else { throw McpOAuthCustodyFailure.unavailable }
        } else {
            var add = base
            add[kSecAttrAccessible] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly; add[kSecValueData] = record
            add[kSecAttrLabel] = "Dexter · MCP OAuth"
            let status = SecItemAdd(add as CFDictionary, nil)
            if status == errSecMissingEntitlement { throw McpOAuthCustodyFailure.signingIdentityUnavailable }
            guard status == errSecSuccess else { throw McpOAuthCustodyFailure.unavailable }
        }
    }
    public func delete(scope: McpOAuthCustodyScope, serverID: String) throws -> Bool {
        guard mcpOAuthCustodyServer(serverID) else { throw McpOAuthCustodyFailure.refused }
        let status = SecItemDelete(try query(scope, account: "server." + serverID) as CFDictionary)
        if status == errSecMissingEntitlement { throw McpOAuthCustodyFailure.signingIdentityUnavailable }
        if status == errSecItemNotFound { return false }
        guard status == errSecSuccess else { throw McpOAuthCustodyFailure.unavailable }
        return true
    }
}

/// QA injection only; never touches any Keychain. Same scope isolation and semantics as the port.
@MainActor public final class InMemoryMcpOAuthCustodyStore: McpOAuthCustodyStore {
    private var records: [String: Data] = [:]
    public var simulatedAvailability: McpOAuthCustodyAvailability = .available
    public private(set) var writes = 0
    public init() {}
    private func key(_ scope: McpOAuthCustodyScope, _ server: String) -> String { scope.keychainService + "|" + server }
    public func availability(scope: McpOAuthCustodyScope) -> McpOAuthCustodyAvailability { simulatedAvailability }
    public func read(scope: McpOAuthCustodyScope, serverID: String) throws -> Data? {
        guard simulatedAvailability == .available else { throw McpOAuthCustodyFailure.unavailable }; return records[key(scope, serverID)]
    }
    public func write(scope: McpOAuthCustodyScope, serverID: String, record: Data) throws {
        guard simulatedAvailability == .available else { throw McpOAuthCustodyFailure.unavailable }; records[key(scope, serverID)] = record; writes += 1
    }
    public func delete(scope: McpOAuthCustodyScope, serverID: String) throws -> Bool {
        guard simulatedAvailability == .available else { throw McpOAuthCustodyFailure.unavailable }; return records.removeValue(forKey: key(scope, serverID)) != nil
    }
    public var count: Int { records.count }
}

/// Answers the owned host child's custody requests. Strict schema, exact host binding; anything malformed is ignored
/// (nil) and never echoed. Results carry tokens only for a matching `load`.
@MainActor public final class McpOAuthCustodyResponder {
    public static let requestSchema = "dexter.mcp-oauth-custody-request/1"
    public static let resultSchema = "dexter.mcp-oauth-custody-result/1"
    public static let openSchema = "dexter.mcp-oauth-custody-open/1"
    /// Sent once, after the ready object was parsed: the host stays silent until then, so no request ever shares a read
    /// with ready. Carries no secret.
    public static func openFrame(hostID: String) -> Data? {
        guard mcpOAuthCustodyID(hostID), var frame = try? JSONSerialization.data(withJSONObject: ["schema": openSchema, "hostID": hostID], options: [.sortedKeys])
        else { return nil }
        frame.append(0x0a)
        return frame
    }
    private let store: any McpOAuthCustodyStore
    public init(store: any McpOAuthCustodyStore) { self.store = store }

    /// Returns one newline-terminated result frame, or nil to ignore the line.
    public func respond(to object: [String: Any], readyHostID: String) -> Data? {
        guard object["schema"] as? String == Self.requestSchema, object["hostID"] as? String == readyHostID,
              mcpOAuthCustodyInt(object["v"]) == 1, let requestID = object["requestId"] as? String, mcpOAuthCustodyUUID(requestID),
              let type = object["type"] as? String else { return nil }
        let base: Set<String> = ["schema", "hostID", "v", "type", "requestId"]
        var answer: [String: Any] = ["schema": Self.resultSchema, "hostID": readyHostID, "v": 1, "type": "mcp_oauth_custody.result", "requestId": requestID]
        func status(_ value: String) { answer["status"] = value }
        func scope(_ raw: Any?) -> McpOAuthCustodyScope? {
            guard let raw = raw as? [String: Any], Set(raw.keys) == ["installationId", "ownerId"], let host = raw["installationId"] as? String,
                  host == readyHostID, let owner = raw["ownerId"] as? String else { return nil }
            return try? McpOAuthCustodyScope(hostID: host, ownerID: owner)
        }
        func key(_ raw: Any?) -> (scope: McpOAuthCustodyScope, server: String, pin: String, resource: String)? {
            guard let raw = raw as? [String: Any], Set(raw.keys) == ["installationId", "ownerId", "serverId", "instancePin", "resource"],
                  let resolved = scope(["installationId": raw["installationId"] as Any, "ownerId": raw["ownerId"] as Any]),
                  let server = raw["serverId"] as? String, mcpOAuthCustodyServer(server), let pin = raw["instancePin"] as? String,
                  pin.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil, let resource = raw["resource"] as? String, mcpOAuthCustodyResource(resource) else { return nil }
            return (resolved, server, pin, resource)
        }
        do {
            switch type {
            case "mcp_oauth_custody.status":
                guard Set(object.keys) == base.union(["scope"]), let s = scope(object["scope"]) else { return nil }
                if store.availability(scope: s) == .available { status("ok"); answer["custody"] = "data_protection_keychain" } else { status("unavailable") }
            case "mcp_oauth_custody.load":
                guard Set(object.keys) == base.union(["key"]), let k = key(object["key"]) else { return nil }
                guard let bytes = try store.read(scope: k.scope, serverID: k.server) else { status("absent"); break }
                guard let record = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any], mcpOAuthCustodyInt(record["v"]) == 1,
                      record["serverId"] as? String == k.server, record["instancePin"] as? String == k.pin, record["resource"] as? String == k.resource,
                      let tokens = record["tokens"] as? [String: Any], mcpOAuthCustodyTokens(tokens, server: k.server, resource: k.resource) else {
                    // Another generation or endpoint: never returned to this instance.
                    status("absent"); break
                }
                status("ok"); answer["tokens"] = tokens
            case "mcp_oauth_custody.save":
                guard Set(object.keys) == base.union(["key", "tokens"]), let k = key(object["key"]), let tokens = object["tokens"] as? [String: Any],
                      mcpOAuthCustodyTokens(tokens, server: k.server, resource: k.resource) else { return nil }
                var record = try JSONSerialization.data(withJSONObject: ["v": 1, "serverId": k.server, "instancePin": k.pin, "resource": k.resource, "tokens": tokens],
                                                        options: [.sortedKeys, .withoutEscapingSlashes])
                defer { record.resetBytes(in: 0..<record.count) }
                guard record.count <= mcpOAuthCustodyMaxRecord else { status("refused"); break }
                try store.write(scope: k.scope, serverID: k.server, record: record); status("ok")
            case "mcp_oauth_custody.remove":
                guard Set(object.keys) == base.union(["scope", "serverId"]), let s = scope(object["scope"]),
                      let server = object["serverId"] as? String, mcpOAuthCustodyServer(server) else { return nil }
                status(try store.delete(scope: s, serverID: server) ? "ok" : "absent")
            default: return nil
            }
        } catch McpOAuthCustodyFailure.refused { status("refused") }
        catch { status("unavailable"); answer.removeValue(forKey: "tokens") }
        guard var frame = try? JSONSerialization.data(withJSONObject: answer, options: [.sortedKeys, .withoutEscapingSlashes]) else { return nil }
        frame.append(0x0a)
        guard frame.count <= 16_384 else { frame.resetBytes(in: 0..<frame.count); return nil }
        return frame
    }
}

let mcpOAuthCustodyMaxRecord = 15_000
/// JSON integer only (a JSON boolean also bridges to NSNumber and is refused).
func mcpOAuthCustodyInt(_ value: Any?) -> Int64? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), Double(number.int64Value) == number.doubleValue else { return nil }
    return number.int64Value
}
func mcpOAuthCustodyID(_ value: String) -> Bool { value.range(of: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$", options: .regularExpression) != nil }
func mcpOAuthCustodyServer(_ value: String) -> Bool { value.range(of: "^[a-z]([a-z0-9-]{0,38}[a-z0-9])?$", options: .regularExpression) != nil }
func mcpOAuthCustodyUUID(_ value: String) -> Bool {
    value.range(of: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", options: .regularExpression) != nil
}
func mcpOAuthCustodyResource(_ value: String) -> Bool {
    guard value.utf8.count <= 2048, let url = URL(string: value), let scheme = url.scheme, ["https", "http"].contains(scheme),
          url.user == nil, url.password == nil, url.fragment == nil, url.host != nil else { return false }
    return true
}
/// Exact token record shape of the host (`McpOAuthTokens`), values bounded; resource and instance must match the key.
func mcpOAuthCustodyTokens(_ tokens: [String: Any], server: String, resource: String) -> Bool {
    let keys: Set<String> = ["accessToken", "clientId", "clientSecret", "expiresAt", "issuer", "refreshToken", "resource", "resourceIndicator", "scope", "serverId", "tokenEndpoint"]
    guard Set(tokens.keys) == keys, tokens["serverId"] as? String == server, tokens["resource"] as? String == resource else { return false }
    func text(_ key: String, nullable: Bool = false) -> Bool {
        if nullable, tokens[key] is NSNull { return true }
        guard let value = tokens[key] as? String else { return false }
        return (1...8192).contains(value.utf8.count)
    }
    let expires = tokens["expiresAt"]
    let expiresValid = expires is NSNull || (mcpOAuthCustodyInt(expires).map { $0 >= 0 } ?? false)
    return ["resourceIndicator", "issuer", "tokenEndpoint", "clientId", "accessToken"].allSatisfy { text($0) }
        && ["clientSecret", "refreshToken", "scope"].allSatisfy { text($0, nullable: true) } && expiresValid
}
#endif
