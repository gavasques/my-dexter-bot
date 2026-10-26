#if os(macOS)
import Foundation
import XCTest
@testable import DexterAppCore

/// These tests launch no process and touch no Keychain, account or provider.
@MainActor private final class BrowserUseSyntheticChild: LocalHostChild {
    let configuration: LocalHostLaunchConfiguration
    var isRunning = false
    var terminationStatus: Int32 { 0 }
    var acknowledges = true
    var sendsWrongHostFirst = true
    var frames: [[String: String]] = []
    private var stdout: (@Sendable (Data) -> Void)?
    private var exit: (@Sendable () -> Void)?
    init(_ configuration: LocalHostLaunchConfiguration) { self.configuration = configuration }
    func run(onStdout: @escaping @Sendable (Data) -> Void, onStderr: @escaping @Sendable (Data) -> Void,
             onExit: @escaping @Sendable () -> Void) throws {
        stdout = onStdout; exit = onExit; isRunning = true
        let ready: [String: Any] = ["status": "ready", "mode": "local-development", "url": configuration.hostAddress,
            "hostId": "synthetic-host-a", "engineExecution": "disabled", "mcpGateway": "disabled", "deviceTurnTools": "disabled",
            "deviceChannel": ["status": "unconfigured"]]
        onStdout(try JSONSerialization.data(withJSONObject: ready))
    }
    func requestGracefulStop() { isRunning = false; exit?() }
    func provideBrowserUseKeyFrame(_ frame: Data) throws {
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: frame) as? [String: String])
        frames.append(object)
        guard acknowledges else { return }
        let status = object["operation"] == "set" ? "ready" : "locked"
        if sendsWrongHostFirst { try acknowledge(object, hostID: "other-host", status: "refused") }
        try acknowledge(object, hostID: "synthetic-host-a", status: status)
    }
    private func acknowledge(_ object: [String: String], hostID: String, status: String) throws {
        var bytes = try JSONSerialization.data(withJSONObject: ["schema": "dexter.browser-use-key-ack/1",
            "requestId": try XCTUnwrap(object["requestId"]), "hostID": hostID, "status": status])
        bytes.append(0x0a); stdout?(bytes)
    }
}

@MainActor final class BrowserUseKeyBridgeTests: XCTestCase {
    private func withHost(_ operation: @MainActor (LocalHostSupervisor, BrowserUseSyntheticChild, LocalHostLaunchConfiguration) async throws -> Void) async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("dexter-browser-key-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: directory) }
        let node = directory.appendingPathComponent("node"), cli = directory.appendingPathComponent("host.js")
        try Data("synthetic executable never launched".utf8).write(to: node)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: node.path)
        try Data("synthetic CLI never executed".utf8).write(to: cli)
        let config = LocalHostLaunchConfiguration(node: node, cli: cli, dataDir: directory.appendingPathComponent("data"))
        let child = BrowserUseSyntheticChild(config)
        let supervisor = LocalHostSupervisor(configuration: config, makeChild: { _, _ in child }, portIsFree: { _ in true })
        let state = await supervisor.start(timeout: .seconds(1))
        XCTAssertEqual(state, .running(address: config.hostAddress))
        try await operation(supervisor, child, config)
        _ = await supervisor.stop(grace: .seconds(1))
    }

    func testPrivateDeliveryRequiresOwnedReadyIdentityAndMatchingAcknowledgement() async throws {
        try await withHost { supervisor, child, config in
            XCTAssertTrue(config.arguments.contains("--browser-use-private-input"))
            XCTAssertFalse(supervisor.canManageBrowserUseKey(hostID: "other-host"))
            do {
                try await supervisor.setBrowserUseKey("synthetic-browser-use-key-123", hostID: "other-host")
                XCTFail("A host from HTTP cannot replace the owned child's identity")
            } catch let error as BrowserUseKeyFailure { XCTAssertEqual(error, .bridgeUnavailable) }
            XCTAssertTrue(child.frames.isEmpty)
            try await supervisor.setBrowserUseKey("synthetic-browser-use-key-123", hostID: "synthetic-host-a", timeout: .seconds(1))
            XCTAssertEqual(child.frames.count, 1)
            XCTAssertEqual(child.frames.first?["key"], "synthetic-browser-use-key-123")
            XCTAssertEqual(child.frames.first?["hostID"], "synthetic-host-a")
            XCTAssertFalse(config.arguments.contains(where: { $0.contains("synthetic-browser-use-key") }))
            try await supervisor.setBrowserUseKey(nil, hostID: "synthetic-host-a", timeout: .seconds(1))
            XCTAssertNil(child.frames.last?["key"])
            XCTAssertEqual(child.frames.last?["operation"], "lock")
        }
    }

    func testUncertainDeliveryIsNotRetriedAndExplicitLockCanFollow() async throws {
        try await withHost { supervisor, child, _ in
            child.acknowledges = false
            do {
                try await supervisor.setBrowserUseKey("synthetic-browser-use-key-123", hostID: "synthetic-host-a", timeout: .milliseconds(20))
                XCTFail("Missing ACK must be an uncertain outcome")
            } catch let error as BrowserUseKeyFailure { XCTAssertEqual(error, .bridgeUnconfirmed) }
            XCTAssertEqual(child.frames.count, 1)
            child.acknowledges = true
            try await supervisor.setBrowserUseKey(nil, hostID: "synthetic-host-a", timeout: .seconds(1))
            XCTAssertEqual(child.frames.count, 2)
            XCTAssertNil(child.frames.last?["key"])
        }
    }
}
#endif
