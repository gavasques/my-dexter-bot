#if os(macOS)
import DexterClientIdentity
import DexterHostClient
import Foundation
import XCTest
@testable import DexterAppCore

@MainActor final class MemoryLearningEditorTests: XCTestCase {
    func testTargetsAndNullableNightEncodeExactStableContract() throws {
        let target = MemoryLearningCommand.Target(id: "record_synthetic", expectedRevision: 4, policyRevision: 2, scopeEpoch: 3)
        let undo = try JSONSerialization.jsonObject(with: JSONEncoder().encode(MemoryLearningCommand.recordUndo(target))) as! [String: Any]
        XCTAssertEqual(undo["operation"] as? String, "record.undo")
        let input = undo["input"] as! [String: Any]
        XCTAssertEqual(Set(input.keys), Set(["id", "expectedRevision", "policyRevision", "scopeEpoch"]))
        let policy = MemoryLearningPolicyInput(expectedRevision: 0, enabled: true, maintenanceEnabled: false, dreamingEnabled: false)
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(MemoryLearningCommand.policyUpdate(policy))) as! [String: Any]
        let body = encoded["input"] as! [String: Any]
        XCTAssertTrue(body["nightHour"] is NSNull)
        XCTAssertEqual(body["minIdleMs"] as? Int, 120000)
        XCTAssertEqual(body["maxJobsPerDay"] as? Int, 8)
    }
    func testLostProposalAckPreservesOriginalAndEveryReentryOnlyReadsThenHostSwitchBlocks() async throws {
        let wire = SyntheticLearningWire()
        let client = HostClient(baseURL: URL(string: "http://127.0.0.1:49761")!, transport: wire)
        let pairing = PairedHostOnboarding(journal: UnavailableClientClaimJournal(), storage: EphemeralPairedHostStateStorage(), identityStorage: { _ in LearningForbiddenIdentity() })
        let model = DexterAppModel(client: client, storage: LearningEphemeralStorage(), pairing: pairing)
        await model.refresh(); XCTAssertTrue(model.isOnline)
        let bot = try XCTUnwrap(model.bots.first), session = SettingsEditorSession(target: .bot(bot), model: model)
        let editor = MemoryLearningEditor(bot: bot, model: model, session: session)
        await editor.load(); XCTAssertNotNil(editor.status)
        XCTAssertEqual(editor.status?.extractor, .unconfigured)
        XCTAssertEqual(editor.status?.backend, .unavailable)
        let original = MemoryLearningCommand.policyUpdate(.init(expectedRevision: 0, enabled: true, maintenanceEnabled: false, dreamingEnabled: false))
        await editor.propose(command: original)
        XCTAssertEqual(editor.pendingAction?.state, .unknown)
        XCTAssertEqual(editor.pendingAction?.command, original)
        var posts = await wire.posts(); XCTAssertEqual(posts.count, 1)
        await editor.reconcileGETONLY()
        await editor.propose(command: .recordForget(.init(id: "other", expectedRevision: 1, policyRevision: 0, scopeEpoch: 0)))
        posts = await wire.posts(); XCTAssertEqual(posts.count, 1)
        XCTAssertEqual(editor.pendingAction?.command, original)
        let reads = await wire.originalReads(); XCTAssertGreaterThanOrEqual(reads.count, 2)
        XCTAssertEqual(Set(reads.map { $0.url!.lastPathComponent }).count, 1)
        await wire.reveal(); await editor.reconcile()
        XCTAssertEqual(editor.pendingAction?.state, .awaitingDecision)
        model.hostAddress = "http://127.0.0.1:49762"; model.configureHost()
        await editor.approveCurrent(); await editor.propose(command: original)
        posts = await wire.posts(); XCTAssertEqual(posts.count, 1)
        client.close(); model.closeThreadPresentation()
    }
}
@MainActor private final class LearningEphemeralStorage: DexterAppStateStorage {
    private var data: Data?
    func readData() -> Data? { data }; func writeData(_ value: Data) { data = value }; func removeData() { data = nil }
}
private actor LearningForbiddenIdentity: ClientIdentityStorage {
    func load(_ scope: ClientIdentityScope) async throws -> ClientNativeIdentity? { throw ClientIdentityFailure.forbidden }
    func provision(_ scope: ClientIdentityScope) async throws -> ClientNativeIdentity { throw ClientIdentityFailure.forbidden }
}
private actor SyntheticLearningWire: HTTPTransport {
    private var requests: [URLRequest] = [], command: JSONValue?, action: Action?, hidden = true
    private let host = "host_learning_sdk", owner = "owner_learning_sdk", bot = "bot_learning_sdk", profile = "profile_learning_sdk"
    func posts() -> [URLRequest] { requests.filter { $0.httpMethod == "POST" && $0.url!.path.hasSuffix("/memory-learning/proposals") } }
    func originalReads() -> [URLRequest] { requests.filter { $0.httpMethod == "GET" && $0.url!.path.contains("/memory-learning/requests/") } }
    func reveal() { hidden = false }
    private func response(_ value: Any) throws -> TransportResponse { .init(statusCode: 200, data: try JSONSerialization.data(withJSONObject: value)) }
    func send(_ request: URLRequest) async throws -> TransportResponse {
        requests.append(request); let path = request.url!.path, method = request.httpMethod ?? "GET"
        if path == "/health" { return try response(["protocolVersion": 1, "mode": "local-development", "engineRouting": "synthetic", "remotePairing": "not_implemented", "hostId": host, "state": ["hostId": host, "ownerId": owner]]) }
        if path == "/v1/bots" { return try response(["items": [["id": bot, "name": "Synthetic learning", "ownerId": owner, "profileId": profile, "engine": "codex", "revision": 0, "createdAt": 1]]]) }
        if path.hasSuffix("/configuration-session") { let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]; return try response(["sessionID": "00000000-0000-0000-0000-000000000001", "hostID": host, "ownerID": owner, "botID": bot, "profileID": profile, "botRevision": 0, "windowID": body["windowID"]!, "expiresAt": 9999999999999]) }
        if path.hasSuffix("/memory-learning/status") { return try response(["botId": bot, "policy": ["revision": 0, "scopeEpoch": 0, "enabled": false, "maintenanceEnabled": false, "dreamingEnabled": false, "minIdleMs": 120000, "maxJobsPerDay": 8, "maxProposalsPerJob": 4, "timezone": "America/Sao_Paulo", "nightHour": NSNull(), "botRevision": 0, "profileId": profile, "grantRevision": 0, "actionId": NSNull(), "updatedAt": 0], "effectiveEnabled": false, "mode": "propose", "extractor": "unconfigured", "backend": "unavailable", "purge": "durable_reconciliation", "history": "retained", "reason": "selected_driver_unavailable"]) }
        if path.hasSuffix("/memory-learning/proposals"), method == "POST" {
            let body = try JSONDecoder().decode(JSONValue.self, from: request.httpBody!)
            guard case .object(let fields) = body, let saved = fields["command"] else { throw HostClientError.invalidRequest }; command = saved
            action = Action(id: "action_learning_sdk", request: .init(botId: bot, threadId: "thread_learning_sdk", tool: "dexter.harness.memory.policy.update", destination: "dexter-harness-memory-learning", arguments: ["command": saved], idempotencyKey: "synthetic"), requestHash: String(repeating: "a", count: 64), grantRevision: 1, state: .awaitingApproval, createdAt: 1, updatedAt: 1, approvalExpiresAt: nil, decidedBy: nil, result: nil, reason: nil)
            throw URLError(.networkConnectionLost)
        }
        if path.contains("/memory-learning/requests/") { guard !hidden, let action, let command else { return try response(["action": NSNull(), "command": NSNull(), "clientRequestId": request.url!.lastPathComponent]) }; let a = try JSONSerialization.jsonObject(with: JSONEncoder().encode(action)), c = try JSONSerialization.jsonObject(with: JSONEncoder().encode(command)); return try response(["action": a, "command": c, "clientRequestId": request.url!.lastPathComponent]) }
        if path.contains("/memory-learning/receipts/"), let action { return try response(["action": try JSONSerialization.jsonObject(with: JSONEncoder().encode(action)), "receipt": NSNull()]) }
        return try response(["items": [], "nextCursor": 0])
    }
}
#endif
