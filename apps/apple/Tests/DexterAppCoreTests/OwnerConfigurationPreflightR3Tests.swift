#if os(macOS)
import DexterClientIdentity
import DexterHostClient
import Foundation
import XCTest
@testable import DexterAppCore

/// Only owned in-memory transports and ephemeral model storage. No server, socket, account or GUI.
@MainActor final class OwnerConfigurationPreflightR3Tests: XCTestCase {
    private func fixture(_ wire: OwnerPreflightR3Transport, port: Int) async throws -> (DexterAppModel, HostClient, OwnerConfigurationEditor) {
        let client = HostClient(baseURL: URL(string: "http://127.0.0.1:\(port)")!, transport: wire)
        let pairing = PairedHostOnboarding(journal: UnavailableClientClaimJournal(), storage: EphemeralPairedHostStateStorage(),
            identityStorage: { _ in OwnerPreflightR3ForbiddenIdentity() })
        let model = DexterAppModel(client: client, storage: OwnerPreflightR3Storage(), pairing: pairing)
        await model.refresh(); XCTAssertTrue(model.isOnline)
        let editor = OwnerConfigurationEditor(bot: try XCTUnwrap(model.bots.first), model: model)
        await editor.open(); XCTAssertNotNil(editor.hostSession)
        return (model, client, editor)
    }
    private func proposal(_ id: String, enabled: Bool = true) throws -> OwnerConfigurationProposal {
        try OwnerConfigurationProposal(memoryPolicy: .init(expectedRevision: 0, enabled: enabled, maintenanceEnabled: false), requestID: id)
    }
    private func held(_ wire: OwnerPreflightR3Transport) async throws {
        for _ in 0..<150 { if await wire.isHeld() { return }; try await Task.sleep(for: .milliseconds(2)) }
        XCTFail("Synthetic health did not reach its pre-dispatch hold")
    }
    func testHealthFailureAndPreDispatchCancellationKeepPreparedEditableWithZeroPOSTThenNewIntentSendsOnceAndStaleCallbackRetires() async throws {
        let wire = OwnerPreflightR3Transport(), (model, client, editor) = try await fixture(wire, port: 49971)
        let first = try proposal("owner-r3-first"); try editor.prepare(first)
        await wire.failNextHealth(); await editor.submit()
        XCTAssertEqual(editor.state, .prepared); XCTAssertFalse(editor.mutationSent); XCTAssertFalse(editor.requiresReconciliation)
        XCTAssertEqual(editor.original, first); XCTAssertEqual(editor.lastError, .offline)
        var posts = await wire.proposalPosts(); XCTAssertEqual(posts.count, 0)
        var reads = await wire.receiptReads(); XCTAssertEqual(reads.count, 0)
        try editor.discardPrepared(); XCTAssertNil(editor.original); XCTAssertEqual(editor.state, .idle)

        let cancelled = try proposal("owner-r3-cancel", enabled: false); try editor.prepare(cancelled)
        await wire.holdNextHealth(); let task = Task { await editor.submit() }; try await held(wire)
        XCTAssertTrue(editor.busy); XCTAssertFalse(editor.mutationSent)
        XCTAssertThrowsError(try editor.discardPrepared())
        task.cancel(); await wire.release(); await task.value
        XCTAssertEqual(editor.state, .prepared); XCTAssertFalse(editor.mutationSent); XCTAssertFalse(editor.busy)
        XCTAssertEqual(editor.original, cancelled); XCTAssertNil(editor.lastError)
        posts = await wire.proposalPosts(); reads = await wire.receiptReads(); XCTAssertEqual(posts.count, 0); XCTAssertEqual(reads.count, 0)
        try editor.discardPrepared()

        let edited = try proposal("owner-r3-edited"); try editor.prepare(edited); await wire.expect(edited)
        await editor.submit(); XCTAssertEqual(editor.state, .awaitingApproval); XCTAssertTrue(editor.mutationSent)
        XCTAssertEqual(editor.original, edited); posts = await wire.proposalPosts(); XCTAssertEqual(posts.count, 1)
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: posts[0]), edited.body)
        XCTAssertThrowsError(try editor.discardPrepared()); await editor.submit()
        posts = await wire.proposalPosts(); XCTAssertEqual(posts.count, 1, "Reentry only reads the original receipt")
        client.close(); model.closeThreadPresentation()

        let staleWire = OwnerPreflightR3Transport(), (staleModel, staleClient, staleEditor) = try await fixture(staleWire, port: 49972)
        let staleOriginal = try proposal("owner-r3-stale"); try staleEditor.prepare(staleOriginal)
        await staleWire.holdNextHealth(); let staleTask = Task { await staleEditor.submit() }; try await held(staleWire)
        staleModel.hostAddress = "http://127.0.0.1:49973"; staleModel.configureHost()
        await staleWire.release(); await staleTask.value
        XCTAssertTrue(staleEditor.invalidated); XCTAssertEqual(staleEditor.state, .invalidated); XCTAssertFalse(staleEditor.mutationSent)
        XCTAssertEqual(staleEditor.original, staleOriginal)
        let stalePosts = await staleWire.proposalPosts(), staleReads = await staleWire.receiptReads()
        XCTAssertEqual(stalePosts.count, 0); XCTAssertEqual(staleReads.count, 0)
        staleClient.close(); staleModel.closeThreadPresentation()
    }

    func testLostPOSTAcknowledgementKeepsOriginalUnknownAndReconcilesOnlyGETWithoutResend() async throws {
        let wire = OwnerPreflightR3Transport(), (model, client, editor) = try await fixture(wire, port: 49974)
        let original = try proposal("owner-r3-ack-lost"); try editor.prepare(original)
        await wire.expect(original); await wire.loseNextAcknowledgement(); await editor.submit()
        XCTAssertTrue(editor.mutationSent); XCTAssertEqual(editor.state, .unknown); XCTAssertTrue(editor.requiresReconciliation)
        XCTAssertEqual(editor.original, original); XCTAssertEqual(editor.lastError, .mutationOutcomeUnknown)
        var posts = await wire.proposalPosts(), reads = await wire.receiptReads()
        XCTAssertEqual(posts.count, 1); XCTAssertEqual(reads.count, 1)
        XCTAssertThrowsError(try editor.discardPrepared()); XCTAssertThrowsError(try editor.prepare(proposal("owner-r3-cannot-replace")))
        await editor.submit(); await editor.reconcile()
        posts = await wire.proposalPosts(); reads = await wire.receiptReads(); XCTAssertEqual(posts.count, 1); XCTAssertEqual(reads.count, 3)
        XCTAssertTrue(reads.allSatisfy { $0.hasSuffix("/requests/" + original.requestID) })
        await wire.revealReceipt(); await editor.reconcile()
        XCTAssertEqual(editor.state, .awaitingApproval); XCTAssertEqual(editor.action?.request.tool, "dexter.memory.policy.update")
        XCTAssertEqual(editor.original, original); XCTAssertTrue(editor.mutationSent)
        posts = await wire.proposalPosts(); reads = await wire.receiptReads(); XCTAssertEqual(posts.count, 1); XCTAssertEqual(reads.count, 4)
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: posts[0]), original.body)
        client.close(); model.closeThreadPresentation()
    }
}

@MainActor private final class OwnerPreflightR3Storage: DexterAppStateStorage {
    private var data: Data?
    func readData() -> Data? { data }
    func writeData(_ value: Data) { data = value }
    func removeData() { data = nil }
}
private actor OwnerPreflightR3ForbiddenIdentity: ClientIdentityStorage {
    func load(_ scope: ClientIdentityScope) async throws -> ClientNativeIdentity? { throw ClientIdentityFailure.forbidden }
    func provision(_ scope: ClientIdentityScope) async throws -> ClientNativeIdentity { throw ClientIdentityFailure.forbidden }
}
private actor OwnerPreflightR3Transport: HTTPTransport {
    private let hostID = "host-owner-r3", ownerID = "owner-r3", botID = "bot-owner-r3", profileID = "profile-owner-r3"
    private var calls: [String] = [], posts: [Data] = []
    private var sessionID = UUID().uuidString.lowercased(), windowID = ""
    private var expected: OwnerConfigurationProposal?
    private var action: Action?
    private var failHealth = false, holdHealth = false, loseACK = false, hidden = false
    private var heldResponse: CheckedContinuation<Void, Never>?
    func expect(_ proposal: OwnerConfigurationProposal) { expected = proposal }
    func proposalPosts() -> [Data] { posts }
    func receiptReads() -> [String] { calls.filter { $0.hasPrefix("GET ") && $0.contains("/requests/") } }
    func failNextHealth() { failHealth = true }
    func holdNextHealth() { holdHealth = true }
    func isHeld() -> Bool { heldResponse != nil }
    func release() { heldResponse?.resume(); heldResponse = nil }
    func loseNextAcknowledgement() { loseACK = true; hidden = true }
    func revealReceipt() { hidden = false }
    func send(_ request: URLRequest) async throws -> TransportResponse {
        let path = request.url!.path, method = request.httpMethod ?? "GET"; calls.append(method + " " + path)
        switch path {
        case "/health":
            if failHealth { failHealth = false; throw URLError(.networkConnectionLost) }
            let data = try encode(["protocolVersion": 1, "mode": "local-development", "engineRouting": "synthetic", "remotePairing": "not_implemented", "hostId": hostID, "state": ["hostId": hostID, "ownerId": ownerID]])
            if holdHealth { holdHealth = false; await withCheckedContinuation { heldResponse = $0 } }
            return .init(statusCode: 200, data: data)
        case "/v1/bots": return .init(statusCode: 200, data: try encode(["items": [["id": botID, "name": "Synthetic owner R3", "profileId": profileID, "ownerId": ownerID, "engine": "claude", "revision": 0, "createdAt": 1]]]))
        case "/v1/actions", "/v1/events", "/v1/teams", "/v1/live-voice/settings": return .init(statusCode: 200, data: try encode(["items": [], "nextCursor": 0]))
        case "/v1/bots/bot-owner-r3/configuration-session":
            let input = try JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as! [String: Any]
            windowID = try XCTUnwrap(input["windowID"] as? String)
            return .init(statusCode: 200, data: try encode(["sessionID": sessionID, "hostID": hostID, "ownerID": ownerID, "botID": botID, "profileID": profileID, "botRevision": 0, "windowID": windowID, "expiresAt": 9999999999999]))
        default:
            if method == "POST", path.hasSuffix("/memory/policy/proposals") {
                let body = try XCTUnwrap(request.httpBody); posts.append(body)
                let proposal = try XCTUnwrap(expected)
                guard try JSONDecoder().decode(JSONValue.self, from: body) == proposal.body else { throw HostClientError.contractMismatch }
                let request = ActionRequest(botId: botID, threadId: "thread-owner-r3", tool: "dexter.memory.policy.update", destination: "dexter-memory-routines", arguments: ["input": proposal.input], idempotencyKey: proposal.requestID)
                action = Action(id: "action-owner-r3", request: request, requestHash: String(repeating: "a", count: 64), grantRevision: 1,
                    state: .awaitingApproval, createdAt: 1, updatedAt: 1, approvalExpiresAt: nil, decidedBy: nil, result: nil, reason: nil)
                if loseACK { loseACK = false; throw URLError(.networkConnectionLost) }
                return .init(statusCode: 200, data: try JSONEncoder().encode(action!))
            }
            guard method == "GET", path.contains("/requests/") else { throw HostClientError.notFound }
            guard !hidden, let action, let proposal = expected else { return .init(statusCode: 200, data: try encode(["action": NSNull(), "intent": NSNull()])) }
            let actionObject = try JSONSerialization.jsonObject(with: JSONEncoder().encode(action))
            return .init(statusCode: 200, data: try encode(["action": actionObject, "intent": ["kind": "owner_settings_proposal_v1", "ownerId": ownerID, "windowId": windowID,
                "clientRequestId": proposal.requestID, "operation": proposal.operation.rawValue, "bodyHash": proposal.bodyHash]]))
        }
    }
    private func encode(_ value: [String: Any]) throws -> Data { try JSONSerialization.data(withJSONObject: value) }
}
#endif
