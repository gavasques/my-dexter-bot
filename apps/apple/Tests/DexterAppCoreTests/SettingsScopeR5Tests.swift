#if os(macOS)
import CryptoKit
import DexterClientIdentity
import DexterHostClient
import Foundation
import XCTest
@testable import DexterAppCore

@MainActor final class SettingsScopeR5Tests: XCTestCase {
    private func model(_ wire: SettingsR5Transport, port: Int) async throws -> DexterAppModel {
        let pairing = PairedHostOnboarding(journal: UnavailableClientClaimJournal(), storage: EphemeralPairedHostStateStorage(),
            identityStorage: { _ in R5ForbiddenIdentityStorage() })
        let model = DexterAppModel(client: HostClient(baseURL: URL(string: "http://127.0.0.1:\(port)")!, transport: wire),
            storage: SettingsR5Storage(), pairing: pairing)
        await model.refresh(); XCTAssertTrue(model.isOnline); return model
    }
    func testRetainedWindowAndReconstructedSubeditorsRejectOtherBaseWithIdenticalIDsAndRevisions() async throws {
        let a = SettingsR5Transport(), b = SettingsR5Transport()
        let modelA = try await model(a, port: 49751), modelB = try await model(b, port: 49752)
        let bot = try XCTUnwrap(modelA.bots.first), team = try XCTUnwrap(modelA.teams.first)
        XCTAssertEqual(modelA.bots, modelB.bots); XCTAssertEqual(modelA.teams, modelB.teams)
        XCTAssertEqual(modelA.approvalPolicyHostID, modelB.approvalPolicyHostID)
        let session = SettingsEditorSession(target: .bot(bot), model: modelA)
        let teamSession = SettingsEditorSession(target: .team(team), model: modelA)
        let policy = BotApprovalPolicyEditor(bot: bot, model: modelA, session: session)
        let access = BotExecutionAccessEditor(bot: bot, model: modelA, session: session)
        await policy.load(); await access.load(); policy.mode = .approveAll
        let choice = try XCTUnwrap(policy.prepareHumanSave()), accessChoice = try XCTUnwrap(access.prepareHumanChange(operation: .terminal, enabled: true))
        let beforeA = await a.requests(), beforeB = await b.requests()
        modelA.hostAddress = modelB.hostAddress; modelA.configureHost() // Real model rebind; no default transport is called.
        await policy.load(); await policy.saveHumanChoice(choice); await access.refresh(reason: .sectionRequested)
        await access.saveHumanChoice(accessChoice); await access.reconcile(); await access.retryExactRequest()
        XCTAssertEqual(policy.mode, .approveAll, "Retiring the session keeps the human's draft")
        XCTAssertEqual(session.bot, bot); XCTAssertEqual(session.teamID, nil); XCTAssertEqual(teamSession.team, team)
        let remounted = BotExecutionAccessEditor(bot: try XCTUnwrap(modelB.bots.first), model: modelB, session: session)
        await remounted.load(); XCTAssertFalse(remounted.scopeMatches)
        do { _ = try await teamSession.perform(in: modelB) { try await $0.listTeams() }; XCTFail("Stale team window must refuse before GET") }
        catch { XCTAssertEqual(error as? HostClientError, .forbidden) }
        let afterA = await a.requests(), afterB = await b.requests()
        XCTAssertEqual(afterA, beforeA); XCTAssertEqual(afterB, beforeB, "Old windows cause 0 GET / 0 mutations on the new base")
        XCTAssertTrue(session.invalidated); XCTAssertFalse(policy.canEdit); XCTAssertFalse(access.canEdit)
        modelA.closeThreadPresentation(); modelB.closeThreadPresentation()
    }
    func testRefreshReadsInventoryWithoutReplacingPolicyDraftAnd409DoesOneGETWithoutPATCHRetry() async throws {
        let wire = SettingsR5Transport(), model = try await model(wire, port: 49753)
        let bot = try XCTUnwrap(model.bots.first), session = SettingsEditorSession(target: .bot(bot), model: model)
        let policy = BotApprovalPolicyEditor(bot: bot, model: model, session: session)
        let editor = BotExecutionAccessEditor(bot: bot, model: model, session: session)
        await policy.load(); policy.mode = .approveAll; await editor.load()
        let old = try XCTUnwrap(editor.prepareHumanChange(operation: .terminal, enabled: true))
        await wire.advanceInventory()
        await editor.refresh(reason: .sectionRequested); await policy.refreshPreservingDraft()
        XCTAssertEqual(policy.mode, .approveAll); XCTAssertTrue(policy.dirty)
        XCTAssertTrue(editor.baseline?.entries.first?.provisional == true)
        await editor.saveHumanChoice(old) // An alert prepared before the refresh must not mutate.
        let readsOnly = await wire.accessCounts(); XCTAssertEqual(readsOnly, [2, 0])
        await editor.refresh(reason: .localActionChanged)
        let confirmation = try XCTUnwrap(editor.prepareHumanChange(operation: .terminal, enabled: true))
        await wire.advanceInventory()
        await editor.saveHumanChoice(confirmation)
        XCTAssertEqual(editor.notice, .conflict); XCTAssertNil(editor.pending); XCTAssertFalse(editor.requiresReload)
        XCTAssertTrue(editor.canEdit); XCTAssertEqual(editor.baseline?.entries.first?.grant?.revision, 2)
        let afterConflict = await wire.accessCounts(); XCTAssertEqual(afterConflict, [4, 1])
        await editor.saveHumanChoice(confirmation); await editor.retryExactRequest()
        let noRetry = await wire.accessCounts(); XCTAssertEqual(noRetry, [4, 1])
        XCTAssertNotNil(editor.prepareHumanChange(operation: .terminal, enabled: true), "Only a new human confirmation can use the new snapshot")
        model.closeThreadPresentation()
    }
    func testHeldRefreshCallbackIsDiscardedAndDraftSurvivesScopeChange() async throws {
        let wire = SettingsR5Transport(), model = try await model(wire, port: 49754)
        let bot = try XCTUnwrap(model.bots.first), session = SettingsEditorSession(target: .bot(bot), model: model)
        let editor = BotExecutionAccessEditor(bot: bot, model: model, session: session)
        let policy = BotApprovalPolicyEditor(bot: bot, model: model, session: session)
        await editor.load(); await policy.load(); policy.mode = .approveAll
        let original = try XCTUnwrap(editor.baseline)
        await wire.advanceInventory(); await wire.holdNextInventory()
        let refresh = Task { await editor.refresh(reason: .localActionChanged) }
        for _ in 0..<100 { if await wire.isHeld() { break }; await Task.yield() }
        let held = await wire.isHeld(); XCTAssertTrue(held)
        model.hostAddress = "http://127.0.0.1:49755"
        await wire.release(); await refresh.value
        XCTAssertEqual(editor.baseline, original); XCTAssertEqual(policy.mode, .approveAll)
        XCTAssertFalse(editor.busy); XCTAssertFalse(editor.scopeMatches); XCTAssertTrue(session.invalidated)
        let counts = await wire.accessCounts(); XCTAssertEqual(counts, [2, 0])
        model.closeThreadPresentation()
    }
    func testSecondStopNoticeUsesLatestCanonicalOriginWithoutClearingSecurityCorrelationSet() async throws {
        let wire = SettingsR5Transport(), model = try await model(wire, port: 49756)
        model.selectBot(id: "bot-r5")
        let generation = try XCTUnwrap(model.presentThread("thread-r5", for: "bot-r5"))
        await model.loadPresentedThread("thread-r5", generation: generation); model.stopPolling()
        let first = try XCTUnwrap(model.actions.first { $0.id == "action-first" })
        await model.cancelEffects(try XCTUnwrap(model.effectControlIdentity(for: first)))
        XCTAssertEqual(model.lastStopContext?.originTurnID, "turn-first")
        XCTAssertEqual(model.lastStopContext?.action?.id, "action-first")
        let second = try XCTUnwrap(model.actions.first { $0.id == "action-second" })
        await model.cancelEffects(try XCTUnwrap(model.effectControlIdentity(for: second)))
        XCTAssertEqual(model.lastStopContext?.originTurnID, "turn-second")
        XCTAssertEqual(model.lastStopContext?.action?.id, "action-second")
        XCTAssertEqual(model.lastStopContext?.action?.createdAt, 20)
        XCTAssertEqual(model.lastStopContext?.actionIDs, ["action-second"])
        XCTAssertEqual(model.stoppedActionIDs, ["action-first", "action-second"])
        XCTAssertTrue(model.lastStopContext?.hadRunningEffects == true)
        let writes = await wire.requests().filter { $0.hasPrefix("POST") }
        XCTAssertEqual(writes, ["POST /v1/turns/turn-first/cancel", "POST /v1/turns/turn-second/cancel"])
        model.closeThreadPresentation()
    }
    func testReceiptPresentationFactsWarnOnlyForNonzeroStoppedEffects() {
        let none = AccessMutationEffectSummary(.init(blockedActionIds: [], abortedActionIds: []))
        let blocked = AccessMutationEffectSummary(.init(blockedActionIds: ["action-blocked"], abortedActionIds: []))
        let stopped = AccessMutationEffectSummary(.init(blockedActionIds: [], abortedActionIds: ["action-stopped"]))
        XCTAssertFalse(none.shouldExplainPossiblePartialEffects); XCTAssertFalse(blocked.shouldExplainPossiblePartialEffects)
        XCTAssertTrue(stopped.shouldExplainPossiblePartialEffects)
        XCTAssertEqual(blocked.blockedCount, 1); XCTAssertEqual(stopped.stopRequestedCount, 1)
    }
}
@MainActor private final class SettingsR5Storage: DexterAppStateStorage {
    private var bytes: Data?
    func readData() -> Data? { bytes }
    func writeData(_ data: Data) { bytes = data }
    func removeData() { bytes = nil }
}
private actor R5ForbiddenIdentityStorage: ClientIdentityStorage {
    func load(_ scope: ClientIdentityScope) async throws -> ClientNativeIdentity? { throw ClientIdentityFailure.forbidden }
    func provision(_ scope: ClientIdentityScope) async throws -> ClientNativeIdentity { throw ClientIdentityFailure.forbidden }
}
private actor SettingsR5Transport: HTTPTransport {
    private var log: [String] = [], inventoryRevision = 0
    private var stopped: Set<String> = []
    private var hold = false, continuation: CheckedContinuation<Void, Never>?
    func requests() -> [String] { log }
    func accessCounts() -> [Int] { [log.filter { $0 == "GET /v1/bots/bot-r5/execution-access" }.count, log.filter { $0 == "PATCH /v1/bots/bot-r5/execution-access" }.count] }
    func advanceInventory() { inventoryRevision += 1 }
    func holdNextInventory() { hold = true }
    func isHeld() -> Bool { continuation != nil }
    func release() { continuation?.resume(); continuation = nil }
    func send(_ request: URLRequest) async throws -> TransportResponse {
        let path = request.url!.path, method = request.httpMethod ?? "GET"
        log.append(method + " " + path)
        var value: [String: Any]
        switch path {
        case "/health": value = ["protocolVersion": 1, "mode": "local-development", "engineRouting": "synthetic", "remotePairing": "not_implemented", "hostId": "host-r5-identical", "state": [:]]
        case "/v1/bots": value = ["items": [["id": "bot-r5", "name": "Synthetic same bot", "profileId": "profile-r5", "engine": "claude", "ownerId": "owner-r5", "createdAt": 1, "revision": 0]]]
        case "/v1/teams": value = ["items": [["id": "team-r5", "ownerId": "owner-r5", "name": "Synthetic same team", "roleDescription": "", "coordinatorBotId": "bot-r5", "botIds": ["bot-r5"], "rules": "", "memory": "", "revision": 0, "createdAt": 1, "updatedAt": 1]]]
        case "/v1/bots/bot-r5/threads": value = ["items": [["id": "thread-r5", "botId": "bot-r5", "createdAt": 1]]]
        case "/v1/threads/thread-r5": value = ["id": "thread-r5", "botId": "bot-r5", "createdAt": 1]
        case "/v1/events": value = ["items": [["id": "event-r5", "cursor": 1, "kind": "thread.created", "botId": "bot-r5", "entityId": "thread-r5", "createdAt": 1]], "nextCursor": 1]
        case "/v1/live-voice/settings", "/v1/threads/thread-r5/messages": value = ["items": [], "nextCursor": 0]
        case "/v1/threads/thread-r5/turns": value = ["items": [turn("first"), turn("second")], "nextCursor": 2]
        case "/v1/actions": value = ["items": [action("first"), action("second")]]
        case "/v1/bots/bot-r5/approval-policy":
            guard method == "GET" else { throw HostClientError.conflict }
            value = ["hostId": "host-r5-identical", "botId": "bot-r5", "ownerId": "owner-r5", "mode": "ask", "revision": 0, "eligibleScopeVersion": "d03.execution.v1", "updatedAt": 1, "receiptId": NSNull()]
        case "/v1/bots/bot-r5/execution-access":
            if method == "PATCH" { throw HostClientError.conflict }
            value = try access()
        default:
            if path.hasPrefix("/v1/actions/action-") {
                let key = path.contains("action-first") ? "first" : "second"
                value = path.hasSuffix("/continuation") ? ["continuation": ["originTurnId": "turn-" + key, "originValid": true, "deliveredToEngine": false, "responseTurnId": NSNull(), "responseState": NSNull(), "resultBodyAvailable": false]] : action(key)
            } else if path.hasPrefix("/v1/turns/turn-") {
                let key = path.contains("turn-first") ? "first" : "second"
                if path.hasSuffix("/cancel") { stopped.insert(key) }
                value = path.hasSuffix("/events") ? ["items": [], "nextCursor": 0] : turn(key)
            } else { throw HostClientError.notFound }
        }
        let data = try JSONSerialization.data(withJSONObject: value)
        if path.hasSuffix("/execution-access"), hold { hold = false; await withCheckedContinuation { continuation = $0 } }
        return TransportResponse(statusCode: 200, data: data)
    }
    private func access() throws -> [String: Any] {
        let entries: [[String: Any]] = ["terminal", "cli", "files_write", "automation"].map { op in
            let exists = op == "terminal" && inventoryRevision > 0
            return ["operation": op, "provisional": exists, "enabled": false,
                "grant": exists ? ["botId": "bot-r5", "tool": "dexter.harness.terminal.run", "destination": "dexter-harness-owner-proposals", "policy": "ask", "expiresAt": NSNull(), "revision": inventoryRevision] : NSNull()]
        }
        var object: [String: Any] = ["hostId": "host-r5-identical", "botId": "bot-r5", "ownerId": "owner-r5", "botRevision": 0, "scopeVersion": "d03.access.v1", "entries": entries]
        var hashed = object
        hashed["entries"] = entries.map { entry in var value = entry; value.removeValue(forKey: "enabled"); return value }
        let data = try JSONSerialization.data(withJSONObject: hashed, options: [.sortedKeys, .withoutEscapingSlashes])
        object["inventoryHash"] = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        return object
    }
    private func turn(_ key: String) -> [String: Any] {
        ["id": "turn-" + key, "cursor": key == "first" ? 1 : 2, "threadId": "thread-r5", "botId": "bot-r5", "engine": "claude", "clientRequestId": "request-" + key, "inputMessageId": "input-" + key, "outputMessageId": NSNull(), "state": "completed", "outputChars": 0, "outputTruncated": false, "createdAt": key == "first" ? 10 : 20, "updatedAt": 30]
    }
    private func action(_ key: String) -> [String: Any] {
        ["id": "action-" + key, "request": ["botId": "bot-r5", "threadId": "thread-r5", "tool": "dexter.harness.terminal.run", "destination": "bot-workspace", "arguments": ["input": ["command": "synthetic only"]], "idempotencyKey": key], "requestHash": String(repeating: key == "first" ? "a" : "b", count: 64), "grantRevision": 1, "state": stopped.contains(key) ? "unknown" : "running", "createdAt": key == "first" ? 10 : 20, "updatedAt": stopped.contains(key) ? 50 : 30, "decidedBy": "owner-r5", "result": stopped.contains(key) ? ["commandOutcome": "interrupted", "termination": "cancelled", "signal": "SIGTERM"] : NSNull()]
    }
}
#endif
