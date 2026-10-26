import Foundation
import XCTest
@testable import DexterAppCore
@testable import DexterHostClient
@testable import DexterClientIdentity

// Separate fixture: the shared four-scenario fixture remains byte-identical.
@MainActor final class CurrentHostProcessFixture {
    let root: URL, process = Process(), input = Pipe(), output = Pipe()
    let initial: [String: Any]
    init() throws {
        let env = ProcessInfo.processInfo.environment
        let composition = try XCTUnwrap(env["DEXTER_REAL_HOST_COMPOSITION"])
        root = URL(fileURLWithPath: try XCTUnwrap(env["DEXTER_COMPOSITION_LAB"])).appendingPathComponent("hp-" + String(UUID().uuidString.prefix(8)))
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        process.executableURL = URL(fileURLWithPath: try XCTUnwrap(env["DEXTER_TEST_NODE"]))
        process.arguments = [composition + "/tests/fixtures/current-apple-host-process.mjs", root.path, composition, try XCTUnwrap(env["DEXTER_NATIVE_AGENT"])]
        process.environment = [:]; process.standardInput = input; process.standardOutput = output
        let errors = root.appendingPathComponent("supervisor.stderr.log")
        _ = FileManager.default.createFile(atPath: errors.path, contents: Data(), attributes: [.posixPermissions: 0o600])
        process.standardError = try FileHandle(forWritingTo: errors)
        try process.run()
        do { initial = try Self.read(output.fileHandleForReading) }
        catch { if process.isRunning { process.terminate(); process.waitUntilExit() }; throw error }
    }
    static func read(_ handle: FileHandle) throws -> [String: Any] {
        var data = Data()
        while let byte = try handle.read(upToCount: 1), !byte.isEmpty {
            if byte.first == 10 { break }; data.append(byte)
            guard data.count <= 65536 else { throw ClientIdentityFailure.protocolError }
        }
        let value = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        guard value["fixtureError"] == nil else { throw ClientIdentityFailure.protocolError }
        return value
    }
    func command(_ op: String, _ values: [String: String] = [:]) throws -> [String: Any] {
        var packet = values; packet["op"] = op
        var data = try JSONSerialization.data(withJSONObject: packet); data.append(10)
        try input.fileHandleForWriting.write(contentsOf: data)
        return try Self.read(output.fileHandleForReading)
    }
    func close() { if process.isRunning { process.terminate(); process.waitUntilExit() } }
}

@MainActor final class CurrentAppleHostProcessRestartTests: XCTestCase {
    func testRealHostProcessRestartPreservesCanonicalAuthorityIdentityHistoryAndDeniedGrants() async throws {
        let fixture = try CurrentHostProcessFixture(); defer { fixture.close() }
        let appIdentity = try ClientNativeIdentity.ephemeralFixture()
        let keys = PairIdentityMemory(preferred: appIdentity), metadata = PairMetadataMemory()
        let onboarding = PairedHostOnboarding(journal: metadata.journal, storage: metadata, identityStorage: { _ in keys })
        let bundle = try JSONSerialization.data(withJSONObject: XCTUnwrap(fixture.initial["bundle"]))
        try onboarding.importBundle(bundle); await onboarding.provisionIdentity(); await onboarding.claim(name: "Real process restart app")
        XCTAssertEqual(onboarding.state, .pendingApproval)
        let approved = try fixture.command("approve", ["claimID": XCTUnwrap(onboarding.publicReference?.claimID), "fingerprint": XCTUnwrap(onboarding.publicReference?.clientFingerprint)])
        XCTAssertEqual(approved["grantsCreated"] as? Int, 0)
        XCTAssertEqual(approved["approvedFingerprint"] as? String, appIdentity.fingerprint)
        let appID = try XCTUnwrap(approved["deviceId"] as? String)
        await onboarding.restoreOrCheckApproval(); XCTAssertEqual(onboarding.state, .paired)
        let client = try XCTUnwrap(onboarding.activeClient), binding = try XCTUnwrap(onboarding.binding)
        let agentID = try XCTUnwrap(fixture.initial["agentID"] as? String)
        XCTAssertNotEqual(agentID, appID); XCTAssertNotEqual(agentID, fixture.initial["revokedID"] as? String)
        let firstHealth = try await client.health(); XCTAssertEqual(firstHealth.client?.deviceId, appID)
        let bot = try await client.createBot(.init(name: "Host process canonical bot", profileId: "synthetic", engine: .codex))
        let thread = try await client.createThread(botID: bot.id)
        let message = try await client.appendMessage(threadID: thread.id, input: .init(clientMessageId: "process-history-once", content: "Owned canonical process history"))
        let renamed = try await client.renameDevice(id: agentID, name: "Durable real-process Mac")
        XCTAssertEqual(renamed.id, agentID)
        let before = try fixture.command("prepare", ["botID": bot.id, "threadID": thread.id, "appID": appID])
        let actionID = try XCTUnwrap(before["actionID"] as? String), pendingID = try XCTUnwrap(before["pendingID"] as? String)
        let originalActions = try await client.listActions(); XCTAssertEqual(originalActions.count, 2)
        XCTAssertEqual(originalActions.first { $0.id == actionID }?.state, .succeeded)
        XCTAssertEqual(originalActions.first { $0.id == pendingID }?.state, .blocked)
        XCTAssertNil(originalActions.first { $0.id == pendingID }?.result)
        await client.close().value; onboarding.disconnect()
        // The supervisor observes actual exit/ESRCH and an empty production lease before starting writer2.
        let observed = try fixture.command("restart")
        let pids = try XCTUnwrap(observed["hostPIDs"] as? [Int])
        XCTAssertEqual(pids.count, 2); XCTAssertNotEqual(pids[0], pids[1]); XCTAssertEqual(pids[0], fixture.initial["hostPID"] as? Int)
        XCTAssertEqual(observed["firstDeadBeforeSecondWriter"] as? Bool, true)
        XCTAssertEqual(observed["betweenLeaseRows"] as? Int, 0); XCTAssertEqual(observed["currentLeasePID"] as? Int, pids[1])
        XCTAssertEqual(observed["sameBindings"] as? Bool, true); XCTAssertEqual(observed["sameEndpoints"] as? Bool, true)
        XCTAssertEqual(observed["hostPin"] as? String, binding.host.fingerprint)
        XCTAssertEqual(observed["revokedDaemonRefused"] as? Bool, true); XCTAssertEqual(observed["driverTurns"] as? Int, 0)
        let peer = try XCTUnwrap(observed["agentPeer"] as? [String: Any])
        XCTAssertEqual(peer["fingerprint"] as? String, fixture.initial["agentFingerprint"] as? String)
        XCTAssertEqual(peer["certificateDER"] as? String, fixture.initial["agentDER"] as? String)
        XCTAssertEqual(peer["protocol"] as? String, "TLSv1.3"); XCTAssertEqual(peer["resumed"] as? Bool, false); XCTAssertEqual(peer["status"] as? Int, 200)
        let after = try XCTUnwrap(observed["after"] as? [String: Any])
        XCTAssertEqual(after["effect"] as? String, "before-process-restart\n")
        let grant = try XCTUnwrap(after["mainGrant"] as? [String: Any])
        XCTAssertEqual(grant["policy"] as? String, "deny"); XCTAssertEqual(grant["revision"] as? Int, 2)
        let revoked = try XCTUnwrap(after["revoked"] as? [String: Any]); XCTAssertEqual(revoked["paired"] as? Bool, false); XCTAssertFalse(revoked["revokedAt"] is NSNull)
        await onboarding.restoreOrCheckApproval(); XCTAssertEqual(onboarding.state, .paired)
        let reconnected = try XCTUnwrap(onboarding.activeClient), restored = try XCTUnwrap(onboarding.binding)
        XCTAssertEqual(restored.deviceID, appID); XCTAssertEqual(restored.clientFingerprint, binding.clientFingerprint)
        XCTAssertEqual(restored.installationID, binding.installationID); XCTAssertEqual(restored.ownerID, binding.ownerID)
        XCTAssertEqual(restored.pinGeneration, binding.pinGeneration); XCTAssertEqual(restored.bindingRevision, binding.bindingRevision)
        XCTAssertEqual(restored.host.url, binding.host.url); XCTAssertEqual(restored.host.certificateDER, binding.host.certificateDER)
        let health = try await reconnected.health(); XCTAssertEqual(health.client?.deviceId, appID)
        let savedBot = try await reconnected.getBot(id: bot.id); XCTAssertEqual(savedBot.name, bot.name)
        let savedThread = try await reconnected.getThread(id: thread.id); XCTAssertEqual(savedThread.id, thread.id)
        let history = try await reconnected.allMessages(threadID: thread.id); XCTAssertEqual(history.count, 1); XCTAssertEqual(history.first?.id, message.id); XCTAssertEqual(history.first?.content, message.content)
        let devices = try await reconnected.listDevices(); XCTAssertEqual(devices.first { $0.id == agentID }?.name, renamed.name)
        XCTAssertEqual(devices.first { $0.id == agentID }?.presence, .online)
        let actions = try await reconnected.listActions(); XCTAssertEqual(actions.count, 2)
        XCTAssertEqual(actions.first { $0.id == actionID }?.state, .succeeded)
        XCTAssertEqual(actions.first { $0.id == pendingID }?.state, .blocked); XCTAssertNil(actions.first { $0.id == pendingID }?.result)
        let counts = await keys.counts(); XCTAssertEqual(counts[1], 1, "reconnect must load existing App identity, never provision another")
        await reconnected.close().value
        let stop = try fixture.command("stop"); XCTAssertEqual(stop["writerReleased"] as? Bool, true)
        fixture.process.waitUntilExit(); XCTAssertEqual(fixture.process.terminationStatus, 0)
    }
}
