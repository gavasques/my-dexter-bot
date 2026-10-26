#if os(macOS)
import Foundation
import Darwin
import XCTest
@testable import DexterAppCore
@testable import DexterClientIdentity

@MainActor final class LocalMacAgentProvisionCancellationTests: XCTestCase {
    private struct Fixture {
        let parent: URL, executable: URL, configuration: URL
        let location: LocalMacAgentSetupLocation, selection: LocalMacAgentSelection
        let fingerprint: String
        init(mode: String = "reply") throws {
            parent = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("qa/provision-fixture-" + mode + "-" + UUID().uuidString)
            try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let source = parent.appendingPathComponent("OWN-fixture.c")
            try Data(Self.fixtureSource.utf8).write(to: source)
            executable = parent.appendingPathComponent("OWN-fixture")
            let compiler = Process(); compiler.executableURL = URL(fileURLWithPath: "/usr/bin/clang")
            compiler.arguments = [source.path, "-o", executable.path]; compiler.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin"]
            compiler.standardInput = FileHandle.nullDevice; compiler.standardOutput = FileHandle.nullDevice; compiler.standardError = FileHandle.nullDevice
            try compiler.run(); compiler.waitUntilExit()
            guard compiler.terminationStatus == 0 else { throw LocalMacAgentSetupError.invalidInput }; _ = chmod(executable.path, 0o700)
            let native = try ClientNativeIdentity.ephemeralFixture(), certificate = native.certificateDER
            fingerprint = LocalMacAgentSetup.sha256Hex(certificate)
            var pem = "-----BEGIN CERTIFICATE-----\n", rest = Substring(certificate.base64EncodedString())
            while !rest.isEmpty { pem += rest.prefix(64) + "\n"; rest = rest.dropFirst(64) }; pem += "-----END CERTIFICATE-----\n"
            let offer: [String: Any] = ["hostUrl": "https://127.0.0.1:443", "hostFingerprint": fingerprint, "hostCertPem": pem,
                "offerId": "offer_fixture", "code": String(repeating: "A", count: 43), "expiresAt": Int64(Date().addingTimeInterval(600).timeIntervalSince1970 * 1000)]
            let value: [String: Any] = ["schema": "dexter.local-mac-agent-setup/1", "installationId": "host_fixture", "offer": offer]
            let bundle = try LocalMacAgentSetupBundle(json: String(decoding: JSONSerialization.data(withJSONObject: value), as: UTF8.self), expectedInstallationID: "host_fixture")
            location = .init(root: parent.appendingPathComponent("managed"))
            let plan = try bundle.plan(name: "OWN fixture", browserExecutable: executable, capabilities: ["mac.browser.read"])
            selection = try LocalMacAgentSetup.prepare(plan, helper: .init(executable: executable), location: location)
            configuration = location.helperConfiguration
            let reply: [String: Any] = ["ok": true, "fingerprint": fingerprint, "certificateDER": certificate.base64EncodedString(), "policy": LocalMacAgentSetup.productionPolicy]
            try JSONSerialization.data(withJSONObject: reply).write(to: URL(fileURLWithPath: configuration.path + ".fixture-reply"))
        }
        var marker: URL { URL(fileURLWithPath: configuration.path + ".fixture-started") }
        func cleanup() { try? FileManager.default.removeItem(at: parent) }
        // Our compiled C fixture never calls Security/Keychain; this is NOT the packaged helper.
        static let fixtureSource = #"""
        #include <stdio.h>
        #include <stdlib.h>
        #include <string.h>
        #include <unistd.h>
        #include <signal.h>
        int main(int argc, char **argv) {
            if (argc != 3 || strcmp(argv[1], "--config") != 0) return 21;
            if (strstr(argv[2], "earlyexit")) return 31;
            char input[64] = {0}; int used = 0, n;
            while (used < 63 && (n = read(0, input + used, 63 - used)) > 0) used += n;
            if (strcmp(input, "{\"operation\":\"provision\"}") != 0) return 22;
            char marker[4096]; snprintf(marker, sizeof(marker), "%s.fixture-started", argv[2]);
            FILE *record = fopen(marker, "w"); if (!record) return 23; fprintf(record, "%d", getpid()); fclose(record);
            if (strstr(argv[2], "ignore")) signal(SIGTERM, SIG_IGN);
            if (strstr(argv[2], "hang") || strstr(argv[2], "ignore")) { for (;;) usleep(10000); }
            if (strstr(argv[2], "oversize")) { char bytes[4096]; memset(bytes, 'x', sizeof(bytes)); for (int i = 0; i < 40; i++) write(1, bytes, sizeof(bytes)); return 0; }
            char reply[4096]; snprintf(reply, sizeof(reply), "%s.fixture-reply", argv[2]);
            FILE *file = fopen(reply, "r"); if (!file) return 24; int byte; while ((byte = fgetc(file)) != EOF) fputc(byte, stdout); fclose(file); fflush(stdout);
            return 0;
        }
        """#
    }
    private func waitForMarker(_ marker: URL) async throws -> Int32 {
        let deadline = ProcessInfo.processInfo.systemUptime + 3
        while ProcessInfo.processInfo.systemUptime < deadline {
            if let bytes = try? Data(contentsOf: marker), bytes.count <= 32,
               let pid = Int32(String(decoding: bytes, as: UTF8.self)) { return pid }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("OWN fixture marker absent"); throw LocalMacAgentSetupError.identityUnavailable
    }
    func testProductionWrapperUsesExactVerifiedSnapshotAndStrictPublicReply() async throws {
        let fixture = try Fixture(); defer { fixture.cleanup() }
        let before = try LocalMacAgentPolicy.read(selection: fixture.selection, expectedInstallationID: "host_fixture")
        let fingerprint = try await LocalMacAgentSetup.provisionIdentity(fixture.location)
        XCTAssertEqual(fingerprint, fixture.fingerprint)
        XCTAssertEqual(try LocalMacAgentPolicy.read(selection: fixture.selection, expectedInstallationID: "host_fixture"), before)
        XCTAssertTrue(FileManager.default.fileExists(atPath: fixture.marker.path)); XCTAssertFalse(fixture.selection.hasSavedPairing)
    }
    func testCancellationBeforeRunAndFalseLiveGateNeverDispatchFixture() async throws {
        let fixture = try Fixture(); defer { fixture.cleanup() }
        let cancelled = Task { try await LocalMacAgentSetup.provisionIdentity(fixture.location) }; cancelled.cancel()
        do { _ = try await cancelled.value; XCTFail("cancelled invocation succeeded") } catch { XCTAssertTrue(error is CancellationError) }
        do { _ = try await LocalMacAgentSetup.provisionIdentity(fixture.location, isCurrent: { false }); XCTFail("false gate accepted") } catch {}
        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.marker.path))
    }
    func testPolicyAndExecutableDriftBeforeRunRefuseWithoutDispatch() async throws {
        for mutateExecutable in [false, true] {
            let fixture = try Fixture(); defer { fixture.cleanup() }; var gateReads = 0
            do {
                _ = try await LocalMacAgentSetup.provisionIdentity(fixture.location, isCurrent: {
                    gateReads += 1
                    if gateReads == 2 {
                        if mutateExecutable {
                            try! Data("OWN replaced executable fixture".utf8).write(to: fixture.location.helper); _ = chmod(fixture.location.helper.path, 0o700)
                        } else {
                            try! Data(#"{"version":1,"bots":[],"unexpected":"OWN"}"#.utf8).write(to: fixture.location.policy); _ = chmod(fixture.location.policy.path, 0o600)
                        }
                    }
                    return true
                }); XCTFail("snapshot drift accepted")
            } catch {}
            XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.marker.path))
        }
    }
    func testLiveGateInvalidationStopsOwnRunningFixtureWithoutReturningReply() async throws {
        let fixture = try Fixture(mode: "hang"); defer { fixture.cleanup() }; var current = true
        let task = Task { try await LocalMacAgentSetup.provisionIdentity(fixture.location, isCurrent: { current }) }
        let pid = try await waitForMarker(fixture.marker); current = false
        do { _ = try await task.value; XCTFail("invalidated invocation succeeded") } catch { XCTAssertEqual(error as? LocalMacAgentSetupError, .conflict) }
        XCTAssertEqual(kill(pid, 0), -1); XCTAssertEqual(errno, ESRCH)
    }
    func testCancelStopsOnlyOwnChildAndNeverRetries() async throws {
        let fixture = try Fixture(mode: "hang"); defer { fixture.cleanup() }
        let unrelatedConfig = fixture.parent.appendingPathComponent("unrelated-hang.json"), unrelated = Process(), input = Pipe()
        unrelated.executableURL = fixture.executable; unrelated.arguments = ["--config", unrelatedConfig.path]
        unrelated.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin"]; unrelated.standardInput = input
        unrelated.standardOutput = FileHandle.nullDevice; unrelated.standardError = FileHandle.nullDevice
        try unrelated.run(); try input.fileHandleForWriting.write(contentsOf: Data(#"{"operation":"provision"}"#.utf8)); try input.fileHandleForWriting.close()
        defer { if unrelated.isRunning { unrelated.terminate() }; unrelated.waitUntilExit() }
        _ = try await waitForMarker(URL(fileURLWithPath: unrelatedConfig.path + ".fixture-started"))
        let task = Task { try await LocalMacAgentSetup.provisionIdentity(fixture.location) }
        let ownPID = try await waitForMarker(fixture.marker); task.cancel()
        do { _ = try await task.value; XCTFail("cancelled child succeeded") } catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertEqual(kill(ownPID, 0), -1); XCTAssertEqual(errno, ESRCH); XCTAssertTrue(unrelated.isRunning)
        XCTAssertEqual(try String(contentsOf: fixture.marker, encoding: .utf8), String(ownPID))
    }
    func testDeadlineAndOutputBoundAndForcedOwnStopAreEnforced() async throws {
        for mode in ["oversize", "ignore"] {
            let fixture = try Fixture(mode: mode); defer { fixture.cleanup() }; let start = ProcessInfo.processInfo.systemUptime
            do {
                _ = try await LocalMacAgentSetup.invokeProvisionHelper(fixture.location.helper, configuration: fixture.configuration,
                    limits: .init(timeout: mode == "ignore" ? 0.2 : 2, stopGrace: 0.05, outputMaximum: 65536), isCurrent: { true }, beforeDispatch: {})
                XCTFail("bounded failure succeeded")
            } catch { XCTAssertEqual(error as? LocalMacAgentProvisionInvocationFailure, mode == "ignore" ? .timedOut : .outputLimit) }
            XCTAssertLessThan(ProcessInfo.processInfo.systemUptime - start, 3)
            let pid = try await waitForMarker(fixture.marker); XCTAssertEqual(kill(pid, 0), -1); XCTAssertEqual(errno, ESRCH)
        }
    }
    func testInputDispatchGateRunsAfterRunAndCanRefuseBeforeProvisionInput() async throws {
        let fixture = try Fixture(); defer { fixture.cleanup() }; var checks = 0
        do {
            _ = try await LocalMacAgentSetup.invokeProvisionHelper(fixture.location.helper, configuration: fixture.configuration,
                isCurrent: { true }, beforeDispatch: { checks += 1; if checks == 2 { throw LocalMacAgentSetupError.conflict } })
            XCTFail("input dispatch gate ignored")
        } catch { XCTAssertEqual(error as? LocalMacAgentSetupError, .conflict) }
        XCTAssertEqual(checks, 2); XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.marker.path))
    }
    func testReplyRequiresEntireJSONValidCertificateHashPolicyAndSuccessfulExit() throws {
        let fixture = try Fixture(); defer { fixture.cleanup() }
        let reply = try Data(contentsOf: URL(fileURLWithPath: fixture.configuration.path + ".fixture-reply"))
        XCTAssertThrowsError(try LocalMacAgentSetup.parseProvisionReply(reply + Data("OWN trailing bytes".utf8), terminationStatus: 0))
        XCTAssertThrowsError(try LocalMacAgentSetup.parseProvisionReply(reply, terminationStatus: 1))
        var value = try XCTUnwrap(try JSONSerialization.jsonObject(with: reply) as? [String: Any])
        value["certificateDER"] = Data("OWN invalid DER".utf8).base64EncodedString()
        XCTAssertThrowsError(try LocalMacAgentSetup.parseProvisionReply(JSONSerialization.data(withJSONObject: value), terminationStatus: 0))
        value["policy"] = "software_data_protection_keychain_device_only"
        XCTAssertThrowsError(try LocalMacAgentSetup.parseProvisionReply(JSONSerialization.data(withJSONObject: value), terminationStatus: 0))
        XCTAssertThrowsError(try LocalMacAgentSetup.parseProvisionReply(Data(), terminationStatus: 0))
    }
    func testExitedOwnedChildBeforeInputWriteIsBoundedRedactedFailureAndDoesNotSignalParent() async throws {
        let fixture = try Fixture(mode: "earlyexit"); defer { fixture.cleanup() }; var dispatchChecks = 0
        do {
            _ = try await LocalMacAgentSetup.invokeProvisionHelper(fixture.location.helper, configuration: fixture.configuration,
                isCurrent: { true }, beforeDispatch: { dispatchChecks += 1; if dispatchChecks == 2 { usleep(50000) } })
            XCTFail("dead child input succeeded")
        } catch { XCTAssertEqual(error as? LocalMacAgentSetupError, .identityUnavailable) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.marker.path)); XCTAssertEqual(dispatchChecks, 2)
    }
}
#endif
