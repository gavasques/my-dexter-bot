import DexterHostClient
import Foundation
import XCTest
@testable import DexterAppCore

/// Synthetic receipts only: no host, preparation controller, helper, grant, route, policy write or TCC.
@MainActor final class MacSetupHandoffTests: XCTestCase {
    private let revision = String(repeating: "c", count: 64), requestDigest = String(repeating: "d", count: 64)
    private let epoch = UUID()
    @MainActor private final class Clock { var value: Int64 = 2_000 }

    private func context(host: String = "host-fixture", bot: String = "bot-fixture", thread: String = "thread-fixture",
                         generation: UInt64 = 1, scope: UUID? = nil) -> McpAuthorizationContext {
        .init(hostID: host, botID: bot, threadID: thread, hostAddress: "http://127.0.0.1:49181", composerScope: scope ?? epoch,
              hostGeneration: generation, threadGeneration: 1, readinessEpoch: 1)
    }
    private func action(state: ActionState = .succeeded, changes: [String: JSONValue] = [:], removing: String? = nil,
                        source: ActionAuthorizationSource = .exactOwner, input: [String: JSONValue]? = nil,
                        tool: String = "dexter.harness.mac.setup.request", destination: String = "dexter-harness-owner-proposals",
                        decidedBy: String? = "owner-fixture") -> Action {
        var result: [String: JSONValue] = ["kind": .string("mac_setup_handoff"), "target": .string("computer_access"),
            "hostId": .string("host-fixture"), "botId": .string("bot-fixture"), "threadId": .string("thread-fixture"),
            "actionId": .string("act-mac"), "requestHash": .string(requestDigest), "configurationRevision": .string(revision),
            "expiresAt": .integer(301_000)]
        result.merge(changes) { _, latest in latest }
        if let removing { result.removeValue(forKey: removing) }
        return Action(id: "act-mac", request: .init(botId: "bot-fixture", threadId: "thread-fixture", tool: tool, destination: destination,
            arguments: ["input": .object(input ?? ["expected_revision": .string(revision)])], idempotencyKey: "fixture-request"),
            requestHash: requestDigest, grantRevision: 1, state: state, createdAt: 500, updatedAt: 1_000,
            approvalExpiresAt: 60_000, decidedBy: state == .succeeded ? decidedBy : nil,
            result: state == .succeeded ? .object(result) : nil, reason: nil,
            authorization: state == .succeeded ? .init(source: source, ownerId: "owner-fixture") : nil)
    }

    func testReceiptDecodesOnlyTheFrozenValueFreeWire() throws {
        let handoff = try XCTUnwrap(action().macSetupHandoff)
        XCTAssertEqual(handoff.target, "computer_access")
        XCTAssertEqual(handoff.botId, "bot-fixture")
        XCTAssertEqual(handoff.configurationRevision, revision)
        // Extra or missing keys, other kinds/targets, malformed identities/digests and out-of-window expiry are refused.
        for bad: [String: JSONValue] in [["kind": .string("mcp_authorization_handoff")], ["target": .string("settings")],
                                         ["deviceId": .string("dev-1")], ["url": .string("dexter://settings/mac")],
                                         ["botId": .string("bot other")], ["requestHash": .string("ABC")],
                                         ["configurationRevision": .string(String(repeating: "C", count: 64))],
                                         ["expiresAt": .integer(301_001)], ["expiresAt": .integer(999)], ["expiresAt": .string("301000")]] {
            XCTAssertNil(action(changes: bad).macSetupHandoff, "\(bad)")
        }
        XCTAssertNil(action(removing: "configurationRevision").macSetupHandoff)
        // Bound to the original request: CAS token, action, hash, bot and thread must match the receipt.
        XCTAssertNil(action(changes: ["configurationRevision": .string(String(repeating: "e", count: 64))]).macSetupHandoff)
        XCTAssertNil(action(changes: ["actionId": .string("act-other")]).macSetupHandoff)
        XCTAssertNil(action(changes: ["requestHash": .string(revision)]).macSetupHandoff)
        XCTAssertNil(action(changes: ["botId": .string("bot-other")]).macSetupHandoff)
        XCTAssertNil(action(changes: ["threadId": .string("thread-other")]).macSetupHandoff)
        XCTAssertNil(action(input: [:]).macSetupHandoff)
        XCTAssertNil(action(input: ["expected_revision": .string(revision), "botId": .string("bot-fixture")]).macSetupHandoff)
        XCTAssertNil(action(input: ["expectedRevision": .string(revision)]).macSetupHandoff)
        XCTAssertNil(action(tool: "dexter.harness.mac.setup.status").macSetupHandoff)
        XCTAssertNil(action(destination: "dev-this-mac").macSetupHandoff)
        // Only an exact owner decision produces a navigable receipt.
        for source in [ActionAuthorizationSource.boundedGrant, .ownerPolicy, .ownerType, .threadPolicy] {
            XCTAssertNil(action(source: source).macSetupHandoff)
        }
        XCTAssertNil(action(decidedBy: "someone-else").macSetupHandoff)
        XCTAssertNil(action(decidedBy: nil).macSetupHandoff)
    }

    func testFreshLocalAllowPresentsOnceAndHistoryReloadRestartStayInert() throws {
        let scope = context()
        let coordinator = MacSetupHandoffCoordinator(now: { 2_000 })
        coordinator.receive(action(), context: scope, foreground: true)
        XCTAssertNil(coordinator.presentation, "Canonical history never navigates")
        XCTAssertTrue(coordinator.arm(action(state: .awaitingApproval), context: scope, foreground: true))
        coordinator.receive(action(state: .running), context: scope, foreground: true)
        XCTAssertNil(coordinator.presentation)
        coordinator.receive(action(), context: scope, foreground: true)
        let pending = try XCTUnwrap(coordinator.presentation)
        XCTAssertEqual(pending.handoff.botId, "bot-fixture")
        XCTAssertNotNil(coordinator.take(pending.id, context: scope, foreground: true))
        XCTAssertNil(coordinator.take(pending.id, context: scope, foreground: true), "A second window must not consume the same intent")
        coordinator.receive(action(), context: scope, foreground: true)
        XCTAssertNil(coordinator.presentation)
        XCTAssertFalse(coordinator.arm(action(state: .awaitingApproval), context: scope, foreground: true), "Consumed intents never re-arm")
        let restart = MacSetupHandoffCoordinator(now: { 2_000 })
        restart.receive(action(), context: scope, foreground: true)
        XCTAssertNil(restart.presentation)
        // Another tool never arms this coordinator, even on the same destination.
        XCTAssertFalse(MacSetupHandoffCoordinator(now: { 2_000 }).arm(action(state: .awaitingApproval, tool: "dexter.harness.mcp.authorize"),
                                                                    context: scope, foreground: true))
    }

    func testNonOwnerForgedAndChangedResultsNeverPresent() {
        let scope = context()
        for source in [ActionAuthorizationSource.boundedGrant, .ownerPolicy, .ownerType, .threadPolicy] {
            let coordinator = MacSetupHandoffCoordinator(now: { 2_000 })
            coordinator.arm(action(state: .awaitingApproval), context: scope, foreground: true)
            coordinator.receive(action(source: source), context: scope, foreground: true)
            XCTAssertNil(coordinator.presentation)
        }
        for bad: [String: JSONValue] in [["hostId": .string("host-other")], ["botId": .string("bot-other")],
                                         ["threadId": .string("thread-other")], ["actionId": .string("act-other")],
                                         ["deviceId": .string("dev-1")]] {
            let coordinator = MacSetupHandoffCoordinator(now: { 2_000 })
            coordinator.arm(action(state: .awaitingApproval), context: scope, foreground: true)
            coordinator.receive(action(changes: bad), context: scope, foreground: true)
            XCTAssertNil(coordinator.presentation, "\(bad)")
        }
        // A request that changed between Allow and the result (other input) is dropped.
        let changed = MacSetupHandoffCoordinator(now: { 2_000 })
        changed.arm(action(state: .awaitingApproval), context: scope, foreground: true)
        changed.receive(action(input: ["expected_revision": .string(String(repeating: "f", count: 64))]), context: scope, foreground: true)
        XCTAssertNil(changed.presentation)
    }

    func testForegroundContextGenerationExpiryDenyAndStopAreCheckedAtEachBoundary() throws {
        let clock = Clock(), scope = context()
        let background = MacSetupHandoffCoordinator(now: { clock.value })
        XCTAssertFalse(background.arm(action(state: .awaitingApproval), context: scope, foreground: false))
        background.arm(action(state: .awaitingApproval), context: scope, foreground: true)
        background.receive(action(), context: scope, foreground: false)
        XCTAssertNil(background.presentation)
        for changed in [context(host: "host-other"), context(bot: "bot-other"), context(thread: "thread-other"),
                        context(generation: 2), context(scope: UUID())] {
            let coordinator = MacSetupHandoffCoordinator(now: { clock.value })
            coordinator.arm(action(state: .awaitingApproval), context: scope, foreground: true)
            coordinator.receive(action(), context: changed, foreground: true)
            XCTAssertNil(coordinator.presentation)
        }
        // A proposal whose approval window already closed cannot arm.
        clock.value = 60_000
        XCTAssertFalse(MacSetupHandoffCoordinator(now: { clock.value }).arm(action(state: .awaitingApproval), context: scope, foreground: true))
        clock.value = 2_000
        let expired = MacSetupHandoffCoordinator(now: { clock.value })
        expired.arm(action(state: .awaitingApproval), context: scope, foreground: true)
        expired.receive(action(), context: scope, foreground: true)
        let item = try XCTUnwrap(expired.presentation)
        clock.value = 301_000
        XCTAssertNil(expired.take(item.id, context: scope, foreground: true))
        clock.value = 2_000
        let changedWindow = MacSetupHandoffCoordinator(now: { clock.value })
        changedWindow.arm(action(state: .awaitingApproval), context: scope, foreground: true)
        changedWindow.receive(action(), context: scope, foreground: true)
        let claim = try XCTUnwrap(changedWindow.presentation)
        XCTAssertNil(changedWindow.take(claim.id, context: context(generation: 2), foreground: true))
        XCTAssertNil(changedWindow.take(claim.id, context: scope, foreground: true), "A refused claim is not retried")
        let denied = MacSetupHandoffCoordinator(now: { clock.value })
        denied.arm(action(state: .awaitingApproval), context: scope, foreground: true)
        denied.abandon(actionID: "act-mac", hostID: "host-fixture")
        denied.receive(action(), context: scope, foreground: true)
        XCTAssertNil(denied.presentation)
        let stopped = MacSetupHandoffCoordinator(now: { clock.value })
        stopped.arm(action(state: .awaitingApproval), context: scope, foreground: true)
        stopped.invalidate(); stopped.receive(action(), context: scope, foreground: true)
        XCTAssertNil(stopped.presentation)
        let lost = MacSetupHandoffCoordinator(now: { clock.value })
        lost.arm(action(state: .awaitingApproval), context: scope, foreground: true)
        lost.receive(action(), context: nil, foreground: true)
        XCTAssertNil(lost.presentation)
    }

    func testApprovalCardNamesTheSetupHonestlyWithoutRawDestination() throws {
        let pending = ApprovalPresentation(action: action(state: .awaitingApproval))
        XCTAssertEqual(pending.title, "Configurar acesso ao Mac")
        XCTAssertEqual(pending.shortTarget, "Controle de tela")
        XCTAssertNil(pending.executionPlace, "Navigation to the owner's panel does not run or change anything on the base")
        XCTAssertTrue(pending.scopeExplanation?.contains("ainda não concede controle") == true)
        XCTAssertEqual(pending.readableFields, [], "The opaque configuration revision is technical metadata")
        XCTAssertEqual(pending.summaryFields.map(\.value), ["Painel Controle de tela"])
        XCTAssertFalse(pending.summaryFields.contains { $0.value.contains("dexter") || $0.value.contains("harness") })
        let summary = ApprovalSimpleSummary(action: action(state: .awaitingApproval), botName: "Alfa", locale: Locale(identifier: "pt-BR"))
        XCTAssertEqual(summary.purpose, "Configurar acesso ao Mac")
        XCTAssertEqual(summary.target, "Controle de tela para Alfa")
        XCTAssertTrue(summary.effect.contains("ainda não concede controle"))
        XCTAssertFalse([summary.purpose, summary.target, summary.effect].contains { $0.contains("dexter-harness-owner-proposals") })
        let english = ApprovalSimpleSummary(action: action(state: .awaitingApproval), locale: Locale(identifier: "en"))
        XCTAssertEqual(english.target, "Screen control for this bot")
        let completed = ApprovalPresentation(action: action())
        XCTAssertTrue(completed.resultExplanation.contains("nada foi concedido"))
        XCTAssertTrue(completed.resultExplanation.contains("Ajustes › Este Mac"), "History names where the panel lives; no time window claim")
        XCTAssertFalse(completed.resultExplanation.contains("minutos"))
        XCTAssertTrue(completed.readableResultFields.contains { $0.value == "Painel Controle de tela" })
        XCTAssertTrue(completed.readableResultFields.contains { $0.label.hasSuffix("Destino") && $0.value == "Acesso ao computador" })
        XCTAssertFalse(completed.readableResultFields.contains { $0.label.hasSuffix("Abre") }, "A generic target key is never labelled as opening something")
        // Without a valid receipt the generic completion text is kept; it never claims the panel can open.
        XCTAssertFalse(ApprovalPresentation(action: action(changes: ["botId": .string("bot-other")])).resultExplanation.contains("Controle de tela"))
    }
}
