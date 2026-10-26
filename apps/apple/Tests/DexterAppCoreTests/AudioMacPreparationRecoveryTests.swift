import Foundation
import XCTest
@testable import DexterAppCore
#if os(macOS)
import AVFoundation
import DexterHostClient
#endif

@MainActor final class AudioMacPreparationRecoveryTests: XCTestCase {
    func testOptionalVoiceProcessingFallsBackOnceBeforeAnyCapture() throws {
        var attempts: [String] = []
        let result = try LiveVoiceAudioBootstrap.start(voiceProcessing: { () throws -> Int in
            attempts.append("voice"); throw LiveVoiceAudioStartupError(.initialization, osStatus: -10851)
        }, plain: { attempts.append("plain"); return 17 })
        XCTAssertEqual(result, 17); XCTAssertEqual(attempts, ["voice", "plain"])
    }
    func testUnavailableDevicesAndInvalidFormatsDoNotRetryGraph() {
        for reason in [LiveVoiceAudioStartupError.Reason.inputUnavailable, .outputUnavailable, .inputFormat, .outputFormat] {
            var plain = 0
            XCTAssertThrowsError(try LiveVoiceAudioBootstrap.start(voiceProcessing: { throw LiveVoiceAudioStartupError(reason) },
                plain: { plain += 1 })) { XCTAssertEqual($0 as? LiveVoiceAudioStartupError, .init(reason)) }
            XCTAssertEqual(plain, 0)
        }
    }
    func testFailedPlainGraphPreservesItsOwnFailureWithoutThirdAttempt() {
        var attempts = 0
        XCTAssertThrowsError(try LiveVoiceAudioBootstrap.start(voiceProcessing: {
            attempts += 1; throw LiveVoiceAudioStartupError(.duplexFormat)
        }, plain: {
            attempts += 1; throw LiveVoiceAudioStartupError(.initialization, osStatus: -50)
        })) { XCTAssertEqual($0 as? LiveVoiceAudioStartupError, .init(.initialization, osStatus: -50)) }
        XCTAssertEqual(attempts, 2)
    }
    func testStartupCauseSurvivesControllerCloseBeforeFirstVoice() async throws {
        let wire = AudioMacSyntheticWire(), audio = AudioMacSyntheticAudio()
        let next = AudioMacSyntheticWire()
        var connections = 0
        audio.error = .init(.outputUnavailable)
        let controller = LiveVoiceController(keyStore: AudioMacSyntheticKeys(), transportFactory: { _ in
            connections += 1; return connections == 1 ? wire : next
        }, audio: audio)
        await start(controller)
        XCTAssertEqual(audio.starts, 0)
        wire.pushStarted()
        await eventually { controller.state == .failed }
        XCTAssertEqual(controller.audioStartupFailure, .init(.outputUnavailable))
        XCTAssertEqual(controller.safeMessage, LiveVoiceAudioStartupError(.outputUnavailable).message)
        XCTAssertTrue(controller.inputCaption.isEmpty); XCTAssertTrue(controller.outputCaption.isEmpty)
        XCTAssertTrue(wire.cancelled); XCTAssertFalse(audio.running)
        XCTAssertFalse(controller.finalUsageConfirmed)
        audio.error = nil
        await start(controller); next.pushStarted()
        await eventually { controller.state == .listening }
        XCTAssertNil(controller.audioStartupFailure)
        XCTAssertEqual(connections, 2)
        controller.invalidate()
        XCTAssertFalse(audio.running)
    }
    func testCancelDuringMicrophonePromptCannotStartTransportOrAudio() async {
        let audio = AudioMacSyntheticAudio(); audio.holdPermission = true
        var transports = 0
        let controller = LiveVoiceController(keyStore: AudioMacSyntheticKeys(), transportFactory: { _ in transports += 1; return AudioMacSyntheticWire() }, audio: audio)
        let task = Task { await self.start(controller) }
        await eventually { audio.permission != nil }
        controller.invalidate()
        audio.permission?.resume(returning: true); audio.permission = nil
        await task.value
        XCTAssertEqual(transports, 0); XCTAssertEqual(audio.starts, 0); XCTAssertFalse(audio.running)
    }
    private func start(_ controller: LiveVoiceController) async {
        await controller.start(scope: .init(hostID: "fixture-host", botID: "fixture-bot", threadID: "fixture-thread"), voice: "bossa", instructions: "Synthetic.")
    }
    private func eventually(_ condition: @MainActor () -> Bool) async {
        for _ in 0..<100 { if condition() { return }; try? await Task.sleep(for: .milliseconds(5)) }
        XCTFail("Synthetic lifecycle did not finish")
    }
    #if os(macOS)
    func testNativeDeviceFormatsAreCheckedIndependentlyOfWireRate() throws {
        for rate in [24_000.0, 44_100, 48_000, 96_000] {
            let format = try XCTUnwrap(AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 2, interleaved: false))
            XCTAssertNoThrow(try NativeLiveVoiceAudio.validateDeviceFormat(format, input: true))
            XCTAssertNoThrow(try NativeLiveVoiceAudio.validateDeviceFormat(format, input: false))
        }
        let invalid = try XCTUnwrap(AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 384_000, channels: 2, interleaved: false))
        XCTAssertThrowsError(try NativeLiveVoiceAudio.validateDeviceFormat(invalid, input: false)) {
            XCTAssertEqual($0 as? LiveVoiceAudioStartupError, .init(.outputFormat))
        }
        XCTAssertThrowsError(try NativeLiveVoiceAudio.validateDeviceFormat(AVAudioFormat(), input: true)) {
            XCTAssertEqual($0 as? LiveVoiceAudioStartupError, .init(.inputUnavailable))
        }
    }
    func testReopenedPreparationRestoresFingerprintWithoutHelperOrMutation() throws {
        try withPublicFixture { location, pin in
            let before = try publicFiles(location)
            let observation = try MacAutoSetupPublicObservation.read(location: location, installation: "fixture-install")
            XCTAssertEqual(observation.deviceID, "fixture-device")
            XCTAssertEqual(try observation.correlatedFingerprint(expected: nil, intent: nil), pin)
            XCTAssertEqual(try publicFiles(location), before)
        }
    }
    func testLostApprovalAckRetainsExactIntentAndOriginalBinding() throws {
        try withPublicFixture { location, pin in
            let intent = MacAutoApprovalIntent(claimID: "fixture-claim", installation: "fixture-install", fingerprint: pin,
                capabilities: ["mac.cua.status", "mac.cua.observe", "mac.cua.control"], root: location.root.path)
            try intent.save(location: location)
            let before = try publicFiles(location)
            for _ in 0..<3 {
                let restored = try MacAutoApprovalIntent.read(location: location, installation: "fixture-install")
                XCTAssertEqual(restored, intent)
                let state = try MacAutoSetupPublicObservation.read(location: location, installation: "fixture-install")
                XCTAssertEqual(try state.correlatedFingerprint(expected: nil, intent: restored), pin)
            }
            XCTAssertEqual(try publicFiles(location), before)
        }
    }
    func testForeignInstallationPinAndIncompleteNativeBindingFailClosed() throws {
        try withPublicFixture { location, _ in
            XCTAssertThrowsError(try MacAutoSetupPublicObservation.read(location: location, installation: "other-install"))
            try FileManager.default.removeItem(at: location.dataDirectory.appendingPathComponent("native-device.json"))
            XCTAssertThrowsError(try MacAutoSetupPublicObservation.read(location: location, installation: "fixture-install"))
        }
        try withPublicFixture { location, _ in
            let binding = location.dataDirectory.appendingPathComponent("binding.json")
            var object = try JSONSerialization.jsonObject(with: Data(contentsOf: binding)) as! [String: Any]
            object["hostFingerprint"] = String(repeating: "c", count: 64)
            try write(object, binding)
            XCTAssertThrowsError(try MacAutoSetupPublicObservation.read(location: location, installation: "fixture-install"))
        }
    }
    func testExistingFingerprintCannotBeReplacedByAnotherIntent() throws {
        let state = MacAutoSetupPublicObservation(fingerprint: String(repeating: "a", count: 64), deviceID: nil)
        XCTAssertThrowsError(try state.correlatedFingerprint(expected: String(repeating: "b", count: 64), intent: nil))
        let intent = MacAutoApprovalIntent(claimID: "fixture-claim", installation: "fixture-install", fingerprint: String(repeating: "b", count: 64),
            capabilities: ["mac.cua.status", "mac.cua.observe", "mac.cua.control"], root: "/synthetic")
        XCTAssertThrowsError(try state.correlatedFingerprint(expected: nil, intent: intent))
    }
    func testIdentityFailuresStaySpecificAndDoNotExposeRawErrors() {
        let signature = MacAutoSetupController.message(LocalMacAgentIdentityBlockReason.signingIdentityUnavailable)
        let policy = MacAutoSetupController.message(LocalMacAgentIdentityBlockReason.nonExportabilityUnconfirmed)
        let locked = MacAutoSetupController.message(LocalMacAgentIdentityBlockReason.locked)
        XCTAssertNotEqual(signature, policy); XCTAssertNotEqual(locked, policy)
        XCTAssertEqual(MacAutoSetupController.message(LocalMacAgentSetupError.signingIdentityUnavailable), signature)
        XCTAssertEqual(MacAutoSetupController.message(LocalMacAgentSetupError.identityPolicyUnavailable), policy)
    }
    private func withPublicFixture(_ body: (LocalMacAgentSetupLocation, String) throws -> Void) throws {
        let base = ProcessInfo.processInfo.environment["DEXTER_TEST_PRIVATE_ROOT"].map { URL(fileURLWithPath: $0) }
            ?? URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent(".synthetic-audio-mac")
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let root = base.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: root) }
        let location = LocalMacAgentSetupLocation(root: root), pin = String(repeating: "a", count: 64)
        try FileManager.default.createDirectory(at: location.dataDirectory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        try write(["installationID": "fixture-install", "hostFingerprint": String(repeating: "b", count: 64)], location.helperConfiguration)
        try write(["fingerprint": pin], location.dataDirectory.appendingPathComponent("native-device.json"))
        try write(["installationId": "fixture-install", "ownerId": "fixture-owner", "deviceId": "fixture-device", "hostFingerprint": String(repeating: "b", count: 64)], location.dataDirectory.appendingPathComponent("binding.json"))
        try body(location, pin)
    }
    private func write(_ object: [String: Any], _ url: URL) throws {
        try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]).write(to: url)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
    private func publicFiles(_ location: LocalMacAgentSetupLocation) throws -> [String: Data] {
        let urls = [location.helperConfiguration, location.dataDirectory.appendingPathComponent("binding.json"), location.dataDirectory.appendingPathComponent("native-device.json"), location.root.appendingPathComponent(".mac-auto-approval.json")]
        return try Dictionary(uniqueKeysWithValues: urls.filter { FileManager.default.fileExists(atPath: $0.path) }.map { ($0.path, try Data(contentsOf: $0)) })
    }
    #endif
}

@MainActor private final class AudioMacSyntheticKeys: LiveAPIKeyStore {
    func status(hostID: String) -> LiveKeyStatus { .configured }
    func load(hostID: String) throws -> String { "fixture-key" }
    func save(_ key: String, hostID: String) throws {}
    func remove(hostID: String) throws {}
}
@MainActor private final class AudioMacSyntheticAudio: LiveVoiceAudio {
    var echoCancellationAvailable: Bool { false }
    var error: LiveVoiceAudioStartupError?
    var starts = 0, running = false, holdPermission = false
    var permission: CheckedContinuation<Bool, Never>?
    func requestMicrophonePermission() async -> Bool {
        if holdPermission { return await withCheckedContinuation { permission = $0 } }; return true
    }
    func start(onInput: @escaping @Sendable (LiveVoiceAudioChunk) -> Void, onFailure: @escaping @Sendable (LiveVoiceFailure) -> Void) throws {
        starts += 1; if let error { throw error }; running = true
    }
    func play(_ pcm: Data) throws {}
    func setCaptureMuted(_ muted: Bool) {}
    func stop() { running = false }
}
@MainActor private final class AudioMacSyntheticWire: LiveVoiceTransport {
    var cancelled = false
    private var waiter: CheckedContinuation<Data, any Error>?
    private var queued: Data?
    func send(_ data: Data) async throws {}
    func receive() async throws -> Data {
        if let queued { self.queued = nil; return queued }
        if cancelled { throw LiveVoiceFailure.connectionUnavailable }
        return try await withCheckedThrowingContinuation { waiter = $0 }
    }
    func pushStarted() {
        let data = Data(#"{"type":"session.started","session":{"id":"fixture-session"}}"#.utf8)
        if let waiter { self.waiter = nil; waiter.resume(returning: data) } else { queued = data }
    }
    func cancel() {
        cancelled = true; let waiting = waiter; waiter = nil; waiting?.resume(throwing: LiveVoiceFailure.connectionUnavailable)
    }
}
