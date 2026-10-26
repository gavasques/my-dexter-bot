import Foundation
import XCTest
@testable import DexterAppCore
@testable import DexterHostClient
@testable import DexterClientIdentity

/// AppClient model-handler integration, not GUI or agent-mac/executor enrollment.
@MainActor private final class AppleRepairHostFixture {
    let process = Process(), input = Pipe(), output = Pipe()
    let root: URL
    let initial: [String: Any]
    init() throws {
        guard let node = ProcessInfo.processInfo.environment["DEXTER_TEST_NODE"],
              let source = ProcessInfo.processInfo.environment["DEXTER_REAL_HOST_COMPOSITION"],
              source.hasPrefix("/private/tmp/") else { throw ClientIdentityFailure.invalidInput }
        root = URL(fileURLWithPath: "/private/tmp").appendingPathComponent("dexter-apple-repair-owned-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = [source + "/tests/fixtures/apple-repair-host.mjs", root.path, source]
        process.environment = [:]; process.standardInput = input; process.standardOutput = output; process.standardError = FileHandle.nullDevice
        do { try process.run(); initial = try Self.read(output); try Self.record("initial", try XCTUnwrap(initial["observation"])) }
        catch { if process.isRunning { process.terminate(); process.waitUntilExit() }; try? FileManager.default.removeItem(at: root); throw error }
    }
    private static func read(_ pipe: Pipe) throws -> [String: Any] {
        var data = Data()
        while data.count < 131072 {
            guard let byte = try pipe.fileHandleForReading.read(upToCount: 1), !byte.isEmpty else { throw ClientIdentityFailure.unavailable }
            if byte.first == 10 { break }; data.append(byte)
        }
        guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any], value["fixtureError"] == nil else { throw ClientIdentityFailure.protocolError }
        return value
    }
    private static func record(_ label: String, _ value: Any) throws {
        guard let path = ProcessInfo.processInfo.environment["DEXTER_REPAIR_OBSERVATIONS"], path.hasPrefix("/private/tmp/") else { return }
        let url = URL(fileURLWithPath: path)
        if !FileManager.default.fileExists(atPath: path) { _ = FileManager.default.createFile(atPath: path, contents: nil, attributes: [.posixPermissions: 0o600]) }
        let handle = try FileHandle(forWritingTo: url); defer { try? handle.close() }
        try handle.seekToEnd()
        var data = try JSONSerialization.data(withJSONObject: ["phase": label, "observation": value], options: [.sortedKeys]); data.append(10)
        try handle.write(contentsOf: data)
    }
    func command(_ op: String, values: [String: String] = [:]) throws -> [String: Any] {
        var object = values; object["op"] = op
        var data = try JSONSerialization.data(withJSONObject: object); data.append(10)
        try input.fileHandleForWriting.write(contentsOf: data)
        let response = try Self.read(output)
        if op != "offer" { try Self.record(op, response) }; return response
    }
    func finish() throws {
        XCTAssertEqual(try command("stop")["writerReleased"] as? Bool, true)
        process.waitUntilExit(); XCTAssertEqual(process.terminationStatus, 0)
    }
    func close() {
        if process.isRunning { process.terminate(); process.waitUntilExit() }
        XCTAssertFalse(process.isRunning); try? FileManager.default.removeItem(at: root)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.path))
    }
}

@MainActor final class AppleRepairFlowTests: XCTestCase {
    private func json(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) }
    private func rows(_ observation: [String: Any], _ key: String) throws -> [[String: Any]] { try XCTUnwrap(observation[key] as? [[String: Any]]) }
    private func preserved(_ observation: [String: Any]) throws -> Data { try json(XCTUnwrap(observation["preserved"])) }
    private func approve(_ fixture: AppleRepairHostFixture, _ pairing: PairedHostOnboarding, scopes: [String]) throws -> String {
        let reference = try XCTUnwrap(pairing.publicReference)
        let result = try fixture.command("approve", values: ["claimID": try XCTUnwrap(reference.claimID), "fingerprint": try XCTUnwrap(reference.clientFingerprint), "scopes": String(decoding: try json(scopes), as: UTF8.self)])
        return try XCTUnwrap(result["deviceId"] as? String)
    }

    func testExplicitOwnerApprovedRepairCreatesNewClientWithoutRevivingOldBindingOrChangingGrants() async throws {
        let fixture = try AppleRepairHostFixture(); defer { fixture.close() }
        let metadata = PairMetadataMemory(), keys = PairIdentityMemory()
        let pairing = PairedHostOnboarding(journal: metadata.journal, storage: metadata, identityStorage: { _ in keys })
        let model = DexterAppModel(storage: PairedAppStateMemory(), pairing: pairing)
        let initial = try XCTUnwrap(fixture.initial["observation"] as? [String: Any]), baseline = try preserved(initial)
        XCTAssertNotEqual(initial["pid"] as? Int32, ProcessInfo.processInfo.processIdentifier)
        XCTAssertEqual(try rows(initial, "devices").count, 0)
        model.importPairingBundle(try json(XCTUnwrap(fixture.initial["bundle"])))
        XCTAssertEqual(pairing.state, .readyToProvision)
        let imported = try fixture.command("inspect")
        XCTAssertEqual(try json(imported), try json(initial), "import must send no HTTP or mutate host state")
        let unprovisioned = await keys.counts(); XCTAssertEqual(unprovisioned, [0, 0])
        await pairing.provisionIdentity(); XCTAssertEqual(pairing.state, .identityReady)
        XCTAssertEqual(try json(fixture.command("inspect")), try json(initial), "explicit key creation remains local")
        await pairing.claim(name: "Synthetic first AppClient"); XCTAssertEqual(pairing.state, .pendingApproval)
        await model.connectPairedHost(); XCTAssertFalse(model.canUseHost); XCTAssertNil(pairing.activeClient)
        let pending = try fixture.command("inspect")
        XCTAssertEqual(try rows(pending, "pendingClaims").count, 1); XCTAssertTrue(try rows(pending, "devices").isEmpty)
        XCTAssertTrue(try rows(pending, "bindings").isEmpty); XCTAssertEqual(try preserved(pending), baseline)
        let oldDevice = try approve(fixture, pairing, scopes: ["approvals.read", "chat.read", "chat.write", "devices.manage", "devices.read"])
        await model.connectPairedHost(); XCTAssertTrue(model.canUseHost); XCTAssertEqual(pairing.state, .paired)
        let oldBinding = try XCTUnwrap(pairing.binding), retained = try XCTUnwrap(pairing.activeClient)
        let oldReference = try XCTUnwrap(pairing.publicReference)
        XCTAssertEqual(oldBinding.deviceID, oldDevice); XCTAssertEqual(oldBinding.role, .clientMac)
        XCTAssertEqual(oldBinding.scopes.map(\.rawValue), ["approvals.read", "chat.read", "chat.write", "devices.manage", "devices.read"])
        XCTAssertEqual(model.bots.count, 1)
        await model.revokeThisClient(); XCTAssertEqual(pairing.state, .revoked); XCTAssertFalse(model.canUseHost)
        do { _ = try await retained.health(); XCTFail("retained SDK reference survived self revoke") } catch { XCTAssertTrue(error is CancellationError) }
        await retained.close().value
        let revoked = try fixture.command("inspect"); XCTAssertEqual(try preserved(revoked), baseline)
        XCTAssertNotNil(try rows(revoked, "devices").first?["revokedAt"] as? NSNumber)
        let restored = PairedHostOnboarding(journal: metadata.journal, storage: metadata, identityStorage: { _ in keys })
        let restoredModel = DexterAppModel(storage: PairedAppStateMemory(), pairing: restored)
        await restoredModel.connectPairedHost(); XCTAssertEqual(restored.state, .revoked); XCTAssertFalse(restoredModel.canUseHost); XCTAssertNil(restored.binding)
        XCTAssertEqual(restored.publicReference?.localBindingID, oldReference.localBindingID)
        XCTAssertEqual(restored.publicReference?.clientFingerprint, oldReference.clientFingerprint)
        let afterRestore = await keys.counts(); XCTAssertEqual(afterRestore[1], 1, "restart never provisions")
        model.detachPairedHost(); XCTAssertNil(pairing.publicReference)
        let fresh = try fixture.command("offer")
        model.importPairingBundle(try json(XCTUnwrap(fresh["bundle"])))
        XCTAssertEqual(pairing.state, .readyToProvision)
        let nextReference = try XCTUnwrap(pairing.publicReference)
        XCTAssertEqual(nextReference.installationID, oldReference.installationID)
        XCTAssertNotEqual(nextReference.localBindingID, oldReference.localBindingID)
        await pairing.provisionIdentity(); await pairing.claim(name: "Synthetic repaired AppClient")
        XCTAssertEqual(pairing.state, .pendingApproval)
        XCTAssertNotEqual(pairing.publicReference?.clientFingerprint, oldReference.clientFingerprint)
        XCTAssertNotEqual(pairing.publicReference?.claimID, oldReference.claimID)
        await model.connectPairedHost(); XCTAssertFalse(model.canUseHost); XCTAssertNil(pairing.binding)
        let repairPending = try fixture.command("inspect")
        XCTAssertEqual(try rows(repairPending, "devices").count, 1); XCTAssertEqual(try rows(repairPending, "bindings").count, 1)
        XCTAssertEqual(try rows(repairPending, "pendingClaims").count, 1); XCTAssertEqual(try preserved(repairPending), baseline)
        let newDevice = try approve(fixture, pairing, scopes: ["approvals.read", "chat.read", "devices.read"])
        XCTAssertNotEqual(newDevice, oldDevice)
        await model.connectPairedHost(); XCTAssertTrue(model.canUseHost)
        let newBinding = try XCTUnwrap(pairing.binding), newClient = try XCTUnwrap(pairing.activeClient)
        XCTAssertEqual(newBinding.deviceID, newDevice); XCTAssertEqual(newBinding.role, .clientMac)
        XCTAssertEqual(newBinding.scopes.map(\.rawValue), ["approvals.read", "chat.read", "devices.read"])
        XCTAssertEqual(newBinding.ownerID, oldBinding.ownerID); XCTAssertEqual(newBinding.installationID, oldBinding.installationID)
        do { _ = try await newClient.createBot(.init(name: "Must not create", profileId: "forbidden_profile", engine: .codex)); XCTFail("repair automatically inherited chat.write") } catch { XCTAssertEqual(error as? HostClientError, .forbidden) }
        // A fresh SDK transport for the OLD approved binding tests host refusal, not merely local close.
        let replay = try await HostClient.paired(binding: oldBinding, lifecycle: ClientIdentityLifecycle(scope: oldReference.scope(), storage: keys))
        do { _ = try await replay.health(); XCTFail("host resurrected revoked old binding") } catch { XCTAssertEqual(error as? HostClientError, .forbidden) }
        await replay.close().value
        do { _ = try await retained.health(); XCTFail("old retained SDK resurrected on re-pair") } catch { XCTAssertTrue(error is CancellationError) }
        await restoredModel.connectPairedHost(); XCTAssertEqual(restored.state, .revoked); XCTAssertFalse(restoredModel.canUseHost)
        let final = try fixture.command("inspect"); XCTAssertEqual(try preserved(final), baseline)
        let bindings = try rows(final, "bindings")
        XCTAssertEqual(bindings.count, 2)
        XCTAssertEqual(bindings.first(where: { $0["device_id"] as? String == oldDevice })?["status"] as? String, "revoked")
        XCTAssertEqual(bindings.first(where: { $0["device_id"] as? String == newDevice })?["status"] as? String, "active")
        let certificates = try rows(final, "certificates")
        XCTAssertEqual(certificates.count, 2)
        XCTAssertEqual(certificates.first(where: { $0["device_id"] as? String == oldDevice })?["state"] as? String, "revoked")
        XCTAssertEqual(certificates.first(where: { $0["device_id"] as? String == newDevice })?["state"] as? String, "active")
        let devices = try rows(final, "devices"); XCTAssertEqual(devices.count, 2)
        for device in devices { XCTAssertEqual(try XCTUnwrap(device["capabilities"] as? [String]), [], "AppClient scopes are not executor capabilities") }
        XCTAssertEqual(try rows(final, "pendingClaims").count, 0)
        let counts = await keys.counts(); XCTAssertEqual(counts[1], 2, "only explicit new binding creates new identity")
        model.disconnectPairedHost(); await newClient.close().value; model.detachPairedHost()
        try fixture.finish()
    }

    func testUnknownDurableClaimBlocksModelImportProvisionAndNewClaimAgainstRealHost() async throws {
        let fixture = try AppleRepairHostFixture(); defer { fixture.close() }
        let metadata = PairMetadataMemory(), keys = PairIdentityMemory()
        let original = try json(XCTUnwrap(fixture.initial["bundle"]))
        let imported = try ImportedClientOffer.decode(original, platform: .clientMac)
        let scope = try ClientIdentityScope(installationID: imported.bundle.installationID, localBindingID: ClientIdentityScope.newLocalBindingID(), role: .clientMac, hostFingerprint: imported.bundle.host.fingerprint)
        let identity = try ClientNativeIdentity.ephemeralFixture()
        try await metadata.journal.reserve(.init(scope: scope, host: imported.bundle.host, offerID: imported.bundle.offerID, clientFingerprint: identity.fingerprint))
        let fresh = try fixture.command("offer"), before = try fixture.command("inspect")
        let pairing = PairedHostOnboarding(journal: metadata.journal, storage: metadata, identityStorage: { _ in keys })
        let model = DexterAppModel(storage: PairedAppStateMemory(), pairing: pairing)
        model.importPairingBundle(try json(XCTUnwrap(fresh["bundle"])))
        XCTAssertEqual(pairing.state, .outcomeUnknown); XCTAssertNotNil(model.errorMessage); XCTAssertNil(pairing.publicReference)
        await pairing.provisionIdentity(); await pairing.claim(name: "Must stay quarantined"); await model.connectPairedHost()
        XCTAssertFalse(model.canUseHost); XCTAssertNil(pairing.activeClient); XCTAssertEqual(metadata.writes, 0)
        let counts = await keys.counts(); XCTAssertEqual(counts, [0, 0])
        XCTAssertEqual(try json(fixture.command("inspect")), try json(before), "no HTTP, claim, enrollment or grant change from unknown durable journal")
        let entry = try await metadata.journal.loadOnly(scope: scope); XCTAssertNil(try XCTUnwrap(entry).claimID)
        model.detachPairedHost(); try fixture.finish()
    }
}
