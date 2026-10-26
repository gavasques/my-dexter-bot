#if os(macOS)
import DexterClientIdentity
import DexterHostClient
import Foundation
import Observation
import XCTest
@testable import DexterAppCore

/// UI R1 (MCP3-B / memory4-B): what the bot settings window renders over Sol's `OwnerConfigurationEditor`, with the real
/// AppModel, window session and editor over an injected in-process transport (no socket, port, process or account).
@MainActor final class OwnerConfigurationUIR1Tests: XCTestCase {
    private func fixture(_ wire: OwnerConfigUIR1Transport, port: Int) async throws -> (DexterAppModel, HostClient, OwnerConfigurationEditor) {
        let client = HostClient(baseURL: URL(string: "http://127.0.0.1:\(port)")!, transport: wire)
        let pairing = PairedHostOnboarding(journal: UnavailableClientClaimJournal(), storage: EphemeralPairedHostStateStorage(), identityStorage: { _ in OwnerConfigUIR1ForbiddenIdentity() })
        let model = DexterAppModel(client: client, storage: OwnerConfigUIR1Storage(), pairing: pairing)
        await model.refresh(); XCTAssertTrue(model.isOnline)
        let bot = try XCTUnwrap(model.bots.first)
        let editor = OwnerConfigurationEditor(bot: bot, model: model, session: SettingsEditorSession(target: .bot(bot), model: model))
        await editor.open(); XCTAssertNotNil(editor.hostSession)
        return (model, client, editor)
    }

    /// One/some/all over the CURRENT snapshot: two accounts on the same endpoint stay two accounts; "all" lists exactly
    /// the accounts available now and is refused (never sent) while one cannot be listed; a selected-but-unavailable
    /// account is called out because any plan removes this bot's tools there. The review is the host plan vs snapshot.
    func testAccountsDraftIsTheCurrentSnapshotAndTheReviewShowsOnlyThisBotsExactChanges() async throws {
        let wire = OwnerConfigUIR1Transport(), (model, client, editor) = try await fixture(wire, port: 49931)
        await wire.setReview(unavailable: ["gmail-old"], selected: [("gmail-pessoal", ["send", "search"]), ("gmail-old", ["search"])])
        await editor.refreshMcp(); let review = try XCTUnwrap(editor.mcpReview)
        var draft = McpAccountsDraft(review: review)
        XCTAssertEqual(draft.mode, .one); XCTAssertEqual(draft.choices(in: review).map(\.serverId), ["gmail-pessoal"])
        XCTAssertNil(draft.issue(in: review), "even the untouched draft would drop gmail-old: review stays possible and shows it")
        XCTAssertEqual(McpAccountsPresentation.selectedButUnavailable(review), ["gmail-old"])
        XCTAssertFalse(McpAccountsPresentation.allConnectedAvailable(review))
        draft.setMode(.all); XCTAssertEqual(draft.issue(in: review), .allNeedsEveryAccount(["gmail-old"])); XCTAssertNil(draft.input(for: review))
        draft.setMode(.some); draft.include("gmail-trabalho", true, in: review)
        XCTAssertEqual(draft.issue(in: review), .chooseTools(["gmail-trabalho"]), "an account without tools is not silently dropped")
        draft.setTool("search", true, serverID: "gmail-trabalho")
        let input = try XCTUnwrap(draft.input(for: review)); XCTAssertEqual(input.mode, .explicit)
        XCTAssertEqual(input.instances.map(\.serverId), ["gmail-pessoal", "gmail-trabalho"])
        let plan = try await editor.plan(input); XCTAssertTrue(McpAccountsPresentation.planMatchesReview(plan, review))
        let changes = McpAccountsPresentation.changes(review: review, plan: plan)
        XCTAssertEqual(changes.map(\.serverID), ["gmail-old", "gmail-pessoal", "gmail-trabalho"])
        XCTAssertEqual(changes.map(\.kind), [.removed, .unchanged, .added])
        XCTAssertEqual(changes[0].removed, ["search"]); XCTAssertEqual(changes[2].added, ["search"])
        XCTAssertEqual(changes[2].connectionID, "conn-gmail-trabalho")

        // Same endpoint, distinct IDs: "all" is the explicit list of the three accounts available now.
        await wire.setReview(unavailable: [], selected: [("gmail-pessoal", ["send", "search"])]); await editor.refreshMcp()
        let now = try XCTUnwrap(editor.mcpReview); XCTAssertNotEqual(now.inventoryPin, review.inventoryPin)
        XCTAssertEqual(McpAccountsDraft(review: now).issue(in: now), .noChange)
        var all = McpAccountsDraft(review: now); all.setMode(.all)
        XCTAssertEqual(all.issue(in: now), .chooseTools(["gmail-trabalho", "notion"]))
        all.setTools(["search"], serverID: "gmail-trabalho"); all.setTools(["read"], serverID: "notion")
        all.include("notion", false, in: now); XCTAssertTrue(all.isIncluded("notion", in: now), "no per-account opt-out inside all")
        let snapshot = try XCTUnwrap(all.input(for: now)); XCTAssertEqual(snapshot.mode, .allConnected)
        XCTAssertEqual(snapshot.instances.map(\.serverId), ["gmail-pessoal", "gmail-trabalho", "notion"])
        let allPlan = try await editor.plan(snapshot); XCTAssertEqual(allPlan.targets.count, 3)
        let calls = await wire.ownerCalls()
        XCTAssertEqual(calls.filter { $0.hasPrefix("POST") && !$0.hasSuffix("/mcp/plan") && !$0.hasSuffix("/configuration-session") }, [], "planning is read-only")
        client.close(); model.closeThreadPresentation()
    }

    /// The proposal's ACK is lost: the stage says "not confirmed", a new review is blocked, "Conferir estado" reads the
    /// SAME request (no second POST), then the owner's single Allow decides; a partial effect receipt stays partial.
    func testLostProposalAckIsReadByTheSameRequestOnlyAndPartialStaysLiteral() async throws {
        let wire = OwnerConfigUIR1Transport(), (model, client, editor) = try await fixture(wire, port: 49932)
        await wire.setReview(unavailable: [], selected: [("gmail-pessoal", ["search"])]); await editor.refreshMcp()
        let review = try XCTUnwrap(editor.mcpReview)
        var draft = McpAccountsDraft(review: review); draft.setMode(.some); draft.include("notion", true, in: review); draft.setTool("read", true, serverID: "notion")
        let plan = try await editor.plan(try XCTUnwrap(draft.input(for: review)))
        let proposal = try OwnerConfigurationProposal(mcpPlan: plan)
        try editor.prepare(proposal); await wire.bind(requestID: proposal.requestID, bodyHash: proposal.bodyHash)
        XCTAssertEqual(stage(editor), .prepared)
        await wire.loseNextProposalACK(); await wire.failNextRequestRead()
        await editor.submit()
        XCTAssertEqual(stage(editor), .notConfirmed); XCTAssertTrue(stage(editor).needsCheck); XCTAssertTrue(stage(editor).isOpen)
        XCTAssertThrowsError(try editor.prepare(try OwnerConfigurationProposal(mcpPlan: plan)), "an open outcome blocks another review")
        await editor.submit() // the same button again is a GET-only reconcile
        XCTAssertEqual(stage(editor), .awaitingDecision)
        let action = try XCTUnwrap(editor.action)
        await wire.setEffectPhase("partial", code: "grant_conflict")
        await editor.decide(.allow)
        XCTAssertEqual(stage(editor), .succeeded); XCTAssertEqual(editor.action?.id, action.id)
        let outcome = McpAccountsPresentation.outcome(try await editor.mcpReceipt())
        XCTAssertEqual(outcome, .partial(code: "grant_conflict"))
        let calls = await wire.ownerCalls()
        XCTAssertEqual(calls.filter { $0.hasSuffix("/mcp/proposals") }.count, 1, "never a second proposal POST")
        XCTAssertEqual(calls.filter { $0.contains("/decisions") }.count, 1)
        XCTAssertTrue(calls.filter { $0.contains("/requests/") }.allSatisfy { $0.hasSuffix("/requests/" + proposal.requestID) && $0.hasPrefix("GET") })
        try editor.finishReview(); XCTAssertEqual(stage(editor), .none)
        client.close(); model.closeThreadPresentation()
    }

    /// The window's base changes while a read is held: the stage facts read during rendering are pure (no observed
    /// write), the late answer is dropped, the explicit latch retires the editor and no request leaves after the switch.
    /// Only the model's address changes (no new client), so even a bug could not reach a real socket.
    func testBaseSwitchDropsLateAnswersAndRenderingFactsStayPure() async throws {
        let wire = OwnerConfigUIR1Transport(), (model, client, editor) = try await fixture(wire, port: 49933)
        await wire.setReview(unavailable: [], selected: [("gmail-pessoal", ["search"])]); await editor.refreshMcp()
        let before = try XCTUnwrap(editor.mcpReview)
        await wire.holdNextSelection(); await wire.setReview(unavailable: [], selected: [])
        let late = Task { await editor.refreshMcp() }
        for _ in 0..<200 { if await wire.isHeld() { break }; try await Task.sleep(for: .milliseconds(2)) }
        let held = await wire.isHeld(); XCTAssertTrue(held)
        model.hostAddress = "http://127.0.0.1:49936" // another base for this window; the client is not replaced
        let callsAtSwitch = await wire.ownerCalls().count
        let counter = OwnerConfigUIR1Counter()
        withObservationTracking { _ = editor.state; _ = editor.invalidated; _ = editor.session.invalidated; _ = editor.mcpReview } onChange: { counter.increment() }
        for _ in 0..<50 {
            XCTAssertEqual(OwnerProposalStage.from(state: editor.state, action: editor.action?.state, mutationSent: editor.mutationSent), .none)
            XCTAssertFalse(OwnerConfigurationWindowFacts.isCurrent(session: editor.session, model: model, botID: editor.botID, ownerID: editor.ownerID, editorInvalidated: editor.invalidated))
        }
        XCTAssertEqual(counter.value, 0); XCTAssertFalse(editor.session.invalidated)
        await wire.release(); await late.value
        XCTAssertEqual(editor.mcpReview, before, "the late answer from the old base is dropped")
        XCTAssertFalse(editor.scopeMatches); editor.invalidate() // the hook's explicit latch
        XCTAssertTrue(editor.session.invalidated)
        XCTAssertEqual(OwnerProposalStage.from(state: editor.state, action: nil, mutationSent: false), .retired)
        await editor.refreshMcp(); await editor.refreshMemory(); await editor.open()
        let after = await wire.ownerCalls()
        XCTAssertEqual(after.count, callsAtSwitch, "zero requests after the window's base changed")
        client.close(); model.closeThreadPresentation()
    }

    /// Memory: the literal excerpt is a suggestion listed apart (empty/invalid/maintenance jobs are not), the policy is
    /// off by default and needs an effective approval before duplicates can be previewed; saving a suggestion is ONE
    /// proposal POST naming only the job, and repeating the button reads the same request.
    func testLiteralSuggestionsAreListedApartAndCaptureIsOneProposalForTheJob() async throws {
        let wire = OwnerConfigUIR1Transport(), (model, client, editor) = try await fixture(wire, port: 49935)
        await editor.refreshMemory()
        let status = try XCTUnwrap(editor.memoryPolicy)
        XCTAssertEqual(MemorySuggestionsPresentation.availability(status), .literalExcerpt)
        XCTAssertEqual(MemorySuggestionsPresentation.policy(status), .off); XCTAssertFalse(MemorySuggestionsPresentation.maintenanceAvailable(status))
        await wire.setPolicy(enabled: true, effective: true, maintenance: true); await editor.refreshMemory()
        let on = try XCTUnwrap(editor.memoryPolicy)
        XCTAssertEqual(MemorySuggestionsPresentation.policy(on), .on); XCTAssertTrue(MemorySuggestionsPresentation.maintenanceAvailable(on))
        let listed = MemorySuggestionsPresentation.listed(editor.jobs)
        XCTAssertEqual(listed.map(\.state), ["candidate", "withdrawn"], "empty and maintenance jobs stay out of the suggestion list")
        let candidate = try XCTUnwrap(listed.first); XCTAssertEqual(MemorySuggestionsPresentation.candidate(candidate), .suggested)
        XCTAssertEqual(MemorySuggestionsPresentation.candidate(listed[1]), .withdrawn)
        XCTAssertEqual(candidate.note, "Prefere relatórios curtos, com a conclusão primeiro.")
        await wire.setPolicy(enabled: true, effective: false, maintenance: true); await editor.refreshMemory()
        let stale = try XCTUnwrap(editor.memoryPolicy)
        XCTAssertEqual(MemorySuggestionsPresentation.policy(stale), .onWithoutEffect); XCTAssertFalse(MemorySuggestionsPresentation.maintenanceAvailable(stale))

        let proposal = try OwnerConfigurationProposal(captureJobID: candidate.id)
        try editor.prepare(proposal); await wire.bind(requestID: proposal.requestID, bodyHash: proposal.bodyHash)
        await editor.submit(); XCTAssertEqual(stage(editor), .awaitingDecision)
        await editor.submit() // repeated click: GET of the same request only
        let posts = await wire.proposalBodies()
        XCTAssertEqual(posts.count, 1)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: posts[0]) as? [String: Any])
        XCTAssertEqual(Set(body.keys), ["clientRequestId", "jobId"]); XCTAssertEqual(body["jobId"] as? String, candidate.id)
        await editor.decide(.deny); XCTAssertEqual(stage(editor), .denied)
        client.close(); model.closeThreadPresentation()
    }

    private func stage(_ editor: OwnerConfigurationEditor) -> OwnerProposalStage {
        OwnerProposalStage.from(state: editor.state, action: editor.action?.state, mutationSent: editor.mutationSent)
    }
}

private final class OwnerConfigUIR1Counter: @unchecked Sendable {
    private let lock = NSLock(); private var count = 0
    func increment() { lock.lock(); count += 1; lock.unlock() }
    var value: Int { lock.lock(); defer { lock.unlock() }; return count }
}
@MainActor private final class OwnerConfigUIR1Storage: DexterAppStateStorage {
    var data: Data?
    func readData() -> Data? { data }
    func writeData(_ value: Data) { data = value }
    func removeData() { data = nil }
}
private actor OwnerConfigUIR1ForbiddenIdentity: ClientIdentityStorage {
    func load(_ scope: ClientIdentityScope) async throws -> ClientNativeIdentity? { throw ClientIdentityFailure.forbidden }
    func provision(_ scope: ClientIdentityScope) async throws -> ClientNativeIdentity { throw ClientIdentityFailure.forbidden }
}

/// Stateful synthetic owner host for the window's routes. Records every call; no sockets.
private actor OwnerConfigUIR1Transport: HTTPTransport {
    private let sessionID = "5d8f6c3e-2b1a-4c7d-9e0f-1a2b3c4d5e6f"
    private var calls: [String] = [], proposals: [Data] = []
    private var unavailable: [String] = [], selected: [(String, [String])] = [], revision = 3
    private var policyEnabled = false, policyEffective = false, policyMaintenance = false
    private var bodyHashes: [String: String] = [:], actions: [String: [String: Any]] = [:], requestActions: [String: String] = [:]
    private var operations: [String: String] = [:], windowID = ""
    private var loseProposalACK = false, requestReadFailure = false, effectPhase = "completed", effectCode: String?
    private var holdSelection = false, held: CheckedContinuation<Void, Never>?
    private let instances = ["gmail-pessoal", "gmail-trabalho", "notion"]
    func ownerCalls() -> [String] { calls }
    func proposalBodies() -> [Data] { proposals }
    func setReview(unavailable: [String], selected: [(String, [String])]) { self.unavailable = unavailable; self.selected = selected; revision += 1 }
    func setPolicy(enabled: Bool, effective: Bool, maintenance: Bool) { policyEnabled = enabled; policyEffective = effective; policyMaintenance = maintenance }
    func bind(requestID: String, bodyHash: String) { bodyHashes[requestID] = bodyHash }
    func loseNextProposalACK() { loseProposalACK = true }
    func failNextRequestRead() { requestReadFailure = true }
    func setEffectPhase(_ phase: String, code: String?) { effectPhase = phase; effectCode = code }
    func holdNextSelection() { holdSelection = true }
    func isHeld() -> Bool { held != nil }
    func release() { held?.resume(); held = nil }

    private func nullable(_ value: String?) -> Any { value.map { $0 as Any } ?? NSNull() }
    private func pin(_ name: String) -> String {
        let digest = Array(name.utf8).reduce(into: [UInt8](repeating: 0, count: 32)) { acc, byte in
            for i in 0..<32 { acc[i] = acc[i] &* 31 &+ byte &+ UInt8(i) }
        }
        return digest.map { String(format: "%02x", $0) }.joined()
    }
    private func instance(_ id: String) -> [String: Any] {
        ["serverId": id, "generation": "0f1e2d3c-4b5a-4968-8776-\(String(format: "%012d", id.count))", "instancePin": pin("i" + id),
         "configurationPin": pin("c" + id), "connectionId": "conn-" + id, "connectionRevision": 1]
    }
    private var available: [String] { instances.filter { !unavailable.contains($0) } }
    private var inventoryPin: String { pin("inv" + available.joined(separator: ",") + "|" + unavailable.joined(separator: ",")) }
    private var selectionPin: String { pin("sel\(revision)" + selected.map { $0.0 + ":" + $0.1.joined(separator: ",") }.joined(separator: ";")) }
    private func review() -> [String: Any] {
        ["botId": "bot-ui-r1", "profileId": "profile-ui-r1", "revision": revision, "inventoryPin": inventoryPin, "selectionPin": selectionPin,
         "instances": available.map(instance),
         "selected": selected.map { ["serverId": $0.0, "connectionId": "conn-" + $0.0, "toolIds": $0.1.sorted()] },
         "unavailableInstances": unavailable.map { ["serverId": $0, "reason": "catalog_or_generation_unavailable"] },
         "authenticatedSubject": "unverified"]
    }
    private func action(_ id: String, state: String, tool: String, input: Any) -> [String: Any] {
        ["id": id, "request": ["botId": "bot-ui-r1", "threadId": "thr_owner_settings_r1", "tool": tool, "destination": "dexter-harness-owner-proposals",
                               "arguments": ["input": input], "idempotencyKey": "owner_settings_" + id],
         "requestHash": pin("hash" + id), "grantRevision": 1, "state": state, "createdAt": 10, "updatedAt": 11,
         "approvalExpiresAt": NSNull(), "decidedBy": nullable(state == "awaiting_approval" ? nil : "owner-ui-r1"), "result": NSNull(), "reason": NSNull()]
    }
    private func job(_ id: String, kind: String, state: String, note: String?, createdAt: Int) -> [String: Any] {
        ["id": pin("job" + id), "botId": "bot-ui-r1", "profileId": "profile-ui-r1", "botRevision": 0, "epoch": 2, "policyRevision": 2,
         "kind": kind, "state": state,
         "source": kind == "capture" ? ["turnId": "turn-" + id, "threadId": "thr-" + id, "inputMessageId": "in-" + id, "outputMessageId": "out-" + id,
                                       "finishedAt": 1_760_000_000_000, "outputHash": pin("out" + id), "outputCharacters": 140, "role": "assistant"] as Any : NSNull(),
         "note": nullable(note), "baseRevision": 4, "soulHash": pin("soul"), "userHash": pin("user"), "memoryHash": pin("mem"),
         "nextMemoryHash": NSNull(), "actionId": NSNull(), "proposalTurnId": NSNull(), "createdAt": createdAt, "updatedAt": createdAt, "receipt": NSNull()]
    }

    func send(_ request: URLRequest) async throws -> TransportResponse {
        let path = request.url!.path, method = request.httpMethod ?? "GET"
        calls.append(method + " " + path)
        let s = "/v1/owner-configuration/sessions/" + sessionID
        switch path {
        case "/health":
            return .init(statusCode: 200, data: try encode(["protocolVersion": 1, "mode": "local-development", "engineRouting": "synthetic", "remotePairing": "not_implemented", "hostId": "host-ui-r1", "state": ["hostId": "host-ui-r1", "ownerId": "owner-ui-r1"]]))
        case "/v1/bots":
            return .init(statusCode: 200, data: try encode(["items": [["id": "bot-ui-r1", "name": "Synthetic bot", "profileId": "profile-ui-r1", "ownerId": "owner-ui-r1", "engine": "claude", "revision": 0, "createdAt": 1]]]))
        case "/v1/actions", "/v1/events", "/v1/teams", "/v1/live-voice/settings":
            return .init(statusCode: 200, data: try encode(["items": [], "nextCursor": 0]))
        case "/v1/bots/bot-ui-r1/configuration-session" where method == "POST":
            let body = try JSONSerialization.jsonObject(with: try XCTUnwrap(request.httpBody)) as! [String: Any]
            windowID = body["windowID"] as! String
            return .init(statusCode: 200, data: try encode(["sessionID": sessionID, "hostID": "host-ui-r1", "ownerID": "owner-ui-r1", "botID": "bot-ui-r1",
                "profileID": "profile-ui-r1", "botRevision": 0, "windowID": windowID, "expiresAt": 9_999_999_999_999]))
        case s + "/mcp/selection":
            if holdSelection { holdSelection = false; await withCheckedContinuation { held = $0 } }
            return .init(statusCode: 200, data: try encode(review()))
        case s + "/mcp/plan" where method == "POST":
            let input = try JSONSerialization.jsonObject(with: try XCTUnwrap(request.httpBody)) as! [String: Any]
            guard input["expectedInventoryPin"] as? String == inventoryPin, input["expectedSelectionPin"] as? String == selectionPin else { return .init(statusCode: 409, data: Data()) }
            let chosen = (input["instances"] as! [[String: Any]]).sorted { ($0["serverId"] as! String) < ($1["serverId"] as! String) }
            let targets = chosen.map { choice -> [String: Any] in var value = instance(choice["serverId"] as! String); value["toolIds"] = choice["toolIds"]; return value }
            return .init(statusCode: 200, data: try encode(["version": 1, "mode": input["mode"]!, "inventoryPin": inventoryPin, "selectionPin": selectionPin, "expectedRevision": revision, "targets": targets]))
        case s + "/mcp/proposals" where method == "POST", s + "/memory/capture/proposals" where method == "POST":
            let data = try XCTUnwrap(request.httpBody); proposals.append(data)
            let body = try JSONSerialization.jsonObject(with: data) as! [String: Any], id = body["clientRequestId"] as! String
            let isMcp = path.hasSuffix("/mcp/proposals"), actionID = "act-" + String(id.prefix(8))
            operations[id] = isMcp ? "mcp.select_instances" : "memory.capture.propose"
            actions[actionID] = action(actionID, state: "awaiting_approval", tool: isMcp ? "dexter.harness.mcp.select_instances" : "dexter.harness.memory.append",
                                       input: isMcp ? ["selectionPlan": body["plan"]!] : ["jobId": body["jobId"]!])
            requestActions[id] = actionID
            if loseProposalACK { loseProposalACK = false; throw URLError(.networkConnectionLost) }
            return .init(statusCode: 200, data: try encode(actions[actionID]!))
        case let p where p.hasPrefix(s + "/requests/"):
            if requestReadFailure { requestReadFailure = false; throw URLError(.networkConnectionLost) }
            let id = String(p.dropFirst((s + "/requests/").count))
            guard let actionID = requestActions[id], let action = actions[actionID] else { return .init(statusCode: 200, data: try encode(["action": NSNull(), "intent": NSNull()])) }
            return .init(statusCode: 200, data: try encode(["action": action, "intent": ["kind": "owner_settings_proposal_v1", "ownerId": "owner-ui-r1", "windowId": windowID,
                "clientRequestId": id, "operation": operations[id]!, "bodyHash": bodyHashes[id] ?? ""]]))
        case let p where p.hasPrefix("/v1/actions/") && p.hasSuffix("/decisions") && method == "POST":
            let actionID = String(p.dropFirst("/v1/actions/".count).dropLast("/decisions".count))
            let input = try JSONSerialization.jsonObject(with: try XCTUnwrap(request.httpBody)) as! [String: Any]
            guard var value = actions[actionID], input["requestHash"] as? String == value["requestHash"] as? String else { return .init(statusCode: 409, data: Data()) }
            value["state"] = input["decision"] as? String == "allow" ? "succeeded" : "denied"; value["decidedBy"] = "owner-ui-r1"; actions[actionID] = value
            return .init(statusCode: 200, data: try encode(value))
        case let p where p.hasPrefix(s + "/mcp/receipts/"):
            let actionID = String(p.dropFirst((s + "/mcp/receipts/").count)); let value = try XCTUnwrap(actions[actionID])
            let plan = ((value["request"] as! [String: Any])["arguments"] as! [String: Any])["input"] as! [String: Any]
            return .init(statusCode: 200, data: try encode(["action": value, "selection": ["receipt": [
                "version": 1, "operation": "mcp.select_instances", "receiptId": "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", "actionId": actionID,
                "hubRequestHash": value["requestHash"]!, "originHash": pin("origin"), "requestHash": pin("req"), "botId": "bot-ui-r1", "profileId": "profile-ui-r1",
                "revision": revision + 1, "plan": plan["selectionPlan"]!, "steps": [], "retainedGrants": [], "phase": effectPhase, "code": nullable(effectCode), "createdAt": 12],
                "current": "changed", "matchingStepStates": 0, "totalSteps": 1, "replayed": true, "grantsReplayed": false, "authenticationVerified": false]]))
        case s + "/memory/policy":
            return .init(statusCode: 200, data: try encode(["policy": ["revision": policyEnabled ? 2 : 0, "epoch": policyEnabled ? 2 : 0, "enabled": policyEnabled,
                "maintenanceEnabled": policyMaintenance, "minIntervalMs": 60000, "maxNotesPerDay": 4, "maxNoteCharacters": 512,
                "actionId": nullable(policyEnabled ? "act-policy" : nil), "botRevision": 0, "profileId": "profile-ui-r1", "grantRevision": 1, "updatedAt": 5],
                "effectiveEnabled": policyEffective, "mode": "candidate_review_only", "extractor": "literal_excerpt", "semanticExtractor": "unconfigured",
                "candidateMeaning": "literal_suggested_excerpt", "automaticMemoryWrites": false, "dreaming": "not_implemented",
                "source": "completed_own_assistant_text_only", "journal": ["jobs": 4]]))
        case s + "/memory/jobs":
            return .init(statusCode: 200, data: try encode(["items": [
                job("a", kind: "capture", state: "candidate", note: "Prefere relatórios curtos, com a conclusão primeiro.", createdAt: 400),
                job("bb", kind: "capture", state: "empty", note: nil, createdAt: 300),
                job("ccc", kind: "maintenance", state: "candidate", note: nil, createdAt: 250),
                job("dddd", kind: "capture", state: "withdrawn", note: "Usa o calendário de trabalho às segundas.", createdAt: 200)]]))
        default:
            return .init(statusCode: 404, data: Data())
        }
    }
    private func encode(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value) }
}
#endif
