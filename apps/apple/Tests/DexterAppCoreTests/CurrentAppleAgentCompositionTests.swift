import Foundation
import XCTest
@testable import DexterAppCore
@testable import DexterHostClient
@testable import DexterClientIdentity

@MainActor final class CurrentCompositionFixture {
    let root: URL, process = Process(), input = Pipe(), output = Pipe()
    var bundle = Data()
    var agentFingerprint = "", agentCertificateDER = "", nativePolicy = ""
    init() throws {
        let env = ProcessInfo.processInfo.environment
        let composition = try XCTUnwrap(env["DEXTER_REAL_HOST_COMPOSITION"])
        root = URL(fileURLWithPath: try XCTUnwrap(env["DEXTER_COMPOSITION_LAB"])).appendingPathComponent("run-" + String(UUID().uuidString.prefix(8)))
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        process.executableURL = URL(fileURLWithPath: try XCTUnwrap(env["DEXTER_TEST_NODE"]))
        process.arguments = [composition + "/tests/fixtures/current-apple-agent-host.mjs", root.path, composition, try XCTUnwrap(env["DEXTER_REAL_BROWSER"]), try XCTUnwrap(env["DEXTER_NATIVE_AGENT"])]
        process.environment = [:]; process.standardInput = input; process.standardOutput = output; let errors = composition + "/fixture-errors.log"
        if !FileManager.default.fileExists(atPath: errors) { _ = FileManager.default.createFile(atPath: errors, contents: Data(), attributes: [.posixPermissions: 0o600]) }
        let errorHandle = try FileHandle(forWritingTo: URL(fileURLWithPath: errors)); try errorHandle.seekToEnd(); process.standardError = errorHandle
        try process.run()
        var initialized = false
        defer { if !initialized { if process.isRunning { process.terminate(); process.waitUntilExit() } } }
        var data = Data()
        while let byte = try output.fileHandleForReading.read(upToCount: 1), !byte.isEmpty { if byte.first == 10 { break }; data.append(byte) }
        let initial = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        bundle = try JSONSerialization.data(withJSONObject: XCTUnwrap(initial["bundle"]))
        agentFingerprint = try XCTUnwrap(initial["agentFingerprint"] as? String); agentCertificateDER = try XCTUnwrap(initial["agentCertificateDER"] as? String); nativePolicy = try XCTUnwrap(initial["nativePolicy"] as? String)
        XCTAssertEqual(nativePolicy, "cli_forwarding_laboratory_memory_only")
        initialized = true
    }
    func command(_ op: String, _ values: [String: String] = [:]) throws -> [String: Any] {
        var v = values; v["op"] = op; var data = try JSONSerialization.data(withJSONObject: v); data.append(10)
        try input.fileHandleForWriting.write(contentsOf: data); data = Data()
        while let byte = try output.fileHandleForReading.read(upToCount: 1), !byte.isEmpty { if byte.first == 10 { break }; data.append(byte) }
        let result = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any]); guard result["fixtureError"] == nil else { throw ClientIdentityFailure.protocolError }
        return result
    }
    func close() { if process.isRunning { process.terminate(); process.waitUntilExit() } }
}
@MainActor final class CurrentAppleAgentCompositionTests: XCTestCase {
    func testCurrentTypedAppOwnerUnixMcpTlsSeparateAgentAppend() async throws {
        let fixture = try CurrentCompositionFixture(); defer { fixture.close() }
        let identity = try ClientNativeIdentity.ephemeralFixture(), keys = PairIdentityMemory(preferred: identity), metadata = PairMetadataMemory()
        let onboarding = PairedHostOnboarding(journal: metadata.journal, storage: metadata, identityStorage: { _ in keys })
        try onboarding.importBundle(fixture.bundle); await onboarding.provisionIdentity(); await onboarding.claim(name: "Owned Swift app")
        XCTAssertEqual(onboarding.state, .pendingApproval)
        let approved = try fixture.command("approve", ["claimID": XCTUnwrap(onboarding.publicReference?.claimID), "fingerprint": XCTUnwrap(onboarding.publicReference?.clientFingerprint)])
        XCTAssertEqual(approved["approvedFingerprint"] as? String, identity.fingerprint)
        let appID = try XCTUnwrap(approved["deviceId"] as? String)
        let model = DexterAppModel(storage: PairedAppStateMemory(), pairing: onboarding); await model.connectPairedHost(); XCTAssertTrue(model.canUseHost)
        let client = try XCTUnwrap(onboarding.activeClient)
        let bot = try await client.createBot(.init(name: "Owned append", profileId: "synthetic", engine: .codex))
        let thread = try await client.createThread(botID: bot.id)
        let routed = try fixture.command("route", ["botID": bot.id]); let executorID = try XCTUnwrap(routed["deviceID"] as? String); XCTAssertNotEqual(appID, executorID)
        let denied = try await client.startTurn(threadID: thread.id, submission: .init(content: "deny", clientRequestId: "deny-one"))
        let denial = try fixture.command("wait", ["turnID": denied.id]); XCTAssertEqual(denial["state"] as? String, "completed"); XCTAssertEqual(denial["driverFailures"] as? [String], []); XCTAssertEqual(denial["toolCount"] as? Int, 0); XCTAssertEqual(try fixture.command("inspect")["actions"] as? Int, 0)
        _ = try fixture.command("ask", ["botID": bot.id])
        let submission = TurnSubmission(content: "once", clientRequestId: "append-one")
        let turn = try await client.startTurn(threadID: thread.id, submission: submission)
        let pending = try fixture.command("pending"); XCTAssertEqual(pending["state"] as? String, "awaiting_approval")
        let actions = try await client.listActions(); let action = try XCTUnwrap(actions.first); XCTAssertEqual(action.state, .awaitingApproval); XCTAssertEqual(pending["actionID"] as? String, action.id)
        let changed = Action(id: action.id, request: action.request, requestHash: String(repeating: "f", count: 64), grantRevision: action.grantRevision, state: action.state, createdAt: action.createdAt, updatedAt: action.updatedAt, approvalExpiresAt: action.approvalExpiresAt, decidedBy: action.decidedBy, result: action.result, reason: action.reason)
        do { _ = try await client.decide(action: changed, decision: .allow); XCTFail("wrong hash admitted") } catch { XCTAssertEqual(error as? HostClientError, .conflict) }
        _ = try await client.decide(action: action, decision: .allow); _ = try fixture.command("release"); _ = try fixture.command("wait", ["turnID": turn.id])
        let finished = try await client.getTurn(id: turn.id); XCTAssertEqual(finished.state, .completed)
        let replay = try await client.startTurn(threadID: thread.id, submission: submission); XCTAssertEqual(replay.id, turn.id)
        let inspected = try fixture.command("inspect"); XCTAssertEqual(inspected["text"] as? String, "once\n"); XCTAssertEqual(inspected["actions"] as? Int, 1); XCTAssertEqual(inspected["writerHeld"] as? Bool, true)
        XCTAssertGreaterThan(try XCTUnwrap(inspected["appHTTP"] as? Int), 8); XCTAssertGreaterThan(try XCTUnwrap(inspected["deviceHTTP"] as? Int), 3)
        XCTAssertEqual(inspected["receipts"] as? [String], ["succeeded", "succeeded", "succeeded"])
        let reconnect = try fixture.command("reconnect"); XCTAssertEqual(reconnect["sameID"] as? String, executorID); XCTAssertEqual(reconnect["peerFingerprint"] as? String, fixture.agentFingerprint); XCTAssertEqual(reconnect["peerCertificateDER"] as? String, fixture.agentCertificateDER); XCTAssertEqual(reconnect["staleAfterDrain"] as? Bool, true); XCTAssertGreaterThan(try XCTUnwrap(reconnect["freshAuthenticatedPolls"] as? Int), 0); XCTAssertEqual(try fixture.command("inspect")["text"] as? String, "once\n")
        let peerBot = try await client.createBot(.init(name: "Owned isolated", profileId: "synthetic", engine: .codex)), peerThread = try await client.createThread(botID: peerBot.id)
        _ = try fixture.command("browser", ["botID": bot.id, "peerBotID": peerBot.id])
        let browser = try await client.startTurn(threadID: thread.id, submission: .init(content: "browser", clientRequestId: "browser-one"))
        let browsed = try fixture.command("wait", ["turnID": browser.id]); XCTAssertEqual(browsed["state"] as? String, "completed"); XCTAssertEqual(browsed["driverFailures"] as? [String], []); let browserReceipts = try XCTUnwrap(browsed["receipts"] as? [[String: Any]]); XCTAssertEqual(browserReceipts.map { $0["status"] as? String }, ["succeeded", "succeeded"]); let read = try XCTUnwrap(browserReceipts.last?["result"] as? [String: Any]); XCTAssertEqual(read["ok"] as? Bool, true); let readPayload = try XCTUnwrap(read["result"] as? [String: Any]); let content = try XCTUnwrap(readPayload["content"] as? [String: Any]); XCTAssertEqual(content["trust"] as? String, "untrusted_external"); XCTAssertEqual(content["text"] as? String, "OWNED-SYNTHETIC"); XCTAssertEqual(try fixture.command("inspect")["actions"] as? Int, 4)
        let isolated = try await client.startTurn(threadID: peerThread.id, submission: .init(content: "browser-peer", clientRequestId: "browser-isolated"))
        let peerRead = try fixture.command("wait", ["turnID": isolated.id]); XCTAssertEqual(peerRead["state"] as? String, "completed"); XCTAssertEqual(peerRead["driverFailures"] as? [String], [])
        let isolation = try fixture.command("browser_verify"); XCTAssertEqual(isolation["realBrowser"] as? Bool, true); XCTAssertEqual(isolation["isolatedProfiles"] as? Bool, true); XCTAssertEqual(isolation["blockedGETs"] as? Int, 0); XCTAssertGreaterThan(try XCTUnwrap(isolation["ownedGETs"] as? Int), 1)
        let renamed = try await client.renameDevice(id: appID, name: "Owned renamed"); XCTAssertEqual(renamed.name, "Owned renamed")
        _ = try fixture.command("revoke")
        let postRevoke = try await client.startTurn(threadID: thread.id, submission: .init(content: "deny", clientRequestId: "revoked-history")); let revokedResult = try fixture.command("wait", ["turnID": postRevoke.id]); XCTAssertEqual(revokedResult["state"] as? String, "completed"); XCTAssertEqual(revokedResult["driverFailures"] as? [String], []); XCTAssertEqual(revokedResult["toolCount"] as? Int, 0); XCTAssertEqual(try fixture.command("inspect")["actions"] as? Int, 7); XCTAssertEqual(try fixture.command("inspect")["text"] as? String, "once\n")
        await model.revokeThisClient(); XCTAssertFalse(model.canUseHost); XCTAssertEqual(onboarding.state, .revoked)
        let stop = try fixture.command("quarantine"); XCTAssertEqual(stop["quarantined"] as? Bool, true); XCTAssertEqual(stop["resourcesDrained"] as? Bool, true); XCTAssertEqual(stop["fixtureWriterReleased"] as? Bool, true); fixture.process.waitUntilExit(); XCTAssertEqual(fixture.process.terminationStatus, 0)
    }
    func testCurrentTypedHeldTurnRetainsWriterUntilActualDriverDrain() async throws {
        let fixture = try CurrentCompositionFixture(); defer { fixture.close() }
        let keys = PairIdentityMemory(preferred: try ClientNativeIdentity.ephemeralFixture()), metadata = PairMetadataMemory()
        let onboarding = PairedHostOnboarding(journal: metadata.journal, storage: metadata, identityStorage: { _ in keys })
        try onboarding.importBundle(fixture.bundle); await onboarding.provisionIdentity(); await onboarding.claim(name: "Owned held app")
        _ = try fixture.command("approve", ["claimID": XCTUnwrap(onboarding.publicReference?.claimID), "fingerprint": XCTUnwrap(onboarding.publicReference?.clientFingerprint)])
        let model = DexterAppModel(storage: PairedAppStateMemory(), pairing: onboarding); await model.connectPairedHost(); XCTAssertTrue(model.canUseHost)
        let client = try XCTUnwrap(onboarding.activeClient)
        let bot = try await client.createBot(.init(name: "Owned held", profileId: "synthetic", engine: .codex)), thread = try await client.createThread(botID: bot.id)
        _ = try await client.startTurn(threadID: thread.id, submission: .init(content: "held", clientRequestId: "held-one"))
        let blocked = try fixture.command("held_shutdown"); XCTAssertEqual(blocked["writerHeld"] as? Bool, true); XCTAssertEqual(blocked["driverProcessAlive"] as? Bool, true); XCTAssertEqual(blocked["admissionClosed"] as? Bool, true)
        await client.close().value; _ = try fixture.command("release")
        let stop = try fixture.command("stop"); XCTAssertEqual(stop["writerReleased"] as? Bool, true)
        fixture.process.waitUntilExit(); XCTAssertEqual(fixture.process.terminationStatus, 0)
    }

    func testCurrentTypedCancellationAfterAgentDispatchIsUnknownWithoutRepeat() async throws {
        let fixture = try CurrentCompositionFixture(); defer { fixture.close() }
        let keys = PairIdentityMemory(preferred: try ClientNativeIdentity.ephemeralFixture()), metadata = PairMetadataMemory()
        let onboarding = PairedHostOnboarding(journal: metadata.journal, storage: metadata, identityStorage: { _ in keys })
        try onboarding.importBundle(fixture.bundle); await onboarding.provisionIdentity(); await onboarding.claim(name: "Owned unknown app")
        _ = try fixture.command("approve", ["claimID": XCTUnwrap(onboarding.publicReference?.claimID), "fingerprint": XCTUnwrap(onboarding.publicReference?.clientFingerprint)])
        let model = DexterAppModel(storage: PairedAppStateMemory(), pairing: onboarding); await model.connectPairedHost()
        let client = try XCTUnwrap(onboarding.activeClient)
        let bot = try await client.createBot(.init(name: "Owned unknown", profileId: "synthetic", engine: .codex)), thread = try await client.createThread(botID: bot.id)
        _ = try fixture.command("unknown_mode", ["botID": bot.id])
        let submission = TurnSubmission(content: "unknown", clientRequestId: "unknown-one")
        let turn = try await client.startTurn(threadID: thread.id, submission: submission)
        let cancelled = try fixture.command("unknown_cancel", ["turnID": turn.id]); XCTAssertEqual(cancelled["redispatchRefusal"] as? String, "turn_owned"); XCTAssertEqual(cancelled["lateReceiptStatus"] as? String, "completed"); XCTAssertEqual(cancelled["unknown"] as? Bool, true); XCTAssertEqual(cancelled["physicalAppendAfterCancellation"] as? Bool, true); XCTAssertEqual(cancelled["noSecondDispatch"] as? Bool, true)
        let actions = try await client.listActions(); XCTAssertEqual(actions.count, 1); XCTAssertEqual(actions.first?.state, .unknown)
        let replay = try await client.startTurn(threadID: thread.id, submission: submission); XCTAssertEqual(replay.id, turn.id)
        XCTAssertEqual(try fixture.command("inspect")["text"] as? String, "unknown\n"); let verified = try fixture.command("unknown_verify"); XCTAssertEqual(verified["state"] as? String, "unknown"); XCTAssertEqual(verified["effects"] as? Int, 1); XCTAssertEqual(verified["lateReceiptStatus"] as? String, "completed")
        await client.close().value; let stop = try fixture.command("stop"); XCTAssertEqual(stop["writerReleased"] as? Bool, true)
        fixture.process.waitUntilExit(); XCTAssertEqual(fixture.process.terminationStatus, 0)
    }

    // Additional lane only: the original three tests above remain unchanged and are not selected here.
    func testCurrentAgentDiscriminatorRenameOfflineEndpointRestartRevocation() async throws {
        let fixture = try CurrentCompositionFixture(); defer { fixture.close() }
        let keys = PairIdentityMemory(preferred: try ClientNativeIdentity.ephemeralFixture()), metadata = PairMetadataMemory()
        let onboarding = PairedHostOnboarding(journal: metadata.journal, storage: metadata, identityStorage: { _ in keys })
        try onboarding.importBundle(fixture.bundle); await onboarding.provisionIdentity(); await onboarding.claim(name: "Lifecycle owner app")
        let approved = try fixture.command("approve", ["claimID": XCTUnwrap(onboarding.publicReference?.claimID), "fingerprint": XCTUnwrap(onboarding.publicReference?.clientFingerprint)])
        let appID = try XCTUnwrap(approved["deviceId"] as? String)
        let model = DexterAppModel(storage: PairedAppStateMemory(), pairing: onboarding); await model.connectPairedHost(); XCTAssertTrue(model.canUseHost)
        let client = try XCTUnwrap(onboarding.activeClient)
        let bot = try await client.createBot(.init(name: "Lifecycle discriminator", profileId: "synthetic", engine: .codex)), thread = try await client.createThread(botID: bot.id)
        let routed = try fixture.command("route", ["botID": bot.id]), agentID = try XCTUnwrap(routed["deviceID"] as? String)
        XCTAssertNotEqual(agentID, appID)
        let listed = try await client.listDevices(), original = try XCTUnwrap(listed.first { $0.id == agentID })
        XCTAssertTrue(original.paired); XCTAssertEqual(original.presence, .online)
        let renamed = try await client.renameDevice(id: agentID, name: "Renamed Mac lifecycle")
        XCTAssertEqual(renamed.id, agentID); XCTAssertEqual(renamed.name, "Renamed Mac lifecycle")
        let renamedList = try await client.listDevices(); XCTAssertEqual(renamedList.first { $0.id == agentID }?.name, "Renamed Mac lifecycle")
        // No further request uses the old AppClient endpoint: this owner command performs genuine host/daemon restarts.
        await client.close().value
        let observed = try fixture.command("agent_lifecycle", ["botID": bot.id, "threadID": thread.id, "expectedName": renamed.name])
        XCTAssertEqual(observed["deviceID"] as? String, agentID); XCTAssertEqual(observed["nameAfterRestart"] as? String, renamed.name)
        XCTAssertEqual(observed["endpointChange"] as? String, "loopback-port-only")
        XCTAssertNotEqual(observed["oldEndpoint"] as? String, observed["newEndpoint"] as? String)
        XCTAssertEqual(observed["sameHostPin"] as? Bool, true); XCTAssertEqual(observed["sameBindingBytes"] as? Bool, true)
        XCTAssertEqual(observed["peerFingerprint"] as? String, fixture.agentFingerprint); XCTAssertEqual(observed["peerCertificateDER"] as? String, fixture.agentCertificateDER)
        XCTAssertEqual(observed["offlineCode"] as? String, "device_unavailable"); XCTAssertEqual(observed["offlineStateBeforeReconnect"] as? String, "ready")
        XCTAssertTrue(observed["offlineResultBeforeReconnect"] is NSNull); XCTAssertEqual(observed["offlineExtraEffects"] as? Int, 0)
        XCTAssertEqual(observed["positiveState"] as? String, "succeeded"); XCTAssertEqual(observed["totalEffects"] as? Int, 2)
        XCTAssertEqual(observed["revokedState"] as? String, "blocked"); XCTAssertTrue(observed["revokedResult"] is NSNull)
        XCTAssertEqual(observed["grantPolicy"] as? String, "deny"); XCTAssertEqual(observed["grantRevision"] as? Int, 2)
        XCTAssertEqual(observed["revokedDurable"] as? Bool, true); XCTAssertEqual(observed["noNewDevice"] as? Bool, true)
        let daemonPIDs = try XCTUnwrap(observed["daemonPIDs"] as? [Int]); XCTAssertEqual(daemonPIDs.count, 3); XCTAssertEqual(Set(daemonPIDs).count, 3)
        XCTAssertEqual(observed["driverTurns"] as? Int, 0)
        let stop = try fixture.command("stop"); XCTAssertEqual(stop["writerReleased"] as? Bool, true)
        fixture.process.waitUntilExit(); XCTAssertEqual(fixture.process.terminationStatus, 0)
    }

    // AUTHOR2 isolated lane: same host instance, real TTL, physical daemon stop and offline revoke.
    func testCurrentAgentContinuousHostRealTTLAndOfflineRevocation() async throws {
        let fixture = try CurrentCompositionFixture(); defer { fixture.close() }
        let keys = PairIdentityMemory(preferred: try ClientNativeIdentity.ephemeralFixture()), metadata = PairMetadataMemory()
        let onboarding = PairedHostOnboarding(journal: metadata.journal, storage: metadata, identityStorage: { _ in keys })
        try onboarding.importBundle(fixture.bundle); await onboarding.provisionIdentity(); await onboarding.claim(name: "Continuous owner app")
        _ = try fixture.command("approve", ["claimID": XCTUnwrap(onboarding.publicReference?.claimID), "fingerprint": XCTUnwrap(onboarding.publicReference?.clientFingerprint)])
        let model = DexterAppModel(storage: PairedAppStateMemory(), pairing: onboarding); await model.connectPairedHost(); XCTAssertTrue(model.canUseHost)
        let client = try XCTUnwrap(onboarding.activeClient)
        let bot = try await client.createBot(.init(name: "Continuous offline", profileId: "synthetic", engine: .codex)), thread = try await client.createThread(botID: bot.id)
        let routed = try fixture.command("route", ["botID": bot.id]); let agentID = try XCTUnwrap(routed["deviceID"] as? String)
        let observed = try fixture.command("agent_continuous", ["botID": bot.id, "threadID": thread.id])
        XCTAssertEqual(observed["deviceID"] as? String, agentID)
        for key in ["sameHostServices", "sameStore", "endpointUnchanged", "clockUnchanged", "revokeWhileDaemonAbsent", "revokedRestartNoSuccessfulPolls", "grantUnchanged", "newGrantRefused", "newActionRefusedBeforeInsert", "sameBindingBytes", "noNewDevice"] { XCTAssertEqual(observed[key] as? Bool, true, key) }
        XCTAssertEqual(observed["newActionAdmissionCode"] as? String, "forbidden"); XCTAssertEqual(observed["newActionAddedActions"] as? Int, 0); XCTAssertEqual(observed["newActionAddedEvents"] as? Int, 0)
        XCTAssertEqual(observed["hostRestarts"] as? Int, 0); XCTAssertEqual(observed["ttlMs"] as? Int, 120000)
        XCTAssertGreaterThanOrEqual(try XCTUnwrap(observed["elapsedMs"] as? Int), 118000)
        XCTAssertEqual(observed["offlineCode"] as? String, "device_unavailable"); XCTAssertEqual(observed["offlineStateBeforeReconnect"] as? String, "ready"); XCTAssertTrue(observed["offlineResultBeforeReconnect"] is NSNull)
        XCTAssertEqual(observed["offlineExtraEffects"] as? Int, 0); XCTAssertEqual(observed["terminalReplayExtraEffects"] as? Int, 0)
        XCTAssertEqual(observed["positiveState"] as? String, "succeeded"); XCTAssertEqual(observed["totalEffects"] as? Int, 2)
        XCTAssertEqual(observed["revokeGrantPolicy"] as? String, "allow"); XCTAssertEqual(observed["revokeGrantRevision"] as? Int, 1)
        XCTAssertEqual(observed["revokedState"] as? String, "blocked"); XCTAssertEqual(observed["revokedReason"] as? String, "permission_changed"); XCTAssertTrue(observed["revokedResult"] is NSNull)
        let pids = try XCTUnwrap(observed["daemonPIDs"] as? [Int]); XCTAssertEqual(pids.count, 3); XCTAssertEqual(Set(pids).count, 3)
        XCTAssertEqual(observed["driverTurns"] as? Int, 0)
        await client.close().value
        let stop = try fixture.command("stop"); XCTAssertEqual(stop["writerReleased"] as? Bool, true)
        fixture.process.waitUntilExit(); XCTAssertEqual(fixture.process.terminationStatus, 0)
    }
}
