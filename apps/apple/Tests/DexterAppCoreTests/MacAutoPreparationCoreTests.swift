#if os(macOS)
import Foundation
import Darwin
import XCTest
@testable import DexterAppCore
@testable import DexterClientIdentity

@MainActor final class MacAutoPreparationCoreTests: XCTestCase {
    private struct Fixture {
        let parent: URL; let helper: LocalMacAgentHelperPackage; let cua: LocalMacAgentCuaPackage
        let location: LocalMacAgentSetupLocation; let der: Data; let pin: String
        init() throws {
            let directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("qa/auto-core-" + UUID().uuidString)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]); parent = directory
            let identity = try ClientNativeIdentity.ephemeralFixture(); der = identity.certificateDER; pin = LocalMacAgentSetup.sha256Hex(der)
            let identityURL = directory.appendingPathComponent("identity-fixture"), cuaURL = directory.appendingPathComponent("cua-fixture")
            try Data("known synthetic identity fixture; never executed".utf8).write(to: identityURL)
            try Data("known synthetic CUA fixture; never executed".utf8).write(to: cuaURL)
            _ = chmod(identityURL.path, 0o700); _ = chmod(cuaURL.path, 0o700)
            helper = .init(executable: identityURL); cua = .init(executable: cuaURL); location = .init(root: directory.appendingPathComponent("managed"))
        }
        func bundle(port: Int = 443, installation: String = "host_fixture", certificate: Data? = nil) throws -> LocalMacAgentSetupBundle {
            let certificate = certificate ?? der; let pin = LocalMacAgentSetup.sha256Hex(certificate)
            let body = certificate.base64EncodedString(); var pem = "-----BEGIN CERTIFICATE-----\n", rest = Substring(body)
            while !rest.isEmpty { pem += rest.prefix(64) + "\n"; rest = rest.dropFirst(64) }; pem += "-----END CERTIFICATE-----\n"
            let offer: [String: Any] = ["hostUrl": "https://127.0.0.1:\(port)", "hostFingerprint": pin, "hostCertPem": pem,
                "offerId": "offer_fixture", "code": String(repeating: "A", count: 43), "expiresAt": Int64(Date().addingTimeInterval(600).timeIntervalSince1970 * 1000)]
            let value: [String: Any] = ["schema": "dexter.local-mac-agent-setup/1", "installationId": installation, "offer": offer]
            return try LocalMacAgentSetupBundle(json: String(decoding: JSONSerialization.data(withJSONObject: value), as: UTF8.self), expectedInstallationID: installation)
        }
        func prepare() throws -> LocalMacAgentSelection { try LocalMacAgentSetup.prepareCuaOnly(bundle: bundle(), helper: helper, cuaPackage: cua, location: location) }
        func cleanup() { try? FileManager.default.removeItem(at: parent) }
    }
    func testCuaOnlyPreparationHasNoBrowserPlaceholderGrantsBindingOrIdentityEffects() throws {
        let f = try Fixture(); defer { f.cleanup() }; let selection = try f.prepare()
        let config = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: f.location.configuration)) as? [String: Any])
        XCTAssertTrue(config["browser"] is NSNull); XCTAssertEqual(Set(selection.capabilities), Set(LocalMacAgentCuaAuthorization.operations))
        XCTAssertEqual((config["cua"] as? [String: Any])?["mode"] as? String, "native")
        let snapshot = try LocalMacAgentPolicy.read(selection: selection, expectedInstallationID: "host_fixture")
        XCTAssertTrue(snapshot.authorizations.isEmpty); XCTAssertTrue(snapshot.cuaAuthorizations.isEmpty)
        XCTAssertFalse(selection.hasSavedPairing); XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: f.location.dataDirectory.path), [])
        XCTAssertThrowsError(try f.prepare())
    }
    func testLegacyBrowserPreparationRemainsValid() throws {
        let f = try Fixture(); defer { f.cleanup() }
        let bundle = try f.bundle(), plan = try bundle.plan(name: "Fixture", browserExecutable: f.cua.executable, capabilities: ["mac.browser.read"])
        let selection = try LocalMacAgentSetup.prepare(plan, helper: f.helper, location: f.location)
        _ = try LocalMacAgentPolicy.read(selection: selection, expectedInstallationID: bundle.installationID)
        XCTAssertEqual(selection.capabilities, ["mac.browser.read"])
    }
    func testRebindOnlyChangesEndpointFieldsAndPreservesPublicBindingPolicyAndHelpers() throws {
        let f = try Fixture(); defer { f.cleanup() }; let selection = try f.prepare()
        let policy = try LocalMacAgentPolicy.read(selection: selection, expectedInstallationID: "host_fixture")
        let originalConfig = try Data(contentsOf: f.location.configuration), originalHelper = try Data(contentsOf: f.location.helperConfiguration)
        let originals = try [f.location.hostCertificate, f.location.policy, f.location.helper, f.location.cuaHelper].map { try Data(contentsOf: $0) }
        let request = UUID().uuidString
        let next = try LocalMacAgentSetup.rebindEndpoint(bundle: f.bundle(port: 8443), selection: selection, expectedSnapshot: policy, agentStopped: true, requestID: request)
        XCTAssertEqual(next.hostURL, "https://127.0.0.1:8443")
        var beforeConfig = try XCTUnwrap(try JSONSerialization.jsonObject(with: originalConfig) as? [String: Any])
        var afterConfig = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: f.location.configuration)) as? [String: Any])
        beforeConfig.removeValue(forKey: "hostUrl"); afterConfig.removeValue(forKey: "hostUrl")
        XCTAssertEqual(try JSONSerialization.data(withJSONObject: beforeConfig, options: .sortedKeys), try JSONSerialization.data(withJSONObject: afterConfig, options: .sortedKeys))
        var beforeHelper = try XCTUnwrap(try JSONSerialization.jsonObject(with: originalHelper) as? [String: Any])
        var afterHelper = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: f.location.helperConfiguration)) as? [String: Any])
        beforeHelper.removeValue(forKey: "hostURL"); afterHelper.removeValue(forKey: "hostURL")
        XCTAssertEqual(try JSONSerialization.data(withJSONObject: beforeHelper, options: .sortedKeys), try JSONSerialization.data(withJSONObject: afterHelper, options: .sortedKeys))
        XCTAssertEqual(try [f.location.hostCertificate, f.location.policy, f.location.helper, f.location.cuaHelper].map { try Data(contentsOf: $0) }, originals)
        let receipt = try XCTUnwrap(LocalMacAgentSetup.reconcileEndpointRebind(location: f.location))
        XCTAssertEqual(receipt.state, .committed); XCTAssertEqual(receipt.requestID, request)
        let replay = try LocalMacAgentSetup.rebindEndpoint(bundle: f.bundle(port: 8443), selection: selection, expectedSnapshot: policy, agentStopped: true, requestID: request)
        XCTAssertEqual(replay, next)
    }
    func testPartialEndpointWriteStaysUnknownAndReadOnlyReconcileNeverReplays() throws {
        let f = try Fixture(); defer { f.cleanup() }; let selection = try f.prepare(), request = UUID().uuidString
        let policy = try LocalMacAgentPolicy.read(selection: selection, expectedInstallationID: "host_fixture")
        XCTAssertThrowsError(try LocalMacAgentSetup.rebindEndpoint(bundle: f.bundle(port: 8443), selection: selection, expectedSnapshot: policy,
            agentStopped: true, requestID: request, afterFirstWrite: { throw LocalMacAgentEndpointRebindError.outcomeUnknown }))
        let config = try Data(contentsOf: f.location.configuration), helper = try Data(contentsOf: f.location.helperConfiguration)
        let first = try LocalMacAgentSetup.reconcileEndpointRebind(location: f.location)
        XCTAssertEqual(first?.state, .unknown)
        XCTAssertEqual(try LocalMacAgentSetup.reconcileEndpointRebind(location: f.location), first)
        XCTAssertThrowsError(try LocalMacAgentSetup.rebindEndpoint(bundle: f.bundle(port: 8443), selection: selection, expectedSnapshot: policy, agentStopped: true, requestID: request))
        XCTAssertThrowsError(try LocalMacAgentSetup.rebindEndpoint(bundle: f.bundle(port: 8443), selection: selection, expectedSnapshot: policy, agentStopped: true))
        XCTAssertEqual(try Data(contentsOf: f.location.configuration), config); XCTAssertEqual(try Data(contentsOf: f.location.helperConfiguration), helper)
        let entries = try FileManager.default.contentsOfDirectory(atPath: f.location.root.path).filter { $0.hasPrefix(".endpoint-rebind") && $0.hasSuffix("json") }
        for entry in entries { let text = try String(contentsOf: f.location.root.appendingPathComponent(entry), encoding: .utf8); XCTAssertFalse(text.contains(String(repeating: "A", count: 43))); XCTAssertFalse(text.contains("PRIVATE KEY")) }
    }
    func testRebindRejectsRunningAgentForeignHostAndStalePolicyBeforeEndpointWrites() throws {
        let f = try Fixture(); defer { f.cleanup() }; let selection = try f.prepare()
        let snapshot = try LocalMacAgentPolicy.read(selection: selection, expectedInstallationID: "host_fixture")
        let before = try Data(contentsOf: f.location.configuration)
        XCTAssertThrowsError(try LocalMacAgentSetup.rebindEndpoint(bundle: f.bundle(port: 8443), selection: selection, expectedSnapshot: snapshot, agentStopped: false))
        XCTAssertThrowsError(try LocalMacAgentSetup.rebindEndpoint(bundle: f.bundle(port: 8443, installation: "other_host"), selection: selection, expectedSnapshot: snapshot, agentStopped: true))
        let foreign = try ClientNativeIdentity.ephemeralFixture()
        XCTAssertThrowsError(try LocalMacAgentSetup.rebindEndpoint(bundle: f.bundle(port: 8443, certificate: foreign.certificateDER), selection: selection, expectedSnapshot: snapshot, agentStopped: true))
        try Data(#"{"version":1,"bots":[] }"#.utf8).write(to: f.location.policy)
        XCTAssertThrowsError(try LocalMacAgentSetup.rebindEndpoint(bundle: f.bundle(port: 8443), selection: selection, expectedSnapshot: snapshot, agentStopped: true))
        XCTAssertEqual(try Data(contentsOf: f.location.configuration), before)
    }
    func testLoadOnlyRejectsSoftwarePolicyAndFingerprintMismatchAndExplicitMissingIsSafe() async throws {
        let f = try Fixture(); defer { f.cleanup() }; let selection = try f.prepare()
        let success: [String: Any] = ["ok": true, "policy": LocalMacAgentSetup.productionPolicy, "certificateDER": f.der.base64EncodedString(), "fingerprint": f.pin]
        let bytes = try JSONSerialization.data(withJSONObject: success)
        let loaded = await LocalMacAgentSetup.loadIdentity(location: f.location, selection: selection, expectedInstallationID: "host_fixture", invoke: { _, _ in bytes })
        XCTAssertEqual(loaded, .usable(fingerprint: f.pin))
        let missing = await LocalMacAgentSetup.loadIdentity(location: f.location, selection: selection, expectedInstallationID: "host_fixture", invoke: { _, _ in Data(#"{"ok":false,"error":"missing"}"#.utf8) })
        XCTAssertEqual(missing, .missing)
        var oldPolicy = success; oldPolicy["policy"] = "data_protection_keychain_device_only"
        let oldBytes = try JSONSerialization.data(withJSONObject: oldPolicy)
        XCTAssertEqual(try LocalMacAgentSetup.parseIdentityLoadReply(oldBytes), .blocked(.nonExportabilityUnconfirmed))
        var bad = success; bad["fingerprint"] = String(repeating: "b", count: 64)
        XCTAssertEqual(try LocalMacAgentSetup.parseIdentityLoadReply(JSONSerialization.data(withJSONObject: bad)), .blocked(.protocolError))
        try Data(#"{"fingerprint":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}"#.utf8).write(to: f.location.dataDirectory.appendingPathComponent("native-device.json")); _ = chmod(f.location.dataDirectory.appendingPathComponent("native-device.json").path, 0o600)
        let partial = await LocalMacAgentSetup.loadIdentity(location: f.location, selection: selection, expectedInstallationID: "host_fixture", invoke: { _, _ in bytes })
        XCTAssertEqual(partial, .blocked(.conflict))
        let vanished = await LocalMacAgentSetup.loadIdentity(location: f.location, selection: selection, expectedInstallationID: "host_fixture", invoke: { _, _ in Data(#"{"ok":false,"error":"missing"}"#.utf8) })
        XCTAssertEqual(vanished, .blocked(.conflict))
    }
    func testLoadOnlyConflictsAndUnknownRepliesStayBlocked() throws {
        for failure in ["conflict", "locked", "signingIdentityUnavailable", "nonExportabilityUnconfirmed", "unavailable", "unexpected"] {
            let result = try LocalMacAgentSetup.parseIdentityLoadReply(JSONSerialization.data(withJSONObject: ["ok": false, "error": failure]))
            guard case .blocked = result else { XCTFail("unexpected usable or missing"); continue }
        }
        XCTAssertThrowsError(try LocalMacAgentSetup.parseIdentityLoadReply(Data(#"{"ok":false,"error":"missing","operation":"provision"}"#.utf8)))
    }
    func testLoadOnlyRechecksPublicPolicyAfterAwaitBeforeAcceptingIdentity() async throws {
        let f = try Fixture(); defer { f.cleanup() }; let selection = try f.prepare()
        let bytes = try JSONSerialization.data(withJSONObject: ["ok": true, "policy": LocalMacAgentSetup.productionPolicy,
            "certificateDER": f.der.base64EncodedString(), "fingerprint": f.pin])
        let policy = f.location.policy
        let result = await LocalMacAgentSetup.loadIdentity(location: f.location, selection: selection, expectedInstallationID: "host_fixture", invoke: { _, _ in
            try Data(#"{"bots":[],"version":1 }"#.utf8).write(to: policy); return bytes
        })
        XCTAssertEqual(result, .blocked(.conflict))
    }
    func testReceiptSymlinkAndHelperDriftCannotBeAcceptedByReadOnlyRecovery() throws {
        let f = try Fixture(); defer { f.cleanup() }; let selection = try f.prepare()
        let snapshot = try LocalMacAgentPolicy.read(selection: selection, expectedInstallationID: "host_fixture")
        _ = try LocalMacAgentSetup.rebindEndpoint(bundle: f.bundle(port: 8443), selection: selection, expectedSnapshot: snapshot, agentStopped: true)
        try Data("helper drift fixture".utf8).write(to: f.location.cuaHelper)
        XCTAssertEqual(try LocalMacAgentSetup.reconcileEndpointRebind(location: f.location)?.state, .conflict)
        let pointer = f.location.root.appendingPathComponent(".endpoint-rebind-active.json")
        let outside = f.parent.appendingPathComponent("outside-fixture.json")
        try Data("outside unchanged".utf8).write(to: outside)
        try FileManager.default.removeItem(at: pointer); try FileManager.default.createSymbolicLink(at: pointer, withDestinationURL: outside)
        XCTAssertThrowsError(try LocalMacAgentSetup.reconcileEndpointRebind(location: f.location))
        XCTAssertEqual(try String(contentsOf: outside, encoding: .utf8), "outside unchanged")
    }
}
#endif
