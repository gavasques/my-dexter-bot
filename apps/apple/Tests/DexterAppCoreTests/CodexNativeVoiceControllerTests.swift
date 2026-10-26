#if os(macOS)
import CryptoKit
import DexterHostClient
import Foundation
import XCTest
@testable import DexterAppCore

/// Actual SDK requests and controller lifecycle, with a synthetic transport/media device only.
/// No microphone, OS permission, socket, provider account, or Keychain is opened.
@MainActor final class CodexNativeVoiceControllerTests: XCTestCase {
    func testUnsupportedSavedProgramNeverAsksForMicrophoneOrStartsProvider() async {
        let wire = VoiceControllerTransport(supported: false), media = VoiceControllerMedia()
        let call = make(wire, media)
        await call.start()
        XCTAssertEqual(media.offers, 0)
        XCTAssertFalse(call.canStart)
        XCTAssertTrue(call.failureMessage?.contains("precisa ser atualizado") == true)
        let writes = await wire.writes()
        XCTAssertTrue(writes.isEmpty)
    }

    func testCommittedStartWithLostResponseClosesAudioAndReadsReceiptBeforeOwnedStop() async {
        let wire = VoiceControllerTransport(), media = VoiceControllerMedia()
        await wire.setLoseStart(true)
        let call = make(wire, media)
        await call.start()
        XCTAssertEqual(call.phase, .unconfirmed)
        XCTAssertTrue(call.hasUnconfirmedRequest)
        XCTAssertEqual(media.closes, 1)
        XCTAssertFalse(call.canStart)
        await call.start() // Does not create another offer or resend an uncertain POST.
        XCTAssertEqual(media.offers, 1)
        await call.reconcile()
        XCTAssertEqual(call.phase, .idle)
        XCTAssertFalse(call.hasUnconfirmedRequest)
        XCTAssertEqual(call.session?.state, .closed)
        let calls = await wire.calls()
        XCTAssertEqual(calls.filter { $0.hasPrefix("POST ") }.count, 2)
        let receipt = calls.firstIndex { $0.contains("/receipts/") }
        let stop = calls.firstIndex { $0.hasSuffix("/stop") }
        XCTAssertNotNil(receipt); XCTAssertNotNil(stop)
        XCTAssertLessThan(receipt ?? 999, stop ?? 0)
        XCTAssertEqual(media.answers, 0) // Recovery never resurrects the microphone or old SDP.
    }

    func testStopLostResponseUsesGetOnlyAndLocalMediaStopsBeforeHostMutation() async {
        let wire = VoiceControllerTransport(), media = VoiceControllerMedia()
        let call = make(wire, media)
        await call.start()
        await wire.setLoseStop(true)
        await call.stop()
        XCTAssertEqual(call.phase, .unconfirmed)
        XCTAssertTrue(call.hasUnconfirmedRequest)
        XCTAssertGreaterThan(media.closes, 0)
        await call.reconcile()
        XCTAssertEqual(call.phase, .idle)
        let writes = await wire.writes()
        XCTAssertEqual(writes.filter { $0.hasSuffix("/start") }.count, 1)
        XCTAssertEqual(writes.filter { $0.hasSuffix("/stop") }.count, 1)
    }

    func testScopeSwitchDuringPermissionOfferClosesLateMediaWithoutHostEffect() async {
        let wire = VoiceControllerTransport(), media = VoiceControllerMedia(held: true)
        let scope = VoiceControllerScope()
        let call = make(wire, media, isCurrent: { scope.current })
        let start = Task { await call.start() }
        await eventually { media.offers == 1 }
        scope.current = false
        await call.stop()
        media.releaseOffer()
        await start.value
        XCTAssertGreaterThan(media.closes, 0)
        XCTAssertFalse(call.hasUnconfirmedRequest)
        let writes = await wire.writes()
        XCTAssertTrue(writes.isEmpty)
    }

    func testUnconfirmedCaptureShutdownKeepsLeaseUntilNativeCleanupIsConfirmed() async {
        let firstWire = VoiceControllerTransport(), media = VoiceControllerMedia()
        let first = make(firstWire, media)
        await first.start()
        media.confirmClose = false
        await first.stop()
        XCTAssertEqual(first.phase, .unconfirmed)
        XCTAssertTrue(first.hasLocalMedia)
        let secondMedia = VoiceControllerMedia(), second = make(VoiceControllerTransport(), secondMedia)
        await second.start()
        XCTAssertEqual(secondMedia.offers, 0)
        media.confirmClose = true
        await first.reconcile()
        XCTAssertFalse(first.hasLocalMedia)
        XCTAssertNil(NativeVoiceMediaLease.holder)
        await second.stop()
    }

    func testConcurrentStartRequestsDoNotOpenTwoMicrophones() async {
        let wire = VoiceControllerTransport(), media = VoiceControllerMedia(held: true)
        let call = make(wire, media)
        let first = Task { await call.start() }
        await eventually { media.offers == 1 }
        await call.start()
        XCTAssertEqual(media.offers, 1)
        media.releaseOffer()
        await first.value
        await call.stop()
        let writes = await wire.writes()
        XCTAssertEqual(writes.filter { $0.hasSuffix("/start") }.count, 1)
    }

    func testDifferentReceiptHashCannotClearOriginalPendingRequestOrStopAnotherEffect() async {
        let wire = VoiceControllerTransport(), media = VoiceControllerMedia()
        await wire.setLoseStart(true)
        let call = make(wire, media)
        await call.start()
        await wire.setTamperReceipt(true)
        await call.reconcile()
        XCTAssertEqual(call.phase, .unconfirmed)
        XCTAssertTrue(call.hasUnconfirmedRequest)
        let writes = await wire.writes()
        XCTAssertEqual(writes.count, 1)
        await wire.setTamperReceipt(false)
        await call.reconcile()
        XCTAssertEqual(call.phase, .idle)
        XCTAssertFalse(call.hasUnconfirmedRequest)
    }

    func testPreferenceLostAcknowledgementRecoversExactReceiptAndNilResetUsesNextRevision() async {
        let wire = VoiceControllerTransport()
        let editor = preferenceEditor(wire)
        await editor.load()
        XCTAssertNil(editor.preference?.voice)
        await wire.setLosePreference(true)
        let first = await editor.save(voice: "cove")
        XCTAssertFalse(first); XCTAssertNotNil(editor.pending)
        let blocked = await editor.save(voice: nil)
        XCTAssertFalse(blocked)
        await wire.setLosePreference(false)
        await editor.reconcile()
        XCTAssertEqual(editor.preference?.voice, "cove")
        XCTAssertEqual(editor.preference?.revision, 1)
        XCTAssertNil(editor.pending)
        let reset = await editor.save(voice: nil)
        XCTAssertTrue(reset)
        XCTAssertNil(editor.preference?.voice)
        XCTAssertEqual(editor.preference?.revision, 2)
        let calls = await wire.calls()
        XCTAssertEqual(calls.filter { $0.hasPrefix("PATCH ") }.count, 2)
        XCTAssertTrue(calls.contains { $0.contains("/preferences/receipts/") })
    }

    func testPreferenceWrongReceiptHashRetainsPendingWithoutMutationReplay() async {
        let wire = VoiceControllerTransport()
        let editor = preferenceEditor(wire)
        await editor.load(); await wire.setLosePreference(true)
        _ = await editor.save(voice: "cove")
        await wire.setTamperReceipt(true)
        await editor.reconcile()
        XCTAssertNotNil(editor.pending)
        XCTAssertFalse(editor.canSave)
        await wire.setTamperReceipt(false)
        await editor.reconcile()
        XCTAssertNil(editor.pending)
        let calls = await wire.calls()
        XCTAssertEqual(calls.filter { $0.hasPrefix("PATCH ") }.count, 1)
    }

    func testPreferenceChangedHostCannotSendConfigurationMutation() async {
        let wire = VoiceControllerTransport(), scope = VoiceControllerScope()
        let editor = preferenceEditor(wire, isCurrent: { scope.current })
        await editor.load(); scope.current = false
        let saved = await editor.save(voice: "cove")
        XCTAssertFalse(saved)
        let calls = await wire.calls()
        XCTAssertFalse(calls.contains { $0.hasPrefix("PATCH ") })
    }

    private func preferenceEditor(_ wire: VoiceControllerTransport,
                                  isCurrent: @escaping @MainActor () -> Bool = { true }) -> NativeVoicePreferencesEditor {
        NativeVoicePreferencesEditor(hostID: "host_voice_qa", botID: "bot_voice_qa",
            client: HostClient(baseURL: URL(string: "http://127.0.0.1:49980")!, transport: wire),
            isCurrent: isCurrent, botRevision: { 3 })
    }

    private func make(_ wire: VoiceControllerTransport, _ media: VoiceControllerMedia,
                      isCurrent: @escaping @MainActor () -> Bool = { true }) -> CodexNativeVoiceController {
        CodexNativeVoiceController(scope: .init(hostID: "host_voice_qa", botID: "bot_voice_qa", threadID: "thread_voice_qa"),
            client: HostClient(baseURL: URL(string: "http://127.0.0.1:49980")!, transport: wire),
            isCurrent: isCurrent, mediaFactory: { media })
    }
    private func eventually(_ condition: @MainActor () -> Bool) async {
        for _ in 0..<200 { if condition() { return }; await Task.yield() }
        XCTFail("Owned synthetic async operation did not reach its bounded gate")
    }
}

@MainActor private final class VoiceControllerScope { var current = true }
@MainActor private final class VoiceControllerMedia: CodexVoiceMedia {
    var onFailure: (@MainActor (CodexVoiceMediaFailure) -> Void)?
    var onConnected: (@MainActor () -> Void)?
    var offers = 0, answers = 0, closes = 0
    var confirmClose = true
    private let held: Bool
    private var waiting: CheckedContinuation<String, Error>?
    init(held: Bool = false) { self.held = held }
    func prepareOffer() async throws -> String {
        offers += 1
        if held { return try await withCheckedThrowingContinuation { waiting = $0 } }
        return "v=0\r\nsynthetic-only-offer"
    }
    func releaseOffer() { waiting?.resume(returning: "v=0\r\nsynthetic-only-offer"); waiting = nil }
    func accept(answer: String) async throws { answers += 1; onConnected?() }
    func setMuted(_ value: Bool) {}
    func close() async -> Bool { closes += 1; onConnected = nil; onFailure = nil; return confirmClose }
}

private actor VoiceControllerTransport: HTTPTransport {
    private let supported: Bool
    private var loseStart = false, loseStop = false
    private var tamperReceipt = false
    private var losePreference = false
    private var preference: [String: Any] = ["hostId": "host_voice_qa", "botId": "bot_voice_qa", "revision": 0,
                                           "voice": NSNull(), "updatedAt": 0]
    private var requests: [String] = []
    private var session: [String: Any]?
    private var receipts: [String: Data] = [:]
    init(supported: Bool = true) { self.supported = supported }
    func setLoseStart(_ value: Bool) { loseStart = value }
    func setLoseStop(_ value: Bool) { loseStop = value }
    func setTamperReceipt(_ value: Bool) { tamperReceipt = value }
    func setLosePreference(_ value: Bool) { losePreference = value }
    func calls() -> [String] { requests }
    func writes() -> [String] { requests.filter { $0.hasPrefix("POST ") } }
    func send(_ request: URLRequest) async throws -> TransportResponse {
        let path = request.url!.path, method = request.httpMethod ?? "GET"
        requests.append(method + " " + path)
        if path.hasSuffix("/status") {
            return try response(["hostId": "host_voice_qa", "botId": "bot_voice_qa", "threadId": "thread_voice_qa",
                "botRevision": 3, "selectionRevision": 2, "supported": supported,
                "code": supported ? NSNull() : "native_voice_unsupported", "authentication": "unknown",
                "billing": "subscription_cli", "protocol": "v3", "transport": "webrtc", "voices": ["cove"],
                "cliVersion": supported ? "0.162.1" : "0.141.0", "activeSessionId": NSNull()])
        }
        if path.contains("/receipts/") {
            guard let value = receipts[path.components(separatedBy: "/").last!] else { return .init(statusCode: 404, data: Data()) }
            if tamperReceipt {
                var body = try JSONSerialization.jsonObject(with: value) as! [String: Any]
                if path.contains("/preferences/") { body["requestHash"] = String(repeating: "f", count: 64) }
                else {
                    var receipt = body["receipt"] as! [String: Any]
                    receipt["requestHash"] = String(repeating: "f", count: 64)
                    body["receipt"] = receipt
                }
                return try response(body)
            }
            return .init(statusCode: 200, data: value)
        }
        if path.hasSuffix("/preferences"), method == "GET" {
            return try response(["preference": preference, "supported": supported, "voices": ["cove", "nova"], "cliVersion": "0.162.1"])
        }
        if path.hasSuffix("/preferences"), method == "PATCH" {
            let input = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
            let previous = preference["revision"] as! Int
            guard input["expectedRevision"] as? Int == previous else { return .init(statusCode: 409, data: Data()) }
            var scoped = input; scoped["botId"] = "bot_voice_qa"
            let canonical = try JSONSerialization.data(withJSONObject: scoped, options: [.sortedKeys, .withoutEscapingSlashes])
            let hash = SHA256.hash(data: canonical).map { String(format: "%02x", $0) }.joined()
            let id = input["clientRequestId"] as! String
            preference["voice"] = input["voice"]!; preference["revision"] = previous + 1; preference["updatedAt"] = 5
            let data = try JSONSerialization.data(withJSONObject: ["id": "pref_" + id, "hostId": "host_voice_qa", "botId": "bot_voice_qa",
                "clientRequestId": id, "requestHash": hash, "previousRevision": previous, "preference": preference, "createdAt": 5])
            receipts[id] = data
            if losePreference { throw HostClientError.offline }
            return .init(statusCode: 200, data: data)
        }
        if method == "POST" {
            let input = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
            let id = input["clientRequestId"] as! String
            let start = path.hasSuffix("/start")
            var scoped = input; scoped[start ? "threadId" : "sessionId"] = start ? "thread_voice_qa" : session!["id"]
            let canonical = try JSONSerialization.data(withJSONObject: scoped, options: [.sortedKeys, .withoutEscapingSlashes])
            let hash = SHA256.hash(data: canonical).map { String(format: "%02x", $0) }.joined()
            if start {
                session = ["id": input["sessionId"]!, "generation": input["generation"]!, "hostId": "host_voice_qa",
                    "botId": "bot_voice_qa", "threadId": "thread_voice_qa", "botRevision": 3, "selectionRevision": 2,
                    "selection": ["engine": "codex"], "voice": NSNull(), "state": "active", "revision": 2,
                    "code": NSNull(), "createdAt": 1, "updatedAt": 2, "expiresAt": Int64(Date().timeIntervalSince1970 * 1000) + 120_000,
                    "cursor": 1, "startedAt": 2, "endedAt": NSNull(), "turnIds": []]
            } else { session?["state"] = "closed"; session?["revision"] = 3; session?["endedAt"] = 3 }
            let receipt: [String: Any] = ["id": "receipt_" + id, "operation": start ? "start" : "stop", "clientRequestId": id,
                "sessionId": session!["id"]!, "generation": session!["generation"]!, "hostId": "host_voice_qa",
                "threadId": "thread_voice_qa", "requestHash": hash, "createdAt": 2]
            let data = try JSONSerialization.data(withJSONObject: ["receipt": receipt, "session": session!])
            receipts[id] = data
            if (start && loseStart) || (!start && loseStop) { throw HostClientError.offline }
            return .init(statusCode: 200, data: data)
        }
        if path.hasSuffix("/exchange") {
            return try response(["sessionId": session!["id"]!, "generation": session!["generation"]!,
                "sdpAnswer": "v=0\r\nsynthetic-only-answer", "expiresAt": Int64(Date().timeIntervalSince1970 * 1000) + 120_000])
        }
        if path.hasSuffix("/events") { return try response(["items": [], "nextCursor": NSNull()]) }
        if path.contains("/sessions/"), let session { return try response(session) }
        return .init(statusCode: 404, data: Data())
    }
    private func response(_ object: [String: Any]) throws -> TransportResponse {
        .init(statusCode: 200, data: try JSONSerialization.data(withJSONObject: object))
    }
}
#endif
