#if os(macOS)
import Foundation
import Darwin
import XCTest
import DexterHostClient
@testable import DexterAppCore
@testable import DexterClientIdentity

@MainActor final class LocalMacAgentEndpointCompletionTests: XCTestCase {
    private struct Fixture {
        let parent: URL, helper: LocalMacAgentHelperPackage, cua: LocalMacAgentCuaPackage
        let location: LocalMacAgentSetupLocation, certificate: Data
        let pin: String
        init() throws {
            parent = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("qa/endpoint-completion-" + UUID().uuidString)
            try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            certificate = try ClientNativeIdentity.ephemeralFixture().certificateDER; pin = LocalMacAgentSetup.sha256Hex(certificate)
            let identity = parent.appendingPathComponent("OWN-identity-fixture"), control = parent.appendingPathComponent("OWN-cua-fixture")
            try Data("OWN identity fixture never executed".utf8).write(to: identity); try Data("OWN CUA fixture never executed".utf8).write(to: control)
            _ = chmod(identity.path, 0o700); _ = chmod(control.path, 0o700)
            helper = .init(executable: identity); cua = .init(executable: control); location = .init(root: parent.appendingPathComponent("managed"))
        }
        var pem: String {
            var result = "-----BEGIN CERTIFICATE-----\n", rest = Substring(certificate.base64EncodedString())
            while !rest.isEmpty { result += rest.prefix(64) + "\n"; rest = rest.dropFirst(64) }
            return result + "-----END CERTIFICATE-----\n"
        }
        func bundle(port: Int = 443) throws -> LocalMacAgentSetupBundle {
            let offer: [String: Any] = ["hostUrl": "https://127.0.0.1:\(port)", "hostFingerprint": pin, "hostCertPem": pem,
                "offerId": "offer_fixture", "code": String(repeating: "A", count: 43), "expiresAt": Int64(Date().addingTimeInterval(600).timeIntervalSince1970 * 1000)]
            let object: [String: Any] = ["schema": "dexter.local-mac-agent-setup/1", "installationId": "host_fixture", "offer": offer]
            return try LocalMacAgentSetupBundle(json: String(decoding: JSONSerialization.data(withJSONObject: object), as: UTF8.self), expectedInstallationID: "host_fixture")
        }
        func connection(port: Int) throws -> LocalMacAgentConnectionDescription {
            let object: [String: Any] = ["schema": "dexter.local-mac-agent-connection/1", "installationId": "host_fixture",
                "hostUrl": "https://127.0.0.1:\(port)", "hostFingerprint": pin, "hostCertPem": pem]
            return try .init(json: String(decoding: JSONSerialization.data(withJSONObject: object), as: UTF8.self), expectedInstallationID: "host_fixture")
        }
        func prepare() throws -> LocalMacAgentSelection { try LocalMacAgentSetup.prepareCuaOnly(bundle: bundle(), helper: helper, cuaPackage: cua, location: location) }
        func snapshot(_ selection: LocalMacAgentSelection) throws -> LocalMacAgentPolicySnapshot { try LocalMacAgentPolicy.read(selection: selection, expectedInstallationID: "host_fixture") }
        func marker(_ id: String) -> URL { location.root.appendingPathComponent(".endpoint-rebind-completed-" + LocalMacAgentSetup.sha256Hex(Data(id.utf8)) + ".json") }
        func journal(_ id: String) -> URL { location.root.appendingPathComponent(".endpoint-rebind-" + LocalMacAgentSetup.sha256Hex(Data(id.utf8)) + ".json") }
        func tree() throws -> [String: String] {
            let enumeration = try XCTUnwrap(FileManager.default.enumerator(at: location.root, includingPropertiesForKeys: [.isRegularFileKey]))
            var result: [String: String] = [:]
            for case let url as URL in enumeration {
                if try url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true {
                    result[String(url.path.dropFirst(location.root.path.count))] = LocalMacAgentSetup.sha256Hex(try Data(contentsOf: url))
                }
            }
            return result
        }
        func cleanup() { try? FileManager.default.removeItem(at: parent) }
    }
    private func writeObject(_ object: [String: Any], to url: URL) throws {
        try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes]).write(to: url); XCTAssertEqual(chmod(url.path, 0o600), 0)
    }
    private func object(_ url: URL) throws -> [String: Any] { try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any]) }

    func testDurableCompletionSurvivesLegitimateGrantBindingAndFreshSecondRebind() throws {
        let fixture = try Fixture(); defer { fixture.cleanup() }; let old = try fixture.prepare(), id = UUID().uuidString
        let first = try LocalMacAgentSetup.rebindEndpoint(connection: fixture.connection(port: 8443), selection: old,
            expectedSnapshot: fixture.snapshot(old), agentStopped: true, requestID: id)
        let completed = try XCTUnwrap(LocalMacAgentSetup.reconcileEndpointRebind(location: fixture.location, requestID: id))
        XCTAssertEqual(completed.state, .committed)
        let marker = try object(fixture.marker(id)); XCTAssertEqual(marker["requestID"] as? String, id); XCTAssertEqual(marker["requestHash"] as? String, completed.requestHash)
        let authorization = try LocalMacAgentCuaAuthorization(botID: "bot_fixture", label: "OWN fixture", operations: ["mac.cua.status"], maxSessionSeconds: 30)
        _ = try LocalMacAgentPolicy.replaceCua(authorization, expectedSnapshot: fixture.snapshot(first), agentStopped: true)
        try writeObject(["installationId": "host_fixture", "ownerId": "owner_fixture", "deviceId": "device_fixture", "hostFingerprint": fixture.pin],
            to: fixture.location.dataDirectory.appendingPathComponent("binding.json"))
        try writeObject(["fingerprint": String(repeating: "a", count: 64)], to: fixture.location.dataDirectory.appendingPathComponent("native-device.json"))
        let beforeGET = try fixture.tree()
        XCTAssertEqual(try LocalMacAgentSetup.reconcileEndpointRebind(location: fixture.location, requestID: id), completed)
        XCTAssertEqual(try fixture.tree(), beforeGET) // Read-only history: no marker/journal repair.
        let fresh = try fixture.snapshot(first)
        let secondID = UUID().uuidString
        let second = try LocalMacAgentSetup.rebindEndpoint(connection: fixture.connection(port: 9443), selection: first,
            expectedSnapshot: fresh, agentStopped: true, requestID: secondID)
        XCTAssertEqual(second.hostURL, "https://127.0.0.1:9443")
        XCTAssertEqual(try fixture.snapshot(second).cuaAuthorizations, fresh.cuaAuthorizations)
        XCTAssertEqual(try LocalMacAgentSetup.reconcileEndpointRebind(location: fixture.location, requestID: id), completed)
        XCTAssertEqual(try LocalMacAgentSetup.reconcileEndpointRebind(location: fixture.location)?.requestID, secondID)
        let beforeDuplicate = try fixture.tree()
        XCTAssertThrowsError(try LocalMacAgentSetup.rebindEndpoint(connection: fixture.connection(port: 8443), selection: first,
            expectedSnapshot: fresh, agentStopped: true, requestID: id)) // Historical receipt never rewinds a newer endpoint.
        XCTAssertEqual(try fixture.tree(), beforeDuplicate)
    }
    func testTerminalReceiptDoesNotRequireOldCapabilitiesButNeverBypassesFreshCAS() throws {
        let fixture = try Fixture(); defer { fixture.cleanup() }; let old = try fixture.prepare(), id = UUID().uuidString
        let current = try LocalMacAgentSetup.rebindEndpoint(bundle: fixture.bundle(port: 8443), selection: old,
            expectedSnapshot: fixture.snapshot(old), agentStopped: true, requestID: id)
        let stale = try fixture.snapshot(current)
        var config = try object(fixture.location.configuration)
        config["capabilities"] = current.capabilities + ["mac.browser.read"]
        config["browser"] = ["executable": fixture.helper.executable.path, "networkIsolation": "none"]
        try writeObject(config, to: fixture.location.configuration)
        let changed = try LocalMacAgentSelection(configurationURL: fixture.location.configuration)
        _ = try fixture.snapshot(changed)
        XCTAssertEqual(try LocalMacAgentSetup.reconcileEndpointRebind(location: fixture.location)?.state, .committed)
        let before = try fixture.tree()
        XCTAssertThrowsError(try LocalMacAgentSetup.rebindEndpoint(connection: fixture.connection(port: 9443), selection: changed,
            expectedSnapshot: stale, agentStopped: true))
        XCTAssertEqual(try fixture.tree(), before)
        let next = try LocalMacAgentSetup.rebindEndpoint(connection: fixture.connection(port: 9443), selection: changed,
            expectedSnapshot: fixture.snapshot(changed), agentStopped: true)
        XCTAssertEqual(next.capabilities, changed.capabilities)
    }
    func testPartialAndRepeatedReadOnlyRecoveryNeverCreatesMarkerOrCompletesWrites() throws {
        let fixture = try Fixture(); defer { fixture.cleanup() }; let old = try fixture.prepare(), id = UUID().uuidString, snapshot = try fixture.snapshot(old)
        XCTAssertThrowsError(try LocalMacAgentSetup.rebindEndpoint(bundle: fixture.bundle(port: 8443), selection: old, expectedSnapshot: snapshot,
            agentStopped: true, requestID: id, afterFirstWrite: { throw LocalMacAgentEndpointRebindError.outcomeUnknown }))
        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.marker(id).path))
        let before = try fixture.tree()
        for _ in 0..<3 { XCTAssertEqual(try LocalMacAgentSetup.reconcileEndpointRebind(location: fixture.location)?.state, .unknown) }
        XCTAssertThrowsError(try LocalMacAgentSetup.rebindEndpoint(bundle: fixture.bundle(port: 8443), selection: old, expectedSnapshot: snapshot, agentStopped: true, requestID: id))
        XCTAssertThrowsError(try LocalMacAgentSetup.rebindEndpoint(bundle: fixture.bundle(port: 9443), selection: old, expectedSnapshot: snapshot, agentStopped: true))
        XCTAssertEqual(try fixture.tree(), before); XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.marker(id).path))
    }
    func testLegacyCommittedWithoutMarkerRemainsReadOnlyAndCannotGrandfatherLaterDrift() throws {
        let fixture = try Fixture(); defer { fixture.cleanup() }; let old = try fixture.prepare(), id = UUID().uuidString
        let current = try LocalMacAgentSetup.rebindEndpoint(bundle: fixture.bundle(port: 8443), selection: old,
            expectedSnapshot: fixture.snapshot(old), agentStopped: true, requestID: id)
        try FileManager.default.removeItem(at: fixture.marker(id)) // Own fixture simulates pre-marker legacy journal.
        let before = try fixture.tree()
        XCTAssertEqual(try LocalMacAgentSetup.reconcileEndpointRebind(location: fixture.location)?.state, .committed)
        XCTAssertEqual(try fixture.tree(), before); XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.marker(id).path))
        try Data(#"{"version":1,"bots":[] }"#.utf8).write(to: fixture.location.policy)
        let drifted = try fixture.tree()
        XCTAssertEqual(try LocalMacAgentSetup.reconcileEndpointRebind(location: fixture.location)?.state, .conflict)
        XCTAssertThrowsError(try LocalMacAgentSetup.rebindEndpoint(connection: fixture.connection(port: 9443), selection: current,
            expectedSnapshot: fixture.snapshot(current), agentStopped: true))
        XCTAssertEqual(try fixture.tree(), drifted); XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.marker(id).path))
    }
    func testForgedCompletionAssociationClosedSchemaAndSymlinkCannotAuthorizeHistory() throws {
        let fixture = try Fixture(); defer { fixture.cleanup() }; let old = try fixture.prepare(), id = UUID().uuidString
        _ = try LocalMacAgentSetup.rebindEndpoint(bundle: fixture.bundle(port: 8443), selection: old,
            expectedSnapshot: fixture.snapshot(old), agentStopped: true, requestID: id)
        let original = try Data(contentsOf: fixture.marker(id)), originalObject = try object(fixture.marker(id))
        for key in ["requestID", "requestHash", "newConfig", "root", "schema", "unexpected"] {
            var forged = originalObject; forged[key] = key == "requestID" ? UUID().uuidString : "OWN forged"
            try writeObject(forged, to: fixture.marker(id))
            let before = try fixture.tree()
            XCTAssertThrowsError(try LocalMacAgentSetup.reconcileEndpointRebind(location: fixture.location, requestID: id))
            XCTAssertEqual(try fixture.tree(), before)
        }
        try original.write(to: fixture.marker(id))
        let outside = fixture.parent.appendingPathComponent("OWN-outside-marker.json"); try original.write(to: outside); _ = chmod(outside.path, 0o600)
        try FileManager.default.removeItem(at: fixture.marker(id)); try FileManager.default.createSymbolicLink(at: fixture.marker(id), withDestinationURL: outside)
        XCTAssertThrowsError(try LocalMacAgentSetup.reconcileEndpointRebind(location: fixture.location, requestID: id))
        XCTAssertEqual(try FileManager.default.destinationOfSymbolicLink(atPath: fixture.marker(id).path), outside.path)
    }
    func testCompletionDoesNotAcceptTamperedJournalOrMismatchedRequestedID() throws {
        let fixture = try Fixture(); defer { fixture.cleanup() }; let old = try fixture.prepare(), id = UUID().uuidString
        _ = try LocalMacAgentSetup.rebindEndpoint(bundle: fixture.bundle(port: 8443), selection: old,
            expectedSnapshot: fixture.snapshot(old), agentStopped: true, requestID: id)
        let original = try object(fixture.journal(id))
        for key in ["requestHash", "unexpected"] {
            var changed = original; changed[key] = "OWN forged journal"
            try writeObject(changed, to: fixture.journal(id))
            XCTAssertThrowsError(try LocalMacAgentSetup.reconcileEndpointRebind(location: fixture.location, requestID: id))
        }
        try writeObject(original, to: fixture.journal(id))
        let another = UUID().uuidString; try Data(contentsOf: fixture.journal(id)).write(to: fixture.journal(another)); _ = chmod(fixture.journal(another).path, 0o600)
        XCTAssertThrowsError(try LocalMacAgentSetup.reconcileEndpointRebind(location: fixture.location, requestID: another))
        XCTAssertEqual(try LocalMacAgentSetup.reconcileEndpointRebind(location: fixture.location, requestID: id)?.state, .committed)
    }
}
#endif
