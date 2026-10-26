#if os(macOS)
import DexterHostClient
import Foundation
import CryptoKit
import XCTest
@testable import DexterAppCore

/// Only in-memory HTTP transport/state. No socket, host process, account or native permission is used.
@MainActor final class BotApprovalPolicyTests: XCTestCase {
    func testActionReceiptRetainsOwnerPolicyEvidenceAndOlderReceiptRemainsCompatible() throws {
        var object: [String: Any] = ["id": "action_policy", "request": ["botId": "bot_policy_a", "threadId": "thread_policy",
            "tool": "dexter.harness.terminal.run", "destination": "own-synthetic-lab", "arguments": [:], "idempotencyKey": "synthetic-action-key"],
            "requestHash": String(repeating: "a", count: 64), "grantRevision": 3, "state": "succeeded", "createdAt": 1, "updatedAt": 2,
            "decidedBy": "owner_policy", "authorization": ["source": "owner_policy", "ownerId": "owner_policy", "policyRevision": 7,
                "policyReceiptId": "receipt_policy_7", "eligibleScopeVersion": "d03.execution.v1"]]
        let action = try JSONDecoder().decode(Action.self, from: JSONSerialization.data(withJSONObject: object))
        XCTAssertEqual(action.authorization?.source, .ownerPolicy)
        XCTAssertEqual(action.authorization?.ownerId, "owner_policy")
        XCTAssertEqual(action.authorization?.policyRevision, 7)
        XCTAssertEqual(action.authorization?.policyReceiptId, "receipt_policy_7")
        XCTAssertEqual(action.authorization?.eligibleScopeVersion, BotApprovalPolicy.executionScopeVersion)
        XCTAssertEqual(try JSONDecoder().decode(Action.self, from: JSONEncoder().encode(action)), action)
        object.removeValue(forKey: "authorization")
        let old = try JSONDecoder().decode(Action.self, from: JSONSerialization.data(withJSONObject: object))
        XCTAssertNil(old.authorization); XCTAssertEqual(old.state, .succeeded)
    }

    func testHumanPolicySaveUsesSeparateExactRouteAndDoesNotChangeOtherBotOrProfile() async throws {
        let transport = PolicySyntheticTransport()
        let model = await makeModel(transport)
        let bot = try XCTUnwrap(model.bots.first { $0.id == "bot_policy_a" })
        let editor = BotApprovalPolicyEditor(bot: bot, model: model)
        await editor.load()
        XCTAssertEqual(editor.baseline?.mode, .ask); XCTAssertEqual(editor.baseline?.revision, 0)
        editor.mode = .approveAll
        let confirmation = try XCTUnwrap(editor.prepareHumanSave())
        model.selectBot(id: "bot_policy_b")
        await editor.saveHumanChoice(confirmation)
        XCTAssertEqual(editor.baseline?.mode, .approveAll); XCTAssertEqual(editor.baseline?.revision, 1)
        XCTAssertEqual(editor.notice, .saved); XCTAssertNil(editor.pending)
        XCTAssertEqual(model.bots.first { $0.id == bot.id }, bot)
        let other = try await model.loadBotApprovalPolicy(botID: "bot_policy_b", ownerID: "owner_policy")
        XCTAssertEqual(other.mode, .ask); XCTAssertEqual(other.revision, 0)
        let writes = await transport.writes()
        XCTAssertEqual(writes.count, 1); XCTAssertEqual(writes.first?.path, "/v1/bots/bot_policy_a/approval-policy")
        let body = try XCTUnwrap(writes.first?.body)
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["expectedHostId", "clientRequestId", "expectedRevision", "mode", "eligibleScopeVersion"])
        XCTAssertEqual(object["clientRequestId"] as? String, confirmation.request.input.clientRequestId)
        let observed1 = await transport.effects()
        XCTAssertEqual(observed1, 1)
    }

    func testLostResponseRetainsExactRequestAcrossClosingAndRecoversReceiptWithoutMutationReplay() async throws {
        let transport = PolicySyntheticTransport()
        let model = await makeModel(transport)
        let bot = try XCTUnwrap(model.bots.first)
        let editor = BotApprovalPolicyEditor(bot: bot, model: model)
        await editor.load(); editor.mode = .approveAll
        let confirmation = try XCTUnwrap(editor.prepareHumanSave())
        await transport.loseResponseAfterApply()
        await editor.saveHumanChoice(confirmation)
        XCTAssertEqual(editor.notice, .saveUnknown)
        XCTAssertEqual(editor.pending?.input, confirmation.request.input)
        XCTAssertFalse(editor.canSave); XCTAssertFalse(editor.canRetryExactRequest)
        editor.close()
        let reopened = BotApprovalPolicyEditor(bot: bot, model: model)
        XCTAssertEqual(reopened.pending?.input, confirmation.request.input)
        await reopened.load()
        XCTAssertEqual(reopened.notice, .saved); XCTAssertEqual(reopened.lastReceipt?.clientRequestId, confirmation.request.input.clientRequestId)
        XCTAssertNil(reopened.pending); XCTAssertTrue(model.pendingBotApprovalPolicyMutations.isEmpty)
        let observed2 = await transport.effects()
        let observed3 = await transport.writes().count
        XCTAssertEqual(observed2, 1); XCTAssertEqual(observed3, 1)
    }

    func testReceiptMissingReadsStateAndOnlyExplicitRetryReusesOriginalIDAndContent() async throws {
        let transport = PolicySyntheticTransport()
        let model = await makeModel(transport)
        let editor = BotApprovalPolicyEditor(bot: try XCTUnwrap(model.bots.first), model: model)
        await editor.load(); editor.mode = .approveAll
        let confirmation = try XCTUnwrap(editor.prepareHumanSave())
        await transport.failBeforeApply()
        await editor.saveHumanChoice(confirmation)
        await editor.reconcile()
        XCTAssertEqual(editor.notice, .receiptMissing); XCTAssertTrue(editor.canRetryExactRequest); XCTAssertFalse(editor.canSave)
        let observed4 = await transport.effects()
        let observed5 = await transport.writes().count
        XCTAssertEqual(observed4, 0); XCTAssertEqual(observed5, 1)
        await editor.retryExactRequest()
        let writes = await transport.writes()
        let inputs = try writes.map { try JSONDecoder().decode(PatchBotApprovalPolicyInput.self, from: XCTUnwrap($0.body)) }
        XCTAssertEqual(inputs, [confirmation.request.input, confirmation.request.input])
        let observed6 = await transport.effects()
        XCTAssertEqual(observed6, 1); XCTAssertEqual(editor.notice, .saved)
    }

    func testHumanConfirmationRejectsChangedChoiceAndChangedBaseWithoutSendingPolicyMutation() async throws {
        let transport = PolicySyntheticTransport()
        let model = await makeModel(transport)
        let editor = BotApprovalPolicyEditor(bot: try XCTUnwrap(model.bots.first), model: model)
        await editor.load(); editor.mode = .approveAll
        let confirmation = try XCTUnwrap(editor.prepareHumanSave())
        editor.mode = .ask
        await editor.saveHumanChoice(confirmation)
        let observed7 = await transport.writes().count
        XCTAssertEqual(observed7, 0)
        editor.mode = .approveAll
        model.useFixture()
        await editor.saveHumanChoice(confirmation)
        XCTAssertFalse(editor.scopeMatches); XCTAssertNil(editor.prepareHumanSave())
        let observed8 = await transport.writes().count
        XCTAssertEqual(observed8, 0)
    }

    func testDefinitiveRevisionConflictRequiresNewReadAndDoesNotTrapEditorOrRetryMutation() async throws {
        let transport = PolicySyntheticTransport()
        let model = await makeModel(transport)
        let editor = BotApprovalPolicyEditor(bot: try XCTUnwrap(model.bots.first), model: model)
        await editor.load(); editor.mode = .approveAll
        let confirmation = try XCTUnwrap(editor.prepareHumanSave())
        await transport.advanceExternalPolicy()
        await editor.saveHumanChoice(confirmation)
        XCTAssertEqual(editor.notice, .conflict); XCTAssertNil(editor.pending); XCTAssertFalse(editor.canSave)
        XCTAssertTrue(model.pendingBotApprovalPolicyMutations.isEmpty)
        await editor.load()
        XCTAssertEqual(editor.baseline?.revision, 1); XCTAssertEqual(editor.mode, .ask); XCTAssertTrue(editor.canEdit)
        let writes = await transport.writes(); XCTAssertEqual(writes.count, 1)
        let effects = await transport.effects(); XCTAssertEqual(effects, 0)
    }

    func testReceiptWithDifferentCanonicalHashIsUnconfirmedAndReconcilesWithoutRepeatingEffect() async throws {
        let transport = PolicySyntheticTransport()
        let model = await makeModel(transport)
        let editor = BotApprovalPolicyEditor(bot: try XCTUnwrap(model.bots.first), model: model)
        await editor.load(); editor.mode = .approveAll
        let confirmation = try XCTUnwrap(editor.prepareHumanSave())
        await transport.corruptNextReceiptHash()
        await editor.saveHumanChoice(confirmation)
        XCTAssertEqual(editor.notice, .saveUnknown); XCTAssertNil(editor.lastReceipt)
        XCTAssertEqual(editor.pending?.input, confirmation.request.input)
        await editor.reconcile()
        XCTAssertEqual(editor.notice, .saved); XCTAssertNotNil(editor.lastReceipt)
        let writes = await transport.writes(); XCTAssertEqual(writes.count, 1)
        let effects = await transport.effects(); XCTAssertEqual(effects, 1)
    }

    func testLegacyUnavailableAndUnpairedConnectionNeverApplyLocalPolicyFallback() async throws {
        let transport = PolicySyntheticTransport()
        let model = await makeModel(transport)
        let editor = BotApprovalPolicyEditor(bot: try XCTUnwrap(model.bots.first), model: model)
        await transport.disablePolicyRoute()
        await editor.load()
        XCTAssertNil(editor.baseline); XCTAssertEqual(editor.notice, .unavailable); XCTAssertFalse(editor.canSave)
        let client = HostClient(baseURL: URL(string: "https://policy.example.invalid")!, accessPolicy: .unpairedHost, transport: transport)
        do {
            _ = try await client.updateBotApprovalPolicy(botID: "bot_policy_a", input: PatchBotApprovalPolicyInput(
                expectedHostId: "host_policy", clientRequestId: "synthetic-request", expectedRevision: 0, mode: .approveAll))
            XCTFail("Owner-only policy must not use an unpaired connection")
        } catch { XCTAssertEqual(error as? HostClientError, .forbidden) }
        let observed9 = await transport.writes().count
        XCTAssertEqual(observed9, 0)
        let unsupported = BotApprovalPolicy(hostId: "host_policy", botId: "bot_policy_a", ownerId: "owner_policy", mode: .approveAll,
                                             revision: 0, updatedAt: 1, receiptId: nil)
        XCTAssertFalse(unsupported.isValid)
    }

    private func makeModel(_ transport: PolicySyntheticTransport) async -> DexterAppModel {
        let model = DexterAppModel(client: HostClient(baseURL: URL(string: "http://127.0.0.1:54837")!, transport: transport), storage: PolicyMemoryStorage())
        await model.refresh()
        return model
    }
}

@MainActor private final class PolicyMemoryStorage: DexterAppStateStorage {
    private var data: Data?
    func readData() -> Data? { data }
    func writeData(_ data: Data) { self.data = data }
    func removeData() { data = nil }
}

private actor PolicySyntheticTransport: HTTPTransport {
    struct Write: Sendable { let path: String; let body: Data? }
    private var recorded: [Write] = []
    private var policyStates: [String: BotApprovalPolicy] = [:]
    private var receipts: [String: BotApprovalPolicyReceipt] = [:]
    private var effectCount = 0
    private var loseNextResponse = false
    private var rejectNextBeforeApply = false
    private var disabled = false
    private var corruptReplyHash = false
    func writes() -> [Write] { recorded }
    func effects() -> Int { effectCount }
    func loseResponseAfterApply() { loseNextResponse = true }
    func failBeforeApply() { rejectNextBeforeApply = true }
    func disablePolicyRoute() { disabled = true }
    func corruptNextReceiptHash() { corruptReplyHash = true }
    func advanceExternalPolicy() {
        policyStates["bot_policy_a"] = BotApprovalPolicy(hostId: "host_policy", botId: "bot_policy_a", ownerId: "owner_policy",
                                                        mode: .ask, revision: 1, updatedAt: 5, receiptId: "receipt_external")
    }
    private func state(_ botID: String) -> BotApprovalPolicy {
        policyStates[botID] ?? BotApprovalPolicy(hostId: "host_policy", botId: botID, ownerId: "owner_policy", mode: .ask,
                                                revision: 0, updatedAt: 1, receiptId: nil)
    }
    private func response<T: Encodable>(_ value: T) throws -> TransportResponse {
        TransportResponse(statusCode: 200, data: try JSONEncoder().encode(value))
    }
    private func objectResponse(_ value: [String: Any], status: Int = 200) throws -> TransportResponse {
        TransportResponse(statusCode: status, data: try JSONSerialization.data(withJSONObject: value))
    }
    func send(_ request: URLRequest) async throws -> TransportResponse {
        let path = request.url?.path ?? "", method = request.httpMethod ?? "GET"
        if method != "GET" { recorded.append(Write(path: path, body: request.httpBody)) }
        if path.contains("/approval-policy") {
            if disabled { return try objectResponse(["error": "not_found"], status: 404) }
            let botID = path.split(separator: "/")[2].description
            if path.contains("/receipts/") {
                let requestID = path.split(separator: "/").last!.description
                guard let receipt = receipts[botID + requestID] else { return try objectResponse(["error": "not_found"], status: 404) }
                return try response(receipt)
            }
            if method == "GET" { return try response(state(botID)) }
            guard let bytes = request.httpBody else { throw HostClientError.invalidRequest }
            let input = try JSONDecoder().decode(PatchBotApprovalPolicyInput.self, from: bytes)
            if rejectNextBeforeApply { rejectNextBeforeApply = false; return try objectResponse(["error": "synthetic_failure"], status: 500) }
            if let receipt = receipts[botID + input.clientRequestId] { return try response(receipt) }
            let previous = state(botID)
            guard previous.revision == input.expectedRevision, previous.hostId == input.expectedHostId else {
                return try objectResponse(["error": "conflict"], status: 409)
            }
            let id = "receipt_policy_\(effectCount + 1)"
            let next = BotApprovalPolicy(hostId: previous.hostId, botId: botID, ownerId: previous.ownerId,
                                         mode: input.mode, revision: previous.revision + 1, updatedAt: 2, receiptId: id)
            let canonical: [String: Any] = ["botId": botID, "ownerId": previous.ownerId, "expectedHostId": input.expectedHostId,
                                           "clientRequestId": input.clientRequestId, "expectedRevision": input.expectedRevision,
                                           "mode": input.mode.rawValue, "eligibleScopeVersion": input.eligibleScopeVersion]
            let hashBytes = try JSONSerialization.data(withJSONObject: canonical, options: [.sortedKeys, .withoutEscapingSlashes])
            let inputHash = SHA256.hash(data: hashBytes).map { String(format: "%02x", $0) }.joined()
            let receipt = BotApprovalPolicyReceipt(id: id, clientRequestId: input.clientRequestId, inputHash: inputHash,
                hostId: previous.hostId, botId: botID, ownerId: previous.ownerId, previous: previous, policy: next,
                revocationEffects: BotApprovalPolicyRevocationEffects(blockedActionIds: [], abortedActionIds: []), createdAt: 2)
            policyStates[botID] = next; receipts[botID + input.clientRequestId] = receipt; effectCount += 1
            if loseNextResponse { loseNextResponse = false; throw HostClientError.offline }
            if corruptReplyHash {
                corruptReplyHash = false
                return try response(BotApprovalPolicyReceipt(id: receipt.id, clientRequestId: receipt.clientRequestId,
                    inputHash: String(repeating: "b", count: 64), hostId: receipt.hostId, botId: receipt.botId, ownerId: receipt.ownerId,
                    previous: receipt.previous, policy: receipt.policy, revocationEffects: receipt.revocationEffects, createdAt: receipt.createdAt))
            }
            return try response(receipt)
        }
        switch path {
        case "/health": return try objectResponse(["protocolVersion": 1, "mode": "local-development", "engineRouting": "synthetic",
                                                     "remotePairing": "not_implemented", "hostId": "host_policy", "state": [:]])
        case "/v1/bots": return try objectResponse(["items": ["bot_policy_a", "bot_policy_b"].map {
            ["id": $0, "name": "Synthetic \($0)", "profileId": "profile_policy", "engine": "codex", "ownerId": "owner_policy", "createdAt": 1]
        }])
        default: return try objectResponse(["items": [], "nextCursor": 0])
        }
    }
}
#endif
