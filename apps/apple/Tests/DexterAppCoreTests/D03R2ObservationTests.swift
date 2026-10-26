#if os(macOS)
import DexterHostClient
import Foundation
import XCTest
@testable import DexterAppCore

@MainActor final class D03R2ObservationTests: XCTestCase {
    func testFastPolicyActionArrivesBeforeObserverEndsWithoutManualReloadOrDecision() async throws {
        let transport = D03R2Transport(), model = try await makeModel(transport)
        defer { model.closeThreadPresentation() }
        await transport.fastReceipt()
        let accepted = await model.submit("fast synthetic request", expectedThreadID: "thread-a")
        XCTAssertTrue(accepted)
        await eventually { !model.isObservingConversation && model.currentTurn?.id == "new-turn" }
        let action = try XCTUnwrap(model.actions.first { $0.id == "new-action" })
        XCTAssertEqual(action.state, .succeeded)
        XCTAssertEqual(action.authorization?.source, .ownerPolicy)
        XCTAssertEqual(action.authorization?.policyRevision, 1)
        XCTAssertEqual(action.authorization?.policyReceiptId, "receipt-fast")
        let requests = await transport.recorded()
        XCTAssertEqual(requests.filter { $0.path == "/v1/actions/new-action" }.count, 2) // one final pass plus existing continuation confirmation
        let read = try XCTUnwrap(requests.firstIndex { $0.path == "/v1/actions/new-action" })
        let continuation = try XCTUnwrap(requests.firstIndex { $0.path == "/v1/actions/new-action/continuation" })
        XCTAssertLessThan(read, continuation)
        XCTAssertEqual(requests.filter { $0.method == "POST" }.map(\.path), ["/v1/threads/thread-a/turns"])
        XCTAssertFalse(requests.contains { $0.path == "/v1/turns/new-response/events" })
    }
    func testFinalReadErrorDoesNotInventActionOrRetryEffectOrDecision() async throws {
        let transport = D03R2Transport(), model = try await makeModel(transport)
        defer { model.closeThreadPresentation() }
        await transport.fastReceipt(true)
        let accepted = await model.submit("fast synthetic request", expectedThreadID: "thread-a")
        XCTAssertTrue(accepted)
        await eventually { !model.isObservingConversation && model.currentTurn?.id == "new-turn" }
        XCTAssertFalse(model.actions.contains { $0.id == "new-action" })
        XCTAssertNotNil(model.errorMessage)
        let requests = await transport.recorded()
        XCTAssertEqual(requests.filter { $0.path == "/v1/actions/new-action" }.count, 1)
        XCTAssertEqual(requests.filter { $0.method == "POST" }.count, 1)
    }
    private func makeModel(_ transport: D03R2Transport) async throws -> DexterAppModel {
        let model = DexterAppModel(client: HostClient(baseURL: URL(string:"http://127.0.0.1:49986")!,transport:transport),storage:D03R2Storage())
        model.conversationObservationLifetime = .seconds(4)
        model.continuationObservationInterval = .milliseconds(10)
        await model.refresh()
        let generation = try XCTUnwrap(model.presentThread("thread-a",for:"bot-a"))
        await model.loadPresentedThread("thread-a",generation:generation)
        model.stopPolling()
        return model
    }
    private func eventually(_ check: @MainActor () async -> Bool) async {
        for _ in 0..<300 { if await check() { return }; try? await Task.sleep(for:.milliseconds(10)) }
        XCTFail("Bounded observer did not finish")
    }
}
@MainActor private final class D03R2Storage: DexterAppStateStorage {
    private var bytes: Data? = try? JSONEncoder().encode(DexterPersistedAppState(version: 1, mode: .loopback,
        loopbackAddress: "http://127.0.0.1:49986", pendingRequests: []))
    func readData() -> Data? { bytes }
    func readState() -> DexterStoredState { bytes.map(DexterStoredState.data) ?? .missing }
    func writeData(_ data: Data) { bytes = data }
    func removeData() { bytes = nil }
}

private actor D03R2Transport: HTTPTransport {
    struct Request: Sendable { let method: String; let path: String; let bodyKeys: [String] }
    private var requests: [Request] = []
    private var oldState = "running", actionState = "awaiting_approval", newState: String?
    private var newRequestID = "", newActionState = "awaiting_approval", response = false
    private var heldPaths: Set<String> = [], held: [String: CheckedContinuation<Void, Never>] = [:]
    private var runningACK = false, cancellationReads = 0, cancelled = false, effects = 0, siblings = false
    private var hasOrigin = true, hostID = "g2-r4-synthetic-host"
    private var failingActionReads = false, eventReads = 0, fastComplete = false
    func fastReceipt(_ failReads: Bool = false) { fastComplete = true; failingActionReads = failReads; oldState = "completed"; actionState = "succeeded" }
    private let expiresAt = Int64(Date().timeIntervalSince1970 * 1000) + 60_000
    func recorded() -> [Request] { requests }
    func effectCount() -> Int { effects }
    func runningCancelACK() { runningACK = true }
    func queuedOldTurn() { oldState = "queued" }
    func executingEffects(_ state: String) { oldState = "completed"; actionState = state; siblings = true }
    func removeOrigin() { hasOrigin = false }
    func changeHostIdentity() { hostID = "different-g2-r4-host" }
    func failActionReads(_ value: Bool) { failingActionReads = value }
    func hold(_ path: String) { heldPaths.insert(path) }
    func isHeld(_ path: String) -> Bool { held[path] != nil }
    func release(_ path: String) { heldPaths.remove(path); held.removeValue(forKey: path)?.resume() }
    func send(_ request: URLRequest) async throws -> TransportResponse {
        let path = request.url!.path, method = request.httpMethod ?? "GET"
        let input = try request.httpBody.map { try JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? nil
        requests.append(Request(method: method, path: path, bodyKeys: input?.keys.sorted() ?? []))
        let value: [String: Any]
        switch path {
        case "/health": value = ["protocolVersion": 1, "mode": "local-development", "engineRouting": "synthetic", "remotePairing": "not_implemented", "hostId": hostID, "state": [:]]
        case "/v1/bots": value = ["items": [["id": "bot-a", "name": "Synthetic", "profileId": "profile-a", "engine": "claude", "ownerId": "owner-a", "createdAt": 1]]]
        case "/v1/bots/bot-a/threads": value = ["items": ["thread-a", "thread-b"].map { ["id": $0, "botId": "bot-a", "createdAt": 1] }]
        case "/v1/events": value = ["items": ["thread-a", "thread-b"].enumerated().map { index, id in
            ["id": "event-\(id)", "cursor": index + 1, "kind": "thread.created", "botId": "bot-a", "entityId": id, "createdAt": 1] as [String: Any]
        }, "nextCursor": 2]
        case "/v1/threads/thread-a", "/v1/threads/thread-b": value = ["id": path.hasSuffix("thread-a") ? "thread-a" : "thread-b", "botId": "bot-a", "createdAt": 1]
        case "/v1/teams", "/v1/live-voice/settings", "/v1/threads/thread-b/turns", "/v1/threads/thread-b/messages": value = ["items": [], "nextCursor": 0]
        case "/v1/actions":
            if failingActionReads { throw HostClientError.offline }
            value = ["items": [action("old-action", state: actionState)] + (siblings ? [action("sibling-action", state: actionState)] : []) + (newState != nil ? [action("new-action", state: newActionState)] : [])]
        case "/v1/actions/old-action", "/v1/actions/sibling-action": value = action(path.hasSuffix("old-action") ? "old-action" : "sibling-action", state: actionState)
        case "/v1/actions/new-action":
            if failingActionReads { throw HostClientError.offline }
            value = action("new-action", state: fastComplete ? "succeeded" : newActionState)
        case "/v1/actions/old-action/continuation", "/v1/actions/sibling-action/continuation": value = ["continuation": hasOrigin ? (fastComplete ? ["originTurnId":"old-turn","originValid":true,"deliveredToEngine":true,"consumedByEngine":true,"responseTurnId":NSNull(),"responseState":NSNull(),"resultBodyAvailable":true] : progress(origin:"old-turn")) : NSNull()]
        case "/v1/actions/new-action/continuation": value = ["continuation": fastComplete ? ["originTurnId":"new-turn", "originValid":true,"deliveredToEngine":true,"consumedByEngine":true,"responseTurnId":NSNull(),"responseState":NSNull(),"resultBodyAvailable":true] : progress(origin: "new-turn", responseID: response ? "new-response" : nil)]
        case "/v1/actions/new-action/decisions":
            guard method == "POST", input?["decision"] as? String == "allow", input?["requestHash"] as? String == hash("new-action") else { throw HostClientError.invalidRequest }
            if newActionState == "awaiting_approval" { effects += 1 }
            newActionState = "succeeded"; response = true; value = action("new-action", state: newActionState)
        case "/v1/threads/thread-a/turns":
            if method == "POST" {
                newRequestID = input?["clientRequestId"] as? String ?? "invalid"; newState = "completed"
                value = turn("new-turn", state: "queued", cursor: 2)
            } else { value = ["items": [turn("old-turn", state: oldState, cursor: 1)] + (newState.map { [turn("new-turn", state: $0, cursor: 2)] } ?? []) + (response ? [turn("new-response", state: "completed", cursor: 3)] : []), "nextCursor": response ? 3 : newState != nil ? 2 : 1] }
        case "/v1/threads/thread-a/messages": value = ["items": [message("old-input", role: "user", cursor: 1)] + (newState != nil ? [message("new-input", role: "user", cursor: 2)] : []) + (response ? [message("new-answer", role: "assistant", cursor: 3)] : []), "nextCursor": response ? 3 : newState != nil ? 2 : 1]
        case "/v1/turns/old-turn":
            if cancelled && runningACK { cancellationReads += 1; if cancellationReads >= 2 { oldState = "interrupted" } }
            value = turn("old-turn", state: oldState, cursor: 1)
        case "/v1/turns/new-turn": value = turn("new-turn", state: fastComplete && eventReads < 2 ? "running" : newState ?? "queued", cursor: 2)
        case "/v1/turns/new-response": value = turn("new-response", state: "completed", cursor: 3)
        case "/v1/turns/old-turn/cancel":
            guard method == "POST", input?.isEmpty == true else { throw HostClientError.invalidRequest }
            cancelled = true; actionState = siblings ? "unknown" : "denied"
            if oldState != "completed" && !runningACK { oldState = "interrupted" }
            value = turn("old-turn", state: oldState, cursor: 1)
        case "/v1/turns/new-turn/events":
            eventReads += 1
            if fastComplete && eventReads == 1 { return TransportResponse(statusCode: 200, data: Data(#"{"items":[],"nextCursor":0}"#.utf8)) }
            let after = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "after" }?.value
            value = ["items": after == "0" ? [["cursor": 1, "turnId": "new-turn", "threadId": "thread-a", "kind": "tool.requested", "data": ["actionId": "new-action"], "createdAt": 2]] : [], "nextCursor": 1]
        case "/v1/turns/old-turn/events", "/v1/turns/new-response/events": value = ["items": [], "nextCursor": 0]
        default: throw HostClientError.notFound
        }
        let data = try JSONSerialization.data(withJSONObject: value)
        if heldPaths.contains(path) { await withCheckedContinuation { held[path] = $0 } }
        return TransportResponse(statusCode: 200, data: data)
    }
    private func hash(_ id: String) -> String { String(repeating: id == "new-action" ? "b" : "a", count: 64) }
    private func action(_ id: String, state: String) -> [String: Any] {
        var value: [String: Any] = ["id": id, "request": ["botId": "bot-a", "threadId": "thread-a", "tool": "dexter.harness.terminal.run", "destination": "bot-workspace", "arguments": ["input": ["command": "synthetic only"]], "idempotencyKey": id], "requestHash": hash(id), "grantRevision": 1, "state": state, "createdAt": 1, "updatedAt": state == "awaiting_approval" ? 1 : 2, "approvalExpiresAt": expiresAt, "decidedBy": state == "ready" || state == "running" ? "owner-a" : NSNull(), "result": state == "unknown" ? ["commandOutcome": "interrupted", "termination": "cancelled", "signal": "SIGTERM"] : NSNull()]
        if fastComplete && id == "new-action" {
            value["authorization"] = ["source":"owner_policy","ownerId":"owner-a","policyRevision":1,"policyReceiptId":"receipt-fast","eligibleScopeVersion":"d03.execution.v1"]
        }
        return value
    }
    private func progress(origin: String, responseID: String? = nil) -> [String: Any] {
        ["originTurnId": origin, "originValid": true, "deliveredToEngine": responseID != nil, "responseTurnId": responseID as Any? ?? NSNull(), "responseState": responseID != nil ? "completed" : NSNull(), "resultBodyAvailable": responseID != nil]
    }
    private func turn(_ id: String, state: String, cursor: Int) -> [String: Any] {
        ["id": id, "cursor": cursor, "threadId": "thread-a", "botId": "bot-a", "engine": "claude", "clientRequestId": id == "old-turn" ? "old-request" : id == "new-turn" ? newRequestID : "host-response", "inputMessageId": id == "old-turn" ? "old-input" : "new-input", "outputMessageId": id == "new-response" ? "new-answer" : NSNull(), "state": state, "outputChars": 0, "outputTruncated": false, "createdAt": cursor, "updatedAt": state == "completed" || state == "interrupted" ? 3 : 2]
    }
    private func message(_ id: String, role: String, cursor: Int) -> [String: Any] {
        ["id": id, "cursor": cursor, "threadId": "thread-a", "clientMessageId": id, "role": role, "content": id == "new-answer" ? "synthetic durable answer" : id == "new-input" ? "new synthetic request" : "old synthetic request", "createdAt": cursor]
    }
}

#endif
