#if os(macOS)
import Foundation
import XCTest
import DexterHostClient
@testable import DexterAppCore

/// Owner-private connections service configuration: compiled SDK + AppCore controller + the real supervisor ACK path.
/// Keychain custody is the QA in-memory store here (the signed Keychain item is Root's signing qualification, not proven).
@MainActor private final class ConnectionsChild: LocalHostChild {
    let configuration: LocalHostLaunchConfiguration
    var isRunning = false
    var terminationStatus: Int32 { 0 }
    var frames: [[String: Any]] = []
    var onStdout: (@Sendable (Data) -> Void)?
    var onExit: (@Sendable () -> Void)?
    init(_ configuration: LocalHostLaunchConfiguration) { self.configuration = configuration }
    func run(onStdout: @escaping @Sendable (Data) -> Void, onStderr: @escaping @Sendable (Data) -> Void, onExit: @escaping @Sendable () -> Void) throws {
        self.onStdout = onStdout; self.onExit = onExit; isRunning = true
        onStdout(try JSONSerialization.data(withJSONObject: ["status": "ready", "mode": "local-development", "url": configuration.hostAddress, "hostId": "host_qa",
            "engineExecution": "disabled", "mcpGateway": "disabled", "deviceTurnTools": "disabled", "deviceChannel": ["status": "unconfigured"]]))
    }
    func provideConnectionsCapabilityFrame(_ frame: Data) throws { frames.append(try XCTUnwrap(JSONSerialization.jsonObject(with: frame) as? [String: Any])) }
    func requestGracefulStop() { isRunning = false; onExit?() }
    func ack(_ id: String, status: String, code: String? = nil, extra: Bool = false) throws {
        var object: [String: Any] = ["schema": "dexter.connections-capability-ack/1", "requestId": id, "hostID": "host_qa", "status": status]
        if let code { object["code"] = code }
        if extra { object["capability"] = "must-never-be-echoed" }
        var data = try JSONSerialization.data(withJSONObject: object); data.append(10); onStdout?(data)
    }
}
private let capabilityText = "dxcap_" + String(repeating: "Z", count: 40) + "_synthetic"

@MainActor final class ConnectionsPlatformTests: XCTestCase {
    private func config() throws -> LocalHostLaunchConfiguration {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("dx-connections-qa-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let node = directory.appendingPathComponent("node"), cli = directory.appendingPathComponent("fixture.js")
        try Data("synthetic executable is never launched".utf8).write(to: node); try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: node.path)
        try Data("synthetic source is never executed".utf8).write(to: cli)
        return LocalHostLaunchConfiguration(node: node, cli: cli, dataDir: directory.appendingPathComponent("data"))
    }
    private func scope(_ generation: Int = 1) throws -> ConnectionsCapabilityScope {
        try ConnectionsCapabilityScope(hostID: "host_qa", ownerID: "owner_qa", origin: "https://connections.dexter.test", generation: generation)
    }
    private func status(_ request: [String: Any]?, owner: String = "owner_qa") throws -> ConnectionsConfigurationStatus {
        var object: [String: Any] = ["version": 1, "hostId": "host_qa", "ownerId": owner,
            "configuration": ["revision": 1, "generation": 1, "origin": "https://connections.dexter.test", "enabled": true, "credentialRef": "connections-platform", "updatedAt": 1],
            "runtime": ["state": "active", "reason": NSNull(), "origin": "https://connections.dexter.test", "generation": 1],
            "custody": ["channel": "app_private_channel", "state": "locked", "generation": NSNull()], "privateRequest": NSNull()]
        if let request { object["privateRequest"] = request }
        return try JSONDecoder().decode(ConnectionsConfigurationStatus.self, from: JSONSerialization.data(withJSONObject: object))
    }

    func testClosedOriginFrameScopeOneShotAndCreateOnlyCustody() throws {
        for ok in ["https://connections.dexter.test", "https://conn.example.com"] { XCTAssertEqual(try connectionsPlatformOrigin(ok), ok) }
        for bad in ["http://connections.dexter.test", "https://connections.dexter.test/", "https://connections.dexter.test:8443", "https://Connections.dexter.test",
                    "https://127.0.0.1", "https://localhost", "https://svc.localhost", "https://intranet", "https://user@x.example.com", "https://x.example.com?q=1"] {
            XCTAssertThrowsError(try connectionsPlatformOrigin(bad), bad)
        }
        XCTAssertNil(ConnectionsOwnedCapability(capability: "short")); XCTAssertNil(ConnectionsOwnedCapability(capability: capabilityText + " "))
        XCTAssertNotEqual(try scope(1).keychainService, try scope(2).keychainService, "each credential generation is its own custody item")
        XCTAssertThrowsError(try ConnectionsCapabilityScope(hostID: "host_qa", ownerID: "owner_qa", origin: "https://localhost", generation: 1))
        let set = try ConnectionsPrivateFrame.set(try ConnectionsPrivateIntent(scope: scope(), operation: .set), capability: XCTUnwrap(ConnectionsOwnedCapability(capability: capabilityText)))
        XCTAssertEqual(set.description, "ConnectionsPrivateFrame(redacted)")
        var bytes = Data(); try set.handoff { bytes = $0 }
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["schema", "requestId", "hostID", "operation", "origin", "generation", "capability"])
        XCTAssertEqual(object["capability"] as? String, capabilityText); XCTAssertEqual(bytes.last, 0x0a)
        XCTAssertThrowsError(try set.handoff { _ in }, "one shot")
        var lockBytes = Data(); try ConnectionsPrivateFrame.lock(try ConnectionsPrivateIntent(scope: scope(), operation: .lock)).handoff { lockBytes = $0 }
        XCTAssertNil((try JSONSerialization.jsonObject(with: lockBytes) as? [String: Any])?["capability"])
        let store = InMemoryConnectionsCapabilityStore()
        try store.save(scope: scope(), capability: XCTUnwrap(ConnectionsOwnedCapability(capability: capabilityText)))
        XCTAssertThrowsError(try store.save(scope: scope(), capability: XCTUnwrap(ConnectionsOwnedCapability(capability: capabilityText)))) {
            XCTAssertEqual($0 as? ConnectionsPrivateFailure, .capabilityExists) }
        XCTAssertEqual(store.status(scope: try scope(2)), .missing, "no other generation ever stands in")
        XCTAssertEqual(String(describing: try store.load(scope: scope())), "ConnectionsOwnedCapability(redacted)")
    }

    func testSupervisorACKIsExactAndALostACKIsSettledOnlyByTheOriginalRequestID() async throws {
        let config = try config(); defer { try? FileManager.default.removeItem(at: config.node.deletingLastPathComponent()) }
        let child = ConnectionsChild(config), supervisor = LocalHostSupervisor(configuration: config, makeChild: { _, _ in child }, portIsFree: { _ in true })
        _ = await supervisor.start(timeout: .seconds(1)); defer { Task { _ = await supervisor.stop(grace: .seconds(1)) } }
        func frame(_ op: ConnectionsPrivateOperation) throws -> ConnectionsPrivateFrame {
            let intent = try ConnectionsPrivateIntent(scope: scope(), operation: op)
            return op == .set ? try .set(intent, capability: XCTUnwrap(ConnectionsOwnedCapability(capability: capabilityText))) : try .lock(intent)
        }
        func waitFrame(_ n: Int) async throws { for _ in 0..<200 { if child.frames.count >= n { return }; try await Task.sleep(for: .milliseconds(2)) } }
        // ready
        let first = try frame(.set), id1 = first.intent.requestID
        let sending = Task { @MainActor in try await supervisor.sendConnectionsCapabilityFrame(first, timeout: .seconds(2)) }
        try await waitFrame(1); try child.ack(id1, status: "ready"); try await sending.value
        XCTAssertEqual(child.frames[0]["capability"] as? String, capabilityText)
        // refused (fixed code) is a definite refusal, not unknown
        let second = try frame(.set), id2 = second.intent.requestID
        let refusing = Task { @MainActor in try await supervisor.sendConnectionsCapabilityFrame(second, timeout: .seconds(2)) }
        try await waitFrame(2); try child.ack(id2, status: "refused", code: "private_input_refused")
        do { try await refusing.value; XCTFail("refused") } catch { XCTAssertEqual(error as? ConnectionsPrivateFailure, .refused) }
        // an ACK with extra fields proves nothing; timeout → unknown, kept as the unconfirmed intent
        let third = try frame(.lock), intent3 = third.intent
        let lost = Task { @MainActor in try await supervisor.sendConnectionsCapabilityFrame(third, timeout: .milliseconds(80)) }
        try await waitFrame(3); try child.ack(intent3.requestID, status: "locked", extra: true)
        do { try await lost.value; XCTFail("unknown") } catch { XCTAssertEqual(error as? ConnectionsPrivateFailure, .outcomeUnknown) }
        XCTAssertEqual(supervisor.unconfirmedConnectionsIntent, intent3)
        do { try await supervisor.sendConnectionsCapabilityFrame(try frame(.set), timeout: .milliseconds(20)); XCTFail("no new set while unconfirmed") }
        catch { XCTAssertEqual(error as? ConnectionsPrivateFailure, .bridgeUnavailable) }
        let request: [String: Any] = ["requestId": intent3.requestID, "operation": "lock", "generation": 1, "state": "locked"]
        XCTAssertFalse(supervisor.reconcileConnectionsCapability(intent3, status: try status(["requestId": UUID().uuidString.lowercased(), "operation": "lock", "generation": 1, "state": "locked"])))
        XCTAssertFalse(supervisor.reconcileConnectionsCapability(intent3, status: try status(request, owner: "owner_other")))
        XCTAssertFalse(supervisor.reconcileConnectionsCapability(intent3, status: try status(["requestId": intent3.requestID, "operation": "lock", "generation": 2, "state": "locked"])))
        XCTAssertTrue(supervisor.reconcileConnectionsCapability(intent3, status: try status(request)))
        XCTAssertNil(supervisor.unconfirmedConnectionsIntent)
        XCTAssertEqual(child.frames.count, 3, "no automatic resend")
    }

    /// SDK + controller → real HTTP → real HostServices (`scripts/connections-config-live.sh`); private frames through the real pipe reader.
    func testLiveControllerAgainstRealHost() async throws {
        guard let path = ProcessInfo.processInfo.environment["DEXTER_CONNECTIONS_CONFIG_LIVE"],
              let info = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path))) as? [String: Any] else { throw XCTSkip("no synthetic live host") }
        let control = URL(string: info["controlUrl"] as! String)!, hostID = info["hostId"] as! String
        func post(_ path: String, _ body: Data = Data()) async throws -> [String: Any] {
            var request = URLRequest(url: control.appendingPathComponent(path)); request.httpMethod = "POST"; request.httpBody = body
            let (data, _) = try await URLSession(configuration: .ephemeral).data(for: request)
            return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        }
        var unconfirmed: ConnectionsPrivateIntent?
        let channel = ConnectionsPrivateChannel(available: { $0 == hostID }, send: { frame in
            var bytes = Data(); try frame.handoff { bytes = $0 }
            let reply = try await post("frame", bytes); bytes.resetBytes(in: 0..<bytes.count)
            if reply["dropped"] as? Bool == true { unconfirmed = frame.intent; throw ConnectionsPrivateFailure.outcomeUnknown }
            let ack = try XCTUnwrap(reply["ack"] as? [String: Any])
            XCTAssertNil(ack["capability"]); XCTAssertEqual(ack["requestId"] as? String, frame.intent.requestID)
            if ack["status"] as? String == "refused" { throw ConnectionsPrivateFailure.refused }
        }, reconcile: { intent, status in
            guard unconfirmed == intent, let request = status.privateRequest, request.requestId == intent.requestID, request.operation == intent.operation,
                  request.generation == intent.scope.generation, status.ownerId == intent.scope.ownerID else { return false }
            unconfirmed = nil; return true
        }, uncertain: { unconfirmed })
        let store = InMemoryConnectionsCapabilityStore()
        func controller(_ url: String) -> ConnectionsPlatformSettingsController {
            ConnectionsPlatformSettingsController(hostID: hostID, client: HostClient(baseURL: URL(string: url)!), isCurrent: { true }, channel: channel, store: store)
        }
        func settle(_ c: ConnectionsPlatformSettingsController) async throws { for _ in 0..<400 { if !c.busy { try await Task.sleep(for: .milliseconds(30)); if !c.busy { return } }; try await Task.sleep(for: .milliseconds(10)) } }
        let first = controller(info["url"] as! String); first.open(); try await settle(first)
        XCTAssertEqual(first.status?.runtime.state, .inactive); XCTAssertEqual(first.status?.runtime.reason, .disabled)
        first.origin = "https://connections.dexter.test"; first.enabled = true
        XCTAssertTrue(first.canSave); first.save(); try await settle(first)
        XCTAssertEqual(first.notice, .restartRequired); XCTAssertEqual(first.status?.runtime.state, .restartRequired); XCTAssertFalse(first.canStoreCapability)
        // Lost response of a renewal: the original request is kept and only GET of its receipt settles it.
        _ = try await post("drop-next-put-response"); first.save(renewCredential: true); try await settle(first)
        XCTAssertEqual(first.notice, .settingsUnknown); XCTAssertNotNil(first.pendingSettings); XCTAssertFalse(first.canSave)
        first.verify(); try await settle(first)
        XCTAssertNil(first.pendingSettings); XCTAssertEqual(first.notice, .restartRequired); XCTAssertEqual(first.status?.configuration.generation, 2)
        let puts = try await post("counts")["puts"] as? Int; XCTAssertEqual(puts, 2, "no second write")
        first.close()
        // The host restarts: the planner composes the service from the saved metadata; custody is empty.
        let restarted = try await post("restart"), second = controller(restarted["url"] as! String)
        second.open(); try await settle(second)
        XCTAssertEqual(second.status?.runtime.state, .active); XCTAssertEqual(second.status?.runtime.generation, 2); XCTAssertEqual(second.capabilityStatus, .missing)
        XCTAssertTrue(second.canStoreCapability)
        second.storeCapability(try XCTUnwrap(ConnectionsOwnedCapability(capability: capabilityText))); try await settle(second)
        XCTAssertEqual(second.notice, .ready); XCTAssertEqual(second.status?.custody.state, .ready); XCTAssertEqual(second.status?.custody.generation, 2)
        XCTAssertEqual(store.saves, 1)
        // Lost ACK of a lock: unknown, then settled by GET of the exact request id.
        _ = try await post("drop-next-ack"); second.lock(); try await settle(second)
        XCTAssertEqual(second.notice, .privateUnknown); XCTAssertNotNil(second.pendingPrivate)
        second.verify(); try await settle(second)
        XCTAssertNil(second.pendingPrivate); XCTAssertEqual(second.notice, .locked); XCTAssertEqual(second.status?.custody.state, .locked)
        second.close()
        // Next launch: the controller restores once from custody (exact scope), never asking for the capability again.
        let again = try await post("restart"), third = controller(again["url"] as! String)
        third.open(); try await settle(third); try await settle(third)
        // One load per delivery (after the owner stored it, and this restore); one save ever.
        XCTAssertEqual(third.status?.custody.state, .ready); XCTAssertEqual(store.loads, 2); XCTAssertEqual(store.saves, 1)
        let frames = try await post("counts")["frames"] as? Int; XCTAssertEqual(frames, 3)
        XCTAssertFalse(String(describing: third.status as Any).contains(capabilityText))
        third.close()
    }
}
#endif
