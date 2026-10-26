import Foundation
import XCTest
@testable import DexterAppCore

/// Owned lifecycle only: no OS audio device, microphone, Keychain, socket or provider.
@MainActor final class LiveVoiceFailureTests: XCTestCase {
    func testStartupFailureRetainsStageAndStopsOwnedAudio() async throws {
        let wire = FailureVoiceTransport(), audio = FailureVoiceAudio()
        audio.startFailure = .audio(.engineStart, osStatus: -10851)
        let call = make(wire, audio)
        await start(call)
        XCTAssertEqual(audio.starts, 0)
        try wire.push(["type": "session.started", "session": ["id": "synthetic-start"]])
        await eventually { call.state == .failed }
        assertFailure(call, stage: .engineStart, code: -10851)
        XCTAssertTrue(wire.cancelled)
        XCTAssertGreaterThan(audio.stops, 0)
        XCTAssertFalse(call.finalUsageConfirmed)
    }

    func testCaptureFailureSurvivesOwnedCloseCallback() async throws {
        let wire = FailureVoiceTransport(), audio = FailureVoiceAudio()
        let call = make(wire, audio)
        var closeObserved = false
        call.onClosed = { _ in closeObserved = true }
        await start(call)
        try wire.push(["type": "session.started", "session": ["id": "synthetic-conversion"]])
        await eventually { call.state == .listening }
        audio.failureCallback?(.audio(.conversion))
        await eventually { call.state == .failed && closeObserved }
        assertFailure(call, stage: .conversion, code: nil)
        XCTAssertEqual(call.safeMessage, LiveVoiceFailure.audio(.conversion).message)
        XCTAssertTrue(wire.cancelled)
        XCTAssertFalse(audio.capturing)
    }

    func testPlaybackFailureEndsOnlyItsSession() async throws {
        let wire = FailureVoiceTransport(), audio = FailureVoiceAudio()
        audio.playFailure = .audio(.playback)
        let call = make(wire, audio)
        await start(call)
        try wire.push(["type": "session.started", "session": ["id": "synthetic-playback"]])
        await eventually { call.state == .listening }
        try wire.push(["type": "session.output_audio.delta", "delta": Data([0, 0, 1, 0]).base64EncodedString()])
        await eventually { call.state == .failed }
        assertFailure(call, stage: .playback, code: nil)
        XCTAssertTrue(wire.cancelled)
        XCTAssertFalse(audio.capturing)
    }

    func testNewSessionClearsFailureAndRejectsOldAudioCallback() async throws {
        let first = FailureVoiceTransport(), second = FailureVoiceTransport(), audio = FailureVoiceAudio()
        var factories = 0
        let call = LiveVoiceController(keyStore: FailureVoiceKeys(), transportFactory: { _ in
            factories += 1; return factories == 1 ? first : second
        }, audio: audio)
        await start(call)
        try first.push(["type": "session.started", "session": ["id": "synthetic-first"]])
        await eventually { call.state == .listening }
        let oldCallback = audio.failureCallback
        oldCallback?(.audio(.conversion))
        await eventually { call.state == .failed }
        assertFailure(call, stage: .conversion, code: nil)
        await start(call)
        XCTAssertNil(call.failure)
        try second.push(["type": "session.started", "session": ["id": "synthetic-second"]])
        await eventually { call.state == .listening }
        oldCallback?(.audio(.playback))
        await Task.yield()
        XCTAssertEqual(call.state, .listening)
        XCTAssertNil(call.failure)
        XCTAssertFalse(second.cancelled)
        call.invalidate()
    }

    func testDeniedMicrophoneNeverCreatesTransportOrCapture() async {
        let wire = FailureVoiceTransport(), audio = FailureVoiceAudio()
        audio.permits = false
        var factories = 0
        let call = LiveVoiceController(keyStore: FailureVoiceKeys(), transportFactory: { _ in
            factories += 1; return wire
        }, audio: audio)
        await start(call)
        XCTAssertEqual(call.state, .failed)
        if case .microphoneDenied? = call.failure {} else { XCTFail("Permission failure was discarded") }
        XCTAssertEqual(factories, 0)
        XCTAssertEqual(audio.starts, 0)
    }

    private func make(_ wire: FailureVoiceTransport, _ audio: FailureVoiceAudio) -> LiveVoiceController {
        LiveVoiceController(keyStore: FailureVoiceKeys(), transportFactory: { _ in wire }, audio: audio)
    }
    private func start(_ call: LiveVoiceController) async {
        await call.start(scope: .init(hostID: "synthetic-host", botID: "synthetic-bot", threadID: "synthetic-thread"),
                         voice: "bossa", instructions: "Synthetic voice lifecycle.")
    }
    private func assertFailure(_ call: LiveVoiceController, stage: LiveVoiceAudioStage, code: Int32?,
                               file: StaticString = #filePath, line: UInt = #line) {
        guard case .audio(let actual, let actualCode)? = call.failure else {
            XCTFail("Audio failure stage was discarded", file: file, line: line); return
        }
        XCTAssertEqual(actual.rawValue, stage.rawValue, file: file, line: line)
        XCTAssertEqual(actualCode, code, file: file, line: line)
    }
    private func eventually(_ condition: @MainActor () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        for _ in 0..<100 {
            if condition() { return }
            try? await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("Owned lifecycle did not reach expected state", file: file, line: line)
    }
}

@MainActor private final class FailureVoiceKeys: LiveAPIKeyStore {
    func status(hostID: String) -> LiveKeyStatus { .configured }
    func load(hostID: String) throws -> String { "synthetic-fixture-key" }
    func save(_ key: String, hostID: String) throws {}
    func remove(hostID: String) throws {}
}

@MainActor private final class FailureVoiceAudio: LiveVoiceAudio {
    var echoCancellationAvailable: Bool { true }
    var startFailure: LiveVoiceFailure?
    var playFailure: LiveVoiceFailure?
    var failureCallback: (@Sendable (LiveVoiceFailure) -> Void)?
    var permits = true
    private(set) var starts = 0
    private(set) var stops = 0
    private(set) var capturing = false
    func requestMicrophonePermission() async -> Bool { permits }
    func start(onInput: @escaping @Sendable (LiveVoiceAudioChunk) -> Void,
               onFailure: @escaping @Sendable (LiveVoiceFailure) -> Void) throws {
        starts += 1
        if let startFailure { throw startFailure }
        failureCallback = onFailure; capturing = true
    }
    func play(_ pcm: Data) throws { if let playFailure { throw playFailure } }
    func setCaptureMuted(_ muted: Bool) {}
    func stop() { stops += 1; capturing = false; failureCallback = nil }
}

@MainActor private final class FailureVoiceTransport: LiveVoiceTransport {
    private var inbound: [Data] = []
    private var waiter: CheckedContinuation<Data, any Error>?
    private(set) var cancelled = false
    func send(_ data: Data) async throws {}
    func receive() async throws -> Data {
        if cancelled { throw LiveVoiceFailure.connectionUnavailable }
        if !inbound.isEmpty { return inbound.removeFirst() }
        return try await withCheckedThrowingContinuation { waiter = $0 }
    }
    func push(_ event: [String: Any]) throws {
        let bytes = try JSONSerialization.data(withJSONObject: event)
        if let waiting = waiter { waiter = nil; waiting.resume(returning: bytes) }
        else { inbound.append(bytes) }
    }
    func cancel() {
        cancelled = true; let waiting = waiter; waiter = nil
        waiting?.resume(throwing: LiveVoiceFailure.connectionUnavailable)
    }
}
