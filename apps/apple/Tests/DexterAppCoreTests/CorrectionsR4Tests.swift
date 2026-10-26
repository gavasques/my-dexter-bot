import DexterHostClient
import Foundation
import XCTest
@testable import DexterAppCore

/// UI R4: receipt effects in both directions without zero counts, stop choices grouped only by a confirmed origin with
/// distinct labels, window targets bound to their base, and the full registration fields on the MCP card.
@MainActor final class CorrectionsR4Tests: XCTestCase {
    func testAccessEffectsReadBothDirectionsAndOmitZeroCounts() throws {
        XCTAssertNil(AccessChangeEffectsPresentation.accessSentence(enabled: true, blocked: 0, stopped: 0, portuguese: true))
        XCTAssertNil(AccessChangeEffectsPresentation.accessSentence(enabled: false, blocked: 0, stopped: 0, portuguese: false))

        let enabledBlocked = try XCTUnwrap(AccessChangeEffectsPresentation.accessSentence(enabled: true, blocked: 1, stopped: 0, portuguese: true))
        XCTAssertTrue(enabledBlocked.contains("1 pedido deste tipo"), enabledBlocked)
        XCTAssertTrue(enabledBlocked.contains("precisará pedir de novo"), enabledBlocked)
        XCTAssertFalse(enabledBlocked.contains("parada"), "no stop sentence without a stopped action")
        XCTAssertFalse(enabledBlocked.contains("0 "), enabledBlocked)

        let enabledStopped = try XCTUnwrap(AccessChangeEffectsPresentation.accessSentence(enabled: true, blocked: 0, stopped: 2, portuguese: true))
        XCTAssertTrue(enabledStopped.contains("2 ações em andamento"), enabledStopped)
        XCTAssertTrue(enabledStopped.contains("parcial"), enabledStopped)
        XCTAssertFalse(enabledStopped.contains("bloquead"), "no blocked sentence without a blocked action")

        let disabledBoth = try XCTUnwrap(AccessChangeEffectsPresentation.accessSentence(enabled: false, blocked: 3, stopped: 1, portuguese: false))
        XCTAssertTrue(disabledBoth.contains("3 actions that had not started were blocked"), disabledBoth)
        XCTAssertTrue(disabledBoth.contains("Stop requested for 1 running action"), disabledBoth)
        XCTAssertTrue(disabledBoth.hasSuffix("What already happened is not undone."), disabledBoth)

        XCTAssertNil(AccessChangeEffectsPresentation.policySentence(blocked: 0, stopped: 0, portuguese: true))
        let policy = try XCTUnwrap(AccessChangeEffectsPresentation.policySentence(blocked: 0, stopped: 1, portuguese: true))
        XCTAssertFalse(policy.contains("0 ação"), policy)
        XCTAssertTrue(policy.contains("Pedido de parada enviado para 1 ação em andamento."), policy)
    }

    func testStopChoicesMergeOnlyConfirmedOriginsAndLabelsNeverRepeat() {
        let a = EffectStopCandidate(actionID: "act_aaaaaaaa1111", title: "Executar comando", createdAt: 1_000)
        let b = EffectStopCandidate(actionID: "act_bbbbbbbb2222", title: "Executar comando", createdAt: 1_000)
        let c = EffectStopCandidate(actionID: "act_cccccccc3333", title: "Salvar arquivo", createdAt: 2_000)

        // Unconfirmed: one line per action, never presented as separate requests.
        let unconfirmed = EffectStopGrouping.choices([a, b], confirmedOrigins: [:])
        XCTAssertEqual(unconfirmed.count, 2)
        XCTAssertTrue(unconfirmed.allSatisfy { $0.originTurnID == nil && $0.actionIDs.count == 1 })
        let labels = EffectStopGrouping.labels(unconfirmed, time: { _ in "22:10:05" }, portuguese: true)
        XCTAssertEqual(Set(labels.values).count, 2, "identical title and time still get distinct labels")
        XCTAssertTrue(labels.values.allSatisfy { $0.contains("origem não confirmada") })

        // The same confirmed origin is one stop: the host stops every action of that origin together.
        let same = EffectStopGrouping.choices([a, b], confirmedOrigins: [a.actionID: "turn_origin_1", b.actionID: "turn_origin_1"])
        XCTAssertEqual(same.count, 1)
        XCTAssertEqual(same.first?.actionIDs, [a.actionID, b.actionID])
        XCTAssertEqual(same.first?.originTurnID, "turn_origin_1")

        // Two confirmed origins plus an unconfirmed action: three distinct choices, oldest first.
        let mixed = EffectStopGrouping.choices([c, a, b], confirmedOrigins: [a.actionID: "turn_1", c.actionID: "turn_2"])
        XCTAssertEqual(mixed.map(\.originTurnID), [nil, "turn_1", "turn_2"], "oldest first; ties keep a stable order")
        let mixedLabels = EffectStopGrouping.labels(mixed, time: { "t\($0)" }, portuguese: false)
        XCTAssertEqual(Set(mixedLabels.values).count, 3)
        XCTAssertEqual(mixedLabels["origin:turn_2"], "Request from t2000 · “Salvar arquivo” · 1 action")
    }

    func testWindowTargetsNeverAnswerForAnotherBase() {
        let base = UUID(), other = UUID()
        let router = DexterWindowRouter()
        router.requestBotSettings(botID: "same", section: .access, hostScope: base, hostAddress: "h")
        router.botWindowAppeared()
        let target = router.botTarget
        XCTAssertEqual(target?.matches(hostScope: base, hostAddress: "h"), true)
        XCTAssertEqual(target?.matches(hostScope: other, hostAddress: "h"), false)
        XCTAssertEqual(target?.matches(hostScope: base, hostAddress: "h2"), false)

        // The same bot ID on another base is never a section change of the visible editor.
        router.requestBotSettings(botID: "same", section: .memory, hostScope: other, hostAddress: "h")
        XCTAssertEqual(router.botTarget, target)
        guard let request = router.botRequest, case .switchTo(let next) = request.kind else { return XCTFail("switch expected") }
        XCTAssertEqual(next.hostScope, other)
        router.finishBotRequest(request.token)
        XCTAssertEqual(router.botTarget, target, "a declined switch keeps the old target")
        XCTAssertNil(router.botRequest)

        router.requestTeamSettings(teamID: nil, hostScope: base, hostAddress: "h")
        router.teamWindowAppeared()
        let team = router.teamTarget
        router.requestTeamSettings(teamID: nil, hostScope: other, hostAddress: "h")
        XCTAssertEqual(router.teamTarget, team, "a new team on another base waits for a decision")
        XCTAssertEqual(router.teamRequest?.target.hostScope, other)
        XCTAssertEqual(router.teamRequest?.target.matches(hostScope: base, hostAddress: "h"), false)
    }

    func testRegistrationCardShowsLoginAndIDAtFirstLevel() throws {
        let definition = #"{"id":"http-6e254a","name":"Pesquisa","auth":"broker","transport":{"type":"streamable_http","url":"https://mcp.example.test/mcp"}}"#
        let action = Action(id: "act-r4", request: ActionRequest(botId: "bot-1", threadId: "thread-1", tool: "dexter.harness.mcp.add_http",
            destination: "dexter-harness-owner-proposals", arguments: ["definitionJson": .string(definition)], idempotencyKey: "k-1"),
            requestHash: "h", grantRevision: 1, state: .awaitingApproval, createdAt: 1, updatedAt: 1, approvalExpiresAt: nil,
            decidedBy: nil, result: nil, reason: nil)
        let summary = ApprovalPresentation(action: action).summaryFields
        XCTAssertEqual(summary.map(\.id), ["/name", "/url", "/auth", "/server_id"])
        XCTAssertEqual(summary.first { $0.id == "/auth" }?.value, "Token de acesso guardado no 1Password")
        XCTAssertEqual(summary.first { $0.id == "/server_id" }?.value, "http-6e254a")
    }
}
