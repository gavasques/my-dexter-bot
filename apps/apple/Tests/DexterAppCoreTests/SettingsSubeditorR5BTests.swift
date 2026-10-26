#if os(macOS)
import DexterClientIdentity
import DexterHostClient
import Foundation
import XCTest
@testable import DexterAppCore

@MainActor final class SettingsSubeditorR5BTests: XCTestCase {
    private func model(_ wire: BrowserR5BTransport, port: Int) async throws -> DexterAppModel {
        let pairing = PairedHostOnboarding(journal: UnavailableClientClaimJournal(), storage: EphemeralPairedHostStateStorage(),
            identityStorage: { _ in BrowserR5BForbiddenIdentityStorage() })
        let model = DexterAppModel(client: HostClient(baseURL: URL(string: "http://127.0.0.1:\(port)")!, transport: wire),
            storage: BrowserR5BStorage(), pairing: pairing)
        await model.refresh(); XCTAssertTrue(model.isOnline); return model
    }
    private func settle(_ editor: BrowserUseSettingsEditor) async throws {
        for _ in 0..<150 { if !editor.busy { return }; try await Task.sleep(for: .milliseconds(2)) }
        XCTFail("Scoped browser request did not settle")
    }
    private func held(_ wire: BrowserR5BTransport) async throws {
        for _ in 0..<150 { if await wire.isHeld() { return }; try await Task.sleep(for: .milliseconds(2)) }
        XCTFail("Synthetic response did not reach its hold")
    }
    func testStaleWindowSessionAndQueuedLoadSendNoBrowserRequestToEitherBase() async throws {
        let a = BrowserR5BTransport(), b = BrowserR5BTransport()
        let modelA = try await model(a, port: 49861), modelB = try await model(b, port: 49862)
        let bot = try XCTUnwrap(modelA.bots.first)
        XCTAssertEqual(modelA.bots, modelB.bots); XCTAssertEqual(modelA.approvalPolicyHostID, modelB.approvalPolicyHostID)
        let session = SettingsEditorSession(target: .bot(bot), model: modelA)
        let queuedClient = HostClient(baseURL: URL(string: modelA.hostAddress)!, transport: a)
        let editor = BrowserUseSettingsEditor(model: modelA, botID: bot.id, clientFactory: { queuedClient }, session: session)
        editor.reload()
        // MainActor has not yielded: reload's scheduled task starts only after this actual host rebind.
        modelA.hostAddress = modelB.hostAddress; modelA.configureHost()
        try await settle(editor)
        let newClient = HostClient(baseURL: URL(string: modelB.hostAddress)!, transport: b)
        let rebuilt = BrowserUseSettingsEditor(model: modelB, botID: bot.id, clientFactory: { newClient }, session: session)
        rebuilt.reload(); rebuilt.save(); await rebuilt.refreshRuntime()
        let countsA = await a.browserRequests(), countsB = await b.browserRequests()
        XCTAssertEqual(countsA, []); XCTAssertEqual(countsB, [])
        XCTAssertFalse(editor.scopeMatches); XCTAssertFalse(rebuilt.scopeMatches)
        editor.close(); rebuilt.close(); modelA.closeThreadPresentation(); modelB.closeThreadPresentation()
    }
    func testHeldConfigurationReplyCannotStartStatusReadOrReplaceDraftAfterHostSwitch() async throws {
        let wire = BrowserR5BTransport(), model = try await model(wire, port: 49863)
        let bot = try XCTUnwrap(model.bots.first), session = SettingsEditorSession(target: .bot(bot), model: model)
        let client = HostClient(baseURL: URL(string: model.hostAddress)!, transport: wire)
        let editor = BrowserUseSettingsEditor(model: model, botID: bot.id, clientFactory: { client }, session: session)
        editor.reload(); try await settle(editor)
        let baseline = try XCTUnwrap(editor.baseline); editor.policy.maxSteps = 31
        await wire.holdNext("GET"); editor.reload(); try await held(wire)
        model.hostAddress = "http://127.0.0.1:49864"; model.configureHost()
        await wire.release(); try await settle(editor)
        XCTAssertEqual(editor.baseline, baseline); XCTAssertEqual(editor.policy.maxSteps, 31)
        let requests = await wire.browserRequests()
        XCTAssertEqual(requests, ["GET /v1/browser-use/config", "GET /v1/browser-use/status", "GET /v1/browser-use/config"])
        XCTAssertFalse(editor.canSave); XCTAssertFalse(editor.scopeMatches)
        editor.reload(); await editor.refreshRuntime()
        let finalRequests = await wire.browserRequests(); XCTAssertEqual(finalRequests, requests)
        editor.close(); model.closeThreadPresentation()
    }
    func testCommittedHeldMutationStaysUncertainWithoutRuntimeReadOrReplayOnNewBase() async throws {
        let wire = BrowserR5BTransport(), model = try await model(wire, port: 49865)
        let bot = try XCTUnwrap(model.bots.first), session = SettingsEditorSession(target: .bot(bot), model: model)
        let client = HostClient(baseURL: URL(string: model.hostAddress)!, transport: wire)
        let editor = BrowserUseSettingsEditor(model: model, botID: bot.id, clientFactory: { client }, session: session)
        editor.reload(); try await settle(editor)
        let baseline = try XCTUnwrap(editor.baseline); editor.policy.maxSteps = 31
        XCTAssertTrue(editor.canSave)
        await wire.holdNext("PATCH"); editor.save(); try await held(wire)
        let committed = await wire.configurationRevision(); XCTAssertEqual(committed, 1)
        model.hostAddress = "http://127.0.0.1:49866"; model.configureHost()
        await wire.release(); try await settle(editor)
        XCTAssertEqual(editor.notice, .saveUnknown); XCTAssertTrue(editor.requiresReload)
        XCTAssertEqual(editor.baseline, baseline); XCTAssertEqual(editor.policy.maxSteps, 31)
        editor.save(); editor.reload(); await editor.refreshRuntime()
        let requests = await wire.browserRequests()
        XCTAssertEqual(requests, ["GET /v1/browser-use/config", "GET /v1/browser-use/status", "PATCH /v1/browser-use/config"])
        XCTAssertFalse(editor.busy); XCTAssertFalse(editor.canSave)
        editor.close(); model.closeThreadPresentation()
    }
    func testUnscopedGlobalSettingsRetainsExistingReadSaveAndRuntimeAPI() async throws {
        let wire = BrowserR5BTransport(), model = try await model(wire, port: 49867)
        let client = HostClient(baseURL: URL(string: model.hostAddress)!, transport: wire)
        let editor = BrowserUseSettingsEditor(model: model, clientFactory: { client })
        editor.reload(); try await settle(editor); _ = try XCTUnwrap(editor.baseline)
        editor.enabled = true; XCTAssertTrue(editor.canSave); editor.save(); try await settle(editor)
        XCTAssertEqual(editor.notice, .saved); XCTAssertEqual(editor.baseline?.enabled, true)
        XCTAssertEqual(editor.baseline?.revision, 1); XCTAssertNotNil(editor.runtime)
        let requests = await wire.browserRequests()
        XCTAssertEqual(requests, ["GET /v1/browser-use/config", "GET /v1/browser-use/status", "PATCH /v1/browser-use/config", "GET /v1/browser-use/status"])
        editor.close(); model.closeThreadPresentation()
    }
}
@MainActor private final class BrowserR5BStorage: DexterAppStateStorage {
    private var data: Data?
    func readData() -> Data? { data }
    func writeData(_ value: Data) { data = value }
    func removeData() { data = nil }
}
private actor BrowserR5BForbiddenIdentityStorage: ClientIdentityStorage {
    func load(_ scope: ClientIdentityScope) async throws -> ClientNativeIdentity? { throw ClientIdentityFailure.forbidden }
    func provision(_ scope: ClientIdentityScope) async throws -> ClientNativeIdentity { throw ClientIdentityFailure.forbidden }
}
private actor BrowserR5BTransport: HTTPTransport {
    private var requests: [String] = [], revision = 0, enabled = false
    private var bots: [String: BrowserUseBotPolicy] = [:]
    private var holdMethod: String?, heldResponse: CheckedContinuation<Void, Never>?
    func browserRequests() -> [String] { requests.filter { $0.contains("/v1/browser-use/") } }
    func configurationRevision() -> Int { revision }
    func holdNext(_ method: String) { holdMethod = method }
    func isHeld() -> Bool { heldResponse != nil }
    func release() { heldResponse?.resume(); heldResponse = nil }
    func send(_ request: URLRequest) async throws -> TransportResponse {
        let path = request.url!.path, method = request.httpMethod ?? "GET"
        requests.append(method + " " + path)
        let data: Data
        switch path {
        case "/health": data = try encodeObject(["protocolVersion": 1, "mode": "local-development", "engineRouting": "synthetic", "remotePairing": "not_implemented", "hostId": "host_r5b_identical", "state": [:]])
        case "/v1/bots": data = try encodeObject(["items": [["id": "bot_r5b", "name": "Same synthetic bot", "profileId": "profile_r5b", "ownerId": "owner_r5b", "engine": "claude", "revision": 0, "createdAt": 1]]])
        case "/v1/actions", "/v1/events", "/v1/teams", "/v1/live-voice/settings": data = try encodeObject(["items": [], "nextCursor": 0])
        case "/v1/browser-use/config":
            if method == "PATCH" {
                let input = try JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as! [String: Any]
                guard input["expectedRevision"] as? Int == revision else { throw HostClientError.conflict }
                enabled = input["enabled"] as! Bool
                bots = try JSONDecoder().decode([String: BrowserUseBotPolicy].self, from: JSONSerialization.data(withJSONObject: input["bots"]!))
                revision += 1
            }
            data = try JSONEncoder().encode(BrowserUseConfiguration(hostID: "host_r5b_identical", revision: revision, enabled: enabled, bots: bots))
        case "/v1/browser-use/status": data = try encodeObject(["hostID": "host_r5b_identical", "available": false, "activeTasks": 0, "cleanupPending": false, "credential": ["unlocked": false, "expiresAt": NSNull()], "authentication": "unverified", "apiVersion": "v2"])
        default: throw HostClientError.notFound
        }
        if path == "/v1/browser-use/config", holdMethod == method {
            holdMethod = nil; await withCheckedContinuation { heldResponse = $0 }
        }
        return TransportResponse(statusCode: 200, data: data)
    }
    private func encodeObject(_ value: [String: Any]) throws -> Data { try JSONSerialization.data(withJSONObject: value) }
}
#endif
