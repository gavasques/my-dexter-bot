import Foundation
import CryptoKit
import XCTest
import DexterHostClient
@testable import DexterAppCore

private var g2AtomicDecisionPath: String {
    #if os(macOS)
    "/v1/actions/new-action/decision-preference"
    #else
    "/v1/actions/new-action/decisions"
    #endif
}

@MainActor final class G2R4CancellationRecoveryTests: XCTestCase {
    func testCancelThenNewSubmissionObservesNewProposalAndDurableAnswerWithNoOldDecision() async throws {
        let transport = G2R4Transport()
        await transport.queuedOldTurn()
        let model = try await model(transport)
        defer { model.closeThreadPresentation() }
        let old = try XCTUnwrap(model.actions.first)
        await model.cancelCurrentTurn(in: "thread-a")
        XCTAssertEqual(model.currentTurn?.state, .interrupted)
        await transport.failActionReads(true)
        await model.loadPresentedThread("thread-a", generation: model.threadPresentationGeneration)
        XCTAssertTrue(model.conversationObservationWasStopped, "A partial reload cannot clear cancelled action authority")
        await transport.failActionReads(false)
        let accepted = await model.submit("new synthetic request", expectedThreadID: "thread-a")
        XCTAssertTrue(accepted)
        XCTAssertFalse(model.conversationObservationWasStopped)
        await eventually { model.actions.contains { $0.id == "new-action" && $0.state == .awaitingApproval } }
        await model.decide(old, as: .allow) // A stale card cannot regain authority after a new send.
        let proposed = try XCTUnwrap(model.actions.first { $0.id == "new-action" })
        await model.decide(proposed, as: .allow)
        await eventually { model.messages.contains { $0.id == "new-answer" } && !model.isObservingConversation }
        XCTAssertEqual(model.currentTurn?.id, "new-response")
        let requests = await transport.recorded()
        XCTAssertEqual(requests.filter { $0.method == "POST" }.map(\.path),
            ["/v1/turns/old-turn/cancel", "/v1/threads/thread-a/turns", g2AtomicDecisionPath])
        XCTAssertEqual(requests.first { $0.path == "/v1/threads/thread-a/turns" && $0.method == "POST" }?.bodyKeys,
            ["clientRequestId", "content"])
        let effects = await transport.effectCount(); XCTAssertEqual(effects, 1)
    }

    func testHeldCancelACKCannotOverwriteOrStopNewSubmissionObserver() async throws {
        let transport = G2R4Transport(), model = try await model(transport)
        defer { model.closeThreadPresentation() }
        let identity = try XCTUnwrap(model.turnControlIdentity(in: "thread-a"))
        await transport.hold("/v1/turns/old-turn/cancel")
        let cancel = Task { await model.cancelTurn(identity) }
        await eventually { await transport.isHeld("/v1/turns/old-turn/cancel") }
        let accepted = await model.submit("new synthetic request", expectedThreadID: "thread-a")
        XCTAssertTrue(accepted)
        await eventually { model.currentTurn?.id == "new-turn" && model.currentTurn?.state == .completed }
        await transport.release("/v1/turns/old-turn/cancel"); await cancel.value
        XCTAssertEqual(model.currentTurn?.id, "new-turn")
        XCTAssertNil(model.turnControlNotice)
        XCTAssertFalse(model.conversationObservationWasStopped)
        await model.cancelTurn(identity)
        let requests = await transport.recorded()
        XCTAssertEqual(requests.filter { $0.path.hasSuffix("/cancel") && $0.method == "POST" }.count, 1)
        XCTAssertTrue(requests.contains { $0.path == "/v1/turns/new-turn/events" })
        let effects = await transport.effectCount(); XCTAssertEqual(effects, 0)
    }

    func testAcceptedSubmissionAndCancelCannotCrossConversationOrHostScope() async throws {
        for changeHost in [false, true] {
            let transport = G2R4Transport(), model = try await model(transport)
            await model.cancelCurrentTurn(in: "thread-a")
            await transport.hold("/v1/threads/thread-a/turns")
            let send = Task { await model.submit("new synthetic request", expectedThreadID: "thread-a") }
            await eventually { await transport.isHeld("/v1/threads/thread-a/turns") }
            if changeHost { model.hostAddress = "http://127.0.0.1:49987" }
            else {
                let next = try XCTUnwrap(model.presentThread("thread-b", for: "bot-a"))
                await model.loadPresentedThread("thread-b", generation: next)
            }
            await transport.release("/v1/threads/thread-a/turns"); _ = await send.value
            XCTAssertFalse(model.isObservingConversation)
            XCTAssertNotEqual(model.currentTurn?.id, "new-turn")
            XCTAssertFalse(model.actions(for: model.selectedThreadID ?? "").contains { $0.id == "new-action" })
            let requests = await transport.recorded()
            XCTAssertFalse(requests.contains { $0.path == "/v1/turns/new-turn/events" })
            XCTAssertEqual(requests.filter { $0.method == "POST" }.count, 2)
            model.closeThreadPresentation()
        }
    }

    func testRunningCancelACKUsesBoundedCanonicalReadsToShowTerminalWithoutMutationRetry() async throws {
        let transport = G2R4Transport()
        await transport.runningCancelACK()
        let model = try await model(transport)
        defer { model.closeThreadPresentation() }
        await model.cancelCurrentTurn(in: "thread-a")
        XCTAssertEqual(model.currentTurn?.state, .interrupted)
        XCTAssertEqual(model.actions.first?.state, .denied)
        XCTAssertTrue(model.turnControlNotice?.contains("confirmou a interrupção") == true)
        XCTAssertFalse(model.isObservingConversation)
        let requests = await transport.recorded()
        XCTAssertEqual(requests.filter { $0.method == "POST" }.map(\.path), ["/v1/turns/old-turn/cancel"])
        XCTAssertLessThanOrEqual(requests.filter { $0.path == "/v1/turns/old-turn" }.count, 4)
        let effects = await transport.effectCount(); XCTAssertEqual(effects, 0)
    }

    func testEffectStopCancelsCanonicalTerminalOriginOnceAndReadsUnknownSiblingReceipts() async throws {
        for state in ["ready", "running"] {
            let transport = G2R4Transport()
            await transport.executingEffects(state)
            let model = try await model(transport)
            let control = try XCTUnwrap(model.effectControlIdentity(for: try XCTUnwrap(model.actions.first)))
            XCTAssertNil(model.turnControlIdentity(in: "thread-a"), "Origin is already terminal")
            if state == "running" {
                let accepted = await model.submit("new synthetic request", expectedThreadID: "thread-a")
                XCTAssertTrue(accepted)
                await eventually { model.currentTurn?.id == "new-turn" && model.actions.contains { $0.id == "new-action" } }
            }
            await transport.hold("/v1/turns/old-turn/cancel")
            let stop = Task { await model.cancelEffects(control) }
            await eventually { await transport.isHeld("/v1/turns/old-turn/cancel") }
            await model.cancelEffects(control)
            await transport.release("/v1/turns/old-turn/cancel"); await stop.value
            XCTAssertEqual(model.currentTurn?.state, .completed, "A completed origin ACK is not interruption evidence")
            XCTAssertEqual(model.actions.filter { $0.state == .unknown }.count, 2)
            XCTAssertTrue(model.turnControlNotice?.contains("efeito pode ser parcial") == true)
            XCTAssertFalse(model.turnControlNotice?.contains("confirmou a interrupção") == true)
            let requests = await transport.recorded()
            XCTAssertEqual(requests.filter { $0.method == "POST" }.map(\.path), state == "running" ? ["/v1/threads/thread-a/turns", "/v1/turns/old-turn/cancel"] : ["/v1/turns/old-turn/cancel"])
            XCTAssertEqual(requests.first { $0.path.hasSuffix("/cancel") }?.bodyKeys, [])
            await model.cancelEffects(control)
            if state == "running" {
                XCTAssertFalse(model.conversationObservationWasStopped, "Stopping an old effect does not suspend the newer request")
                await model.decide(try XCTUnwrap(model.actions.first { $0.id == "new-action" }), as: .allow)
                await eventually { model.messages.contains { $0.id == "new-answer" } }
            }
            let effects = await transport.effectCount(); XCTAssertEqual(effects, state == "running" ? 1 : 0)
            model.closeThreadPresentation()
        }
    }

    func testEffectStopRejectsStaleScopeAndMissingCanonicalOriginWithoutPOST() async throws {
        for missingOrigin in [false, true] {
            let transport = G2R4Transport()
            await transport.executingEffects("running")
            let model = try await model(transport)
            let control = try XCTUnwrap(model.effectControlIdentity(for: try XCTUnwrap(model.actions.first)))
            model.stopPolling()
            if missingOrigin { await transport.removeOrigin() }
            else { await transport.changeHostIdentity() }
            await model.cancelEffects(control)
            let requests = await transport.recorded()
            XCTAssertTrue(requests.allSatisfy { $0.method == "GET" })
            XCTAssertTrue(model.turnControlNotice?.contains("não foi") == true)
            model.hostAddress = "http://127.0.0.1:49987"
            await model.cancelEffects(control)
            let afterStale = await transport.recorded().count; XCTAssertEqual(afterStale, requests.count)
            model.closeThreadPresentation()
        }
    }

    func testAtomicDecisionDenialAcceptsExactReceiptWithoutEffectOrContinuation() async throws {
        let transport = G2R4Transport(), model = try await model(transport)
        defer { model.closeThreadPresentation() }
        await model.cancelCurrentTurn(in: "thread-a")
        let accepted = await model.submit("new synthetic request", expectedThreadID: "thread-a")
        XCTAssertTrue(accepted)
        await eventually { model.actions.contains { $0.id == "new-action" } }
        let action = try XCTUnwrap(model.actions.first { $0.id == "new-action" })
        await model.decide(action, as: .deny)
        XCTAssertNil(model.errorMessage)
        XCTAssertEqual(model.actions.first { $0.id == "new-action" }?.state, .denied)
        let effects = await transport.effectCount(); XCTAssertEqual(effects, 0)
        let requests = await transport.recorded()
        XCTAssertEqual(requests.filter { $0.path == g2AtomicDecisionPath && $0.method == "POST" }.count, 1)
        XCTAssertFalse(requests.contains { $0.path.contains("dispatch") || $0.path.contains("grants") })
        XCTAssertFalse(model.messages.contains { $0.id == "new-answer" })
    }

    private func model(_ transport: G2R4Transport) async throws -> DexterAppModel {
        let model = DexterAppModel(client: HostClient(baseURL: URL(string: "http://127.0.0.1:49986")!, transport: transport), storage: G2R4Storage())
        model.continuationObservationInterval = .milliseconds(15)
        model.cancelReconciliationInterval = .milliseconds(10)
        model.cancelReconciliationAttempts = 4
        model.conversationObservationLifetime = .seconds(4)
        await model.refresh()
        XCTAssertTrue(model.isOnline)
        let generation = try XCTUnwrap(model.presentThread("thread-a", for: "bot-a"))
        await model.loadPresentedThread("thread-a", generation: generation)
        model.stopPolling() // The scenario starts from canonical state, without an unrelated old read race.
        return model
    }
    private func eventually(file: StaticString = #filePath, line: UInt = #line, _ check: @MainActor () async -> Bool) async {
        for _ in 0..<250 {
            if await check() { return }
            try? await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("Expected canonical state did not arrive", file: file, line: line)
    }
}

@MainActor private final class G2R4Storage: DexterAppStateStorage {
    private var bytes: Data? = try? JSONEncoder().encode(DexterPersistedAppState(version: 1, mode: .loopback,
        loopbackAddress: "http://127.0.0.1:49986", pendingRequests: []))
    func readData() -> Data? { bytes }
    func readState() -> DexterStoredState { bytes.map(DexterStoredState.data) ?? .missing }
    func writeData(_ data: Data) { bytes = data }
    func removeData() { bytes = nil }
}

private actor G2R4Transport: HTTPTransport {
    struct Request: Sendable { let method: String; let path: String; let bodyKeys: [String] }
    private var requests: [Request] = []
    private var oldState = "running", actionState = "awaiting_approval", newState: String?
    private var newRequestID = "", newActionState = "awaiting_approval", response = false
    private var heldPaths: Set<String> = [], held: [String: CheckedContinuation<Void, Never>] = [:]
    private var runningACK = false, cancellationReads = 0, cancelled = false, effects = 0, siblings = false
    private var hasOrigin = true, hostID = "g2-r4-synthetic-host"
    private var failingActionReads = false
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
        case "/v1/actions/new-action": value = action("new-action", state: newActionState)
        case "/v1/actions/old-action/continuation", "/v1/actions/sibling-action/continuation": value = ["continuation": hasOrigin ? progress(origin: "old-turn") : NSNull()]
        case "/v1/actions/new-action/continuation": value = ["continuation": progress(origin: "new-turn", responseID: response ? "new-response" : nil)]
        case g2AtomicDecisionPath:
            guard method == "POST", let input, let decision = input["decision"] as? String,
                  ["allow", "deny"].contains(decision), input["requestHash"] as? String == hash("new-action") else { throw HostClientError.invalidRequest }
            #if os(macOS)
            guard Set(input.keys) == ["expectedHostId", "clientRequestId", "requestHash", "decision", "alwaysAccept", "expectedTypeKey", "expectedPreferenceRevision"],
                  input["expectedHostId"] as? String == hostID,
                  let requestID = input["clientRequestId"] as? String, UUID(uuidString: requestID) != nil,
                  input["alwaysAccept"] as? Bool == false, input["expectedTypeKey"] is NSNull,
                  input["expectedPreferenceRevision"] as? Int == 0, newActionState == "awaiting_approval" else { throw HostClientError.conflict }
            let receiptInput = try JSONDecoder().decode(JSONValue.self, from: request.httpBody!)
            let identity: JSONValue = .object(["hostId": .string(hostID), "ownerId": .string("owner-a"), "botId": .string("bot-a"),
                "kind": .string("decision"), "targetId": .string("new-action"), "input": receiptInput])
            let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
            let inputHash = SHA256.hash(data: try encoder.encode(identity)).map { String(format: "%02x", $0) }.joined()
            if decision == "allow" { effects += 1; newActionState = "succeeded"; response = true }
            else { newActionState = "denied" }
            value = ["action": action("new-action", state: newActionState), "receipt": ["id": "arp-g2-" + requestID,
                "clientRequestId": requestID, "inputHash": inputHash, "hostId": hostID, "ownerId": "owner-a", "botId": "bot-a",
                "kind": "decision", "targetId": "new-action", "input": input, "previous": NSNull(),
                "state": ["actionId": "new-action", "requestHash": hash("new-action"), "decision": decision, "preference": NSNull()],
                "createdAt": 2, "revocationEffects": ["blockedActionIds": [], "abortedActionIds": []]]]
            #else
            guard Set(input.keys) == ["decision", "requestHash"], newActionState == "awaiting_approval" else { throw HostClientError.conflict }
            if decision == "allow" { effects += 1; newActionState = "succeeded"; response = true }
            else { newActionState = "denied" }
            value = action("new-action", state: newActionState)
            #endif
        case "/v1/threads/thread-a/turns":
            if method == "POST" {
                newRequestID = input?["clientRequestId"] as? String ?? "invalid"; newState = "completed"
                value = turn("new-turn", state: "queued", cursor: 2)
            } else { value = ["items": [turn("old-turn", state: oldState, cursor: 1)] + (newState.map { [turn("new-turn", state: $0, cursor: 2)] } ?? []) + (response ? [turn("new-response", state: "completed", cursor: 3)] : []), "nextCursor": response ? 3 : newState != nil ? 2 : 1] }
        case "/v1/threads/thread-a/messages": value = ["items": [message("old-input", role: "user", cursor: 1)] + (newState != nil ? [message("new-input", role: "user", cursor: 2)] : []) + (response ? [message("new-answer", role: "assistant", cursor: 3)] : []), "nextCursor": response ? 3 : newState != nil ? 2 : 1]
        case "/v1/turns/old-turn":
            if cancelled && runningACK { cancellationReads += 1; if cancellationReads >= 2 { oldState = "interrupted" } }
            value = turn("old-turn", state: oldState, cursor: 1)
        case "/v1/turns/new-turn": value = turn("new-turn", state: newState ?? "queued", cursor: 2)
        case "/v1/turns/new-response": value = turn("new-response", state: "completed", cursor: 3)
        case "/v1/turns/old-turn/cancel":
            guard method == "POST", input?.isEmpty == true else { throw HostClientError.invalidRequest }
            cancelled = true; actionState = siblings ? "unknown" : "denied"
            if oldState != "completed" && !runningACK { oldState = "interrupted" }
            value = turn("old-turn", state: oldState, cursor: 1)
        case "/v1/turns/new-turn/events":
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
        ["id": id, "request": ["botId": "bot-a", "threadId": "thread-a", "tool": "dexter.harness.terminal.run", "destination": "bot-workspace", "arguments": ["input": ["command": "synthetic only"]], "idempotencyKey": id], "requestHash": hash(id), "grantRevision": 1, "state": state, "createdAt": 1, "updatedAt": state == "awaiting_approval" ? 1 : 2, "approvalExpiresAt": expiresAt, "decidedBy": state == "ready" || state == "running" ? "owner-a" : NSNull(), "result": state == "unknown" ? ["commandOutcome": "interrupted", "termination": "cancelled", "signal": "SIGTERM"] : NSNull()]
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
