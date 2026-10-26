#if os(macOS)
import Foundation
import Security
import XCTest
import DexterKeychainRuntime
@testable import DexterAppCore

/// UX-P1-10 app custodian. No process is launched, no Keychain item is read or written, no account or provider:
/// custody is in memory and the production Keychain attributes are checked as pure values.
@MainActor private final class CustodySyntheticChild: LocalHostChild {
    let configuration: LocalHostLaunchConfiguration
    var isRunning = false
    var terminationStatus: Int32 { 0 }
    /// Frames the app wrote to the private stdin pipe, in order.
    var frames: [[String: Any]] = []
    /// Host request lines, each sent after the previous frame from the app (the first one after the app's open).
    var script: [[String: Any]] = []
    private var stdout: (@Sendable (Data) -> Void)?
    private var exit: (@Sendable () -> Void)?
    init(_ configuration: LocalHostLaunchConfiguration) { self.configuration = configuration }
    func run(onStdout: @escaping @Sendable (Data) -> Void, onStderr: @escaping @Sendable (Data) -> Void,
             onExit: @escaping @Sendable () -> Void) throws {
        stdout = onStdout; exit = onExit; isRunning = true
        let ready: [String: Any] = ["status": "ready", "mode": "local-development", "url": configuration.hostAddress,
            "hostId": "synthetic-host-a", "engineExecution": "disabled", "mcpGateway": configuration.enableMcp ? "enabled" : "disabled",
            "deviceTurnTools": "disabled", "deviceChannel": ["status": "unconfigured"]]
        // Pretty-printed like the host; nothing else in this read.
        onStdout(try JSONSerialization.data(withJSONObject: ready, options: [.prettyPrinted]))
    }
    func requestGracefulStop() { isRunning = false; exit?() }
    func provideMcpOAuthCustodyFrame(_ frame: Data) throws {
        XCTAssertEqual(frame.last, 0x0a)
        frames.append(try XCTUnwrap(JSONSerialization.jsonObject(with: frame) as? [String: Any]))
        if !script.isEmpty { try send(script.removeFirst()) }
    }
    func send(_ object: [String: Any]) throws {
        var line = try JSONSerialization.data(withJSONObject: object); line.append(0x0a); stdout?(line)
    }
}

@MainActor final class McpOAuthCustodyTests: XCTestCase {
    private let host = "synthetic-host-a", owner = "owner_synthetic"
    private let resource = "https://mcp.example.test/mcp"
    private let pinA = String(repeating: "a", count: 64), pinB = String(repeating: "b", count: 64)
    private var sequence = 0
    private func tokens(_ server: String = "notion") -> [String: Any] {
        ["serverId": server, "resource": resource, "resourceIndicator": resource, "issuer": "https://auth.example.test",
         "tokenEndpoint": "https://auth.example.test/token", "clientId": "client-synthetic", "clientSecret": NSNull(), "accessToken": "synthetic-access",
         "refreshToken": "synthetic-refresh", "expiresAt": 1, "scope": NSNull()]
    }
    private func request(_ type: String, _ extra: [String: Any], hostID: String? = nil) -> [String: Any] {
        sequence += 1
        var object: [String: Any] = ["schema": McpOAuthCustodyResponder.requestSchema, "hostID": hostID ?? host, "v": 1, "type": type,
                                     "requestId": String(format: "00000000-0000-4000-8000-%012d", sequence)]
        object.merge(extra) { $1 }
        return object
    }
    private var scope: [String: Any] { ["installationId": host, "ownerId": owner] }
    private func key(_ server: String = "notion", pin: String? = nil, resource: String? = nil) -> [String: Any] {
        ["installationId": host, "ownerId": owner, "serverId": server, "instancePin": pin ?? pinA, "resource": resource ?? self.resource]
    }
    private func result(_ data: Data?) throws -> [String: Any] {
        let bytes = try XCTUnwrap(data)
        XCTAssertEqual(bytes.last, 0x0a)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
    }
    private func status(_ responder: McpOAuthCustodyResponder, _ object: [String: Any]) throws -> String? {
        try result(responder.respond(to: object, readyHostID: host))["status"] as? String
    }

    func testResponderKeysCustodyByExactInstanceAndResource() throws {
        let store = InMemoryMcpOAuthCustodyStore(), responder = McpOAuthCustodyResponder(store: store)
        let handshake = try result(responder.respond(to: request("mcp_oauth_custody.status", ["scope": scope]), readyHostID: host))
        XCTAssertEqual(handshake["status"] as? String, "ok"); XCTAssertEqual(handshake["custody"] as? String, "data_protection_keychain")
        XCTAssertEqual(handshake["schema"] as? String, McpOAuthCustodyResponder.resultSchema); XCTAssertEqual(handshake["hostID"] as? String, host)
        XCTAssertNil(handshake["tokens"])
        XCTAssertEqual(try status(responder, request("mcp_oauth_custody.load", ["key": key()])), "absent")
        XCTAssertEqual(try status(responder, request("mcp_oauth_custody.save", ["key": key(), "tokens": tokens()])), "ok")
        let loaded = try result(responder.respond(to: request("mcp_oauth_custody.load", ["key": key()]), readyHostID: host))
        XCTAssertEqual(loaded["status"] as? String, "ok")
        let returned = try XCTUnwrap(loaded["tokens"] as? [String: Any])
        XCTAssertEqual(returned["accessToken"] as? String, "synthetic-access"); XCTAssertTrue(returned["clientSecret"] is NSNull)
        // A recreated instance (new pin) or another endpoint never receives these tokens.
        XCTAssertEqual(try status(responder, request("mcp_oauth_custody.load", ["key": key(pin: pinB)])), "absent")
        XCTAssertEqual(try status(responder, request("mcp_oauth_custody.load", ["key": key(resource: "https://other.example.test/mcp")])), "absent")
        // One item per instance: a new generation replaces the previous one.
        XCTAssertEqual(try status(responder, request("mcp_oauth_custody.save", ["key": key(pin: pinB), "tokens": tokens()])), "ok")
        XCTAssertEqual(store.count, 1)
        XCTAssertEqual(try status(responder, request("mcp_oauth_custody.load", ["key": key()])), "absent")
        XCTAssertEqual(try status(responder, request("mcp_oauth_custody.remove", ["scope": scope, "serverId": "notion"])), "ok")
        XCTAssertEqual(store.count, 0)
        XCTAssertEqual(try status(responder, request("mcp_oauth_custody.remove", ["scope": scope, "serverId": "notion"])), "absent")
    }

    func testResponderIgnoresOrRefusesAnythingNotExact() throws {
        let store = InMemoryMcpOAuthCustodyStore(), responder = McpOAuthCustodyResponder(store: store)
        // Another host, another installation in the scope, boolean version, extra fields, bad ids, unknown types: ignored.
        XCTAssertNil(responder.respond(to: request("mcp_oauth_custody.status", ["scope": scope], hostID: "other-host"), readyHostID: host))
        XCTAssertNil(responder.respond(to: request("mcp_oauth_custody.status", ["scope": ["installationId": "other-host", "ownerId": owner]]), readyHostID: host))
        var boolean = request("mcp_oauth_custody.status", ["scope": scope]); boolean["v"] = true
        XCTAssertNil(responder.respond(to: boolean, readyHostID: host))
        XCTAssertNil(responder.respond(to: request("mcp_oauth_custody.status", ["scope": scope, "extra": 1]), readyHostID: host))
        var badID = request("mcp_oauth_custody.status", ["scope": scope]); badID["requestId"] = "not-a-uuid"
        XCTAssertNil(responder.respond(to: badID, readyHostID: host))
        XCTAssertNil(responder.respond(to: request("mcp_oauth_custody.save", ["key": key("Bad Id"), "tokens": tokens()]), readyHostID: host))
        XCTAssertNil(responder.respond(to: request("mcp_oauth_custody.save", ["key": key(), "tokens": tokens("other")]), readyHostID: host), "tokens of another instance")
        var extra = tokens(); extra["password"] = "synthetic"
        XCTAssertNil(responder.respond(to: request("mcp_oauth_custody.save", ["key": key(), "tokens": extra]), readyHostID: host))
        XCTAssertNil(responder.respond(to: request("mcp_oauth_custody.export", ["scope": scope]), readyHostID: host))
        XCTAssertEqual(store.writes, 0)
        // Over the record budget: refused, not truncated, nothing written.
        var huge = tokens(); huge["accessToken"] = String(repeating: "x", count: 8_000); huge["refreshToken"] = String(repeating: "y", count: 8_000)
        XCTAssertEqual(try status(responder, request("mcp_oauth_custody.save", ["key": key(), "tokens": huge])), "refused")
        XCTAssertEqual(store.writes, 0)
        // Custody not available (unsigned runtime, locked Keychain): an honest status, never tokens, nothing elsewhere.
        store.simulatedAvailability = .signingIdentityUnavailable
        XCTAssertEqual(try status(responder, request("mcp_oauth_custody.status", ["scope": scope])), "unavailable")
        let load = try result(responder.respond(to: request("mcp_oauth_custody.load", ["key": key()]), readyHostID: host))
        XCTAssertEqual(load["status"] as? String, "unavailable"); XCTAssertNil(load["tokens"])
    }

    func testKeychainItemAttributesArePinnedWithoutTouchingAnyKeychain() throws {
        let scope = try McpOAuthCustodyScope(hostID: host, ownerID: owner)
        let other = try McpOAuthCustodyScope(hostID: "synthetic-host-b", ownerID: owner)
        XCTAssertNotEqual(scope.keychainService, other.keychainService, "one service per host + owner")
        XCTAssertTrue(scope.keychainService.hasPrefix("com.dexter.mcp-oauth.v1.host."))
        XCTAssertFalse(scope.keychainService.contains(host), "identifiers are hashed in the item service")
        let attributes = NativeMcpOAuthKeychain.attributes(scope: scope, account: "server.notion", accessGroup: "ABCDE12345.com.dexter.synthetic")
        XCTAssertEqual(attributes[kSecClass] as? String, kSecClassGenericPassword as String)
        XCTAssertEqual(attributes[kSecAttrService] as? String, scope.keychainService)
        XCTAssertEqual(attributes[kSecAttrAccount] as? String, "server.notion")
        XCTAssertEqual(attributes[kSecAttrAccessGroup] as? String, "ABCDE12345.com.dexter.synthetic", "exact signed group, never a wildcard")
        XCTAssertEqual(attributes[kSecAttrSynchronizable] as? Bool, false)
        XCTAssertEqual(attributes[kSecUseDataProtectionKeychain] as? Bool, true)
        XCTAssertNil(attributes[kSecValueData]); XCTAssertNil(attributes[kSecReturnData])
        XCTAssertThrowsError(try McpOAuthCustodyScope(hostID: "bad host", ownerID: owner))
    }

    func testUnsignedRuntimeHasNoCustodyAndNoFallback() throws {
        // No team / exact access group: refused before any Keychain call (no login-Keychain or file fallback exists).
        let unsigned = RuntimeSigningIdentity(validityStatus: 0, bundleIdentifier: "com.dexter.qa", codeIdentifier: "com.dexter.qa", teamIdentifier: nil,
                                              applicationIdentifier: "com.dexter.qa", accessGroups: [])
        let keychain = NativeMcpOAuthKeychain(runtimeIdentity: { unsigned })
        let custody = try McpOAuthCustodyScope(hostID: host, ownerID: owner)
        XCTAssertEqual(keychain.availability(scope: custody), .signingIdentityUnavailable)
        XCTAssertThrowsError(try keychain.read(scope: custody, serverID: "notion")) { XCTAssertEqual($0 as? McpOAuthCustodyFailure, .signingIdentityUnavailable) }
        XCTAssertThrowsError(try keychain.write(scope: custody, serverID: "notion", record: Data("{}".utf8))) { XCTAssertEqual($0 as? McpOAuthCustodyFailure, .signingIdentityUnavailable) }
        XCTAssertThrowsError(try keychain.delete(scope: custody, serverID: "notion")) { XCTAssertEqual($0 as? McpOAuthCustodyFailure, .signingIdentityUnavailable) }
        let responder = McpOAuthCustodyResponder(store: keychain)
        XCTAssertEqual(try status(responder, request("mcp_oauth_custody.status", ["scope": scope])), "unavailable", "the host keeps tokens in memory, reported as not persisted")
    }

    private func configuration(enableMcp: Bool) throws -> (LocalHostLaunchConfiguration, URL) {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("dexter-oauth-custody-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let node = directory.appendingPathComponent("node"), cli = directory.appendingPathComponent("host.js")
        try Data("synthetic executable never launched".utf8).write(to: node)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: node.path)
        try Data("synthetic CLI never executed".utf8).write(to: cli)
        // Never the product ports; no listener is created by the synthetic child anyway.
        return (LocalHostLaunchConfiguration(node: node, cli: cli, dataDir: directory.appendingPathComponent("data"), port: UInt16.random(in: 49_152...60_000),
                                             enableMcp: enableMcp), directory)
    }
    private func eventually(_ condition: () -> Bool) async -> Bool {
        for _ in 0..<100 where !condition() { try? await Task.sleep(for: .milliseconds(10)) }
        return condition()
    }

    func testSupervisorOpensCustodyAfterReadyAndAnswersOnlyItsOwnedChild() async throws {
        let (config, directory) = try configuration(enableMcp: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = InMemoryMcpOAuthCustodyStore(), child = CustodySyntheticChild(config)
        child.script = [request("mcp_oauth_custody.status", ["scope": scope]), request("mcp_oauth_custody.save", ["key": key(), "tokens": tokens()]),
                        request("mcp_oauth_custody.load", ["key": key()])]
        let supervisor = LocalHostSupervisor(configuration: config, makeChild: { _, _ in child }, portIsFree: { _ in true }, mcpOAuthCustodyStore: store)
        let state = await supervisor.start(timeout: .seconds(1))
        XCTAssertEqual(state, .running(address: config.hostAddress))
        let completed = await eventually { child.frames.count == 4 }
        XCTAssertTrue(completed)
        // First frame: the open, sent only after ready was parsed; it carries no secret.
        XCTAssertEqual(child.frames[0] as NSDictionary, ["schema": McpOAuthCustodyResponder.openSchema, "hostID": host] as NSDictionary)
        XCTAssertEqual(child.frames[1]["status"] as? String, "ok"); XCTAssertEqual(child.frames[1]["custody"] as? String, "data_protection_keychain")
        XCTAssertEqual(child.frames[2]["status"] as? String, "ok"); XCTAssertNil(child.frames[2]["tokens"])
        XCTAssertEqual((child.frames[3]["tokens"] as? [String: Any])?["accessToken"] as? String, "synthetic-access")
        XCTAssertTrue(child.frames.allSatisfy { $0["hostID"] as? String == host })
        XCTAssertEqual(store.count, 1)
        XCTAssertFalse(config.arguments.contains(where: { $0.contains("synthetic-access") }), "never in argv")
        // A request naming another host is ignored: no frame, nothing echoed.
        try child.send(request("mcp_oauth_custody.load", ["key": key()], hostID: "other-host"))
        try? await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(child.frames.count, 4)
        _ = await supervisor.stop(grace: .seconds(1))
    }

    func testWithoutMcpThereIsNoCustodianAndNoOpen() async throws {
        let (config, directory) = try configuration(enableMcp: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        let child = CustodySyntheticChild(config)
        let supervisor = LocalHostSupervisor(configuration: config, makeChild: { _, _ in child }, portIsFree: { _ in true })
        let state = await supervisor.start(timeout: .seconds(1))
        XCTAssertEqual(state, .running(address: config.hostAddress))
        try child.send(request("mcp_oauth_custody.status", ["scope": scope]))
        try? await Task.sleep(for: .milliseconds(50))
        XCTAssertTrue(child.frames.isEmpty, "no open and no answer without the MCP custodian")
        _ = await supervisor.stop(grace: .seconds(1))
    }
}
#endif
