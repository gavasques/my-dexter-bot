import DexterHostClient
import Foundation
import XCTest
@testable import DexterAppCore

/// UI R3: window routing keeps one target per settings window, and friendly labels never invent state.
@MainActor final class WindowRoutingR3Tests: XCTestCase {
    private let host = UUID()

    func testBotSettingsRoutesToExactBotAndSectionWithoutSwitchingSilently() {
        let router = DexterWindowRouter()
        router.requestBotSettings(botID: "a", section: .access, hostScope: host, hostAddress: "h")
        let first = router.botTarget
        XCTAssertEqual(first?.botID, "a"); XCTAssertEqual(first?.section, .access); XCTAssertNil(router.botRequest)

        router.botWindowAppeared()
        router.requestBotSettings(botID: "a", section: .memory, hostScope: host, hostAddress: "h")
        XCTAssertEqual(router.botTarget, first, "same bot keeps its editors")
        XCTAssertEqual(router.botRequest?.kind, .section(.memory))

        router.requestBotSettings(botID: "b", section: .profile, hostScope: host, hostAddress: "h")
        XCTAssertEqual(router.botTarget, first, "another bot waits for the visible editor to decide about drafts")
        guard let request = router.botRequest, case .switchTo(let next) = request.kind else { return XCTFail("switch request expected") }
        router.acceptBotSwitch(UUID())
        XCTAssertEqual(router.botTarget, first, "a stale token never switches")
        router.acceptBotSwitch(request.token)
        XCTAssertEqual(router.botTarget, next); XCTAssertNil(router.botRequest)

        router.requestBotSettings(botID: "b", section: .model, hostScope: UUID(), hostAddress: "h")
        guard case .switchTo = router.botRequest?.kind else { return XCTFail("another host is another target") }
        router.botWindowDisappeared()
        XCTAssertNil(router.botTarget); XCTAssertNil(router.botRequest); XCTAssertFalse(router.botWindowVisible)
    }

    func testTeamThreadAndErrorPresenterHaveSingleOwners() {
        let router = DexterWindowRouter()
        router.requestTeamSettings(teamID: nil, hostScope: host, hostAddress: "h")
        router.teamWindowAppeared()
        let draft = router.teamTarget
        router.requestTeamSettings(teamID: "t", hostScope: host, hostAddress: "h")
        XCTAssertEqual(router.teamTarget, draft)
        let token = try? XCTUnwrap(router.teamRequest?.token)
        router.declineTeamSwitch(token ?? UUID())
        XCTAssertEqual(router.teamTarget, draft); XCTAssertNil(router.teamRequest)

        router.requestThread(botID: "a", threadID: "x", hostScope: host, hostAddress: "h")
        let request = try? XCTUnwrap(router.threadRequest)
        XCTAssertNil(router.takeThreadRequest(UUID()))
        XCTAssertEqual(router.takeThreadRequest(request?.token ?? UUID())?.threadID, "x")
        XCTAssertNil(router.takeThreadRequest(request?.token ?? UUID()), "consumed once")

        router.windowBecameKey(.settings)
        XCTAssertEqual(router.errorPresenter, .settings)
        router.windowClosed(.botSettings)
        XCTAssertEqual(router.errorPresenter, .settings)
        router.windowClosed(.settings)
        XCTAssertEqual(router.errorPresenter, .main)
    }

    func testEngineReadinessNeverClaimsSignedIn() throws {
        let json = #"[{"id":"claude","available":true,"models":[],"defaultModel":null,"reasoningEfforts":[],"speeds":[],"installed":true,"adapterSupported":true},{"id":"codex","available":false,"models":[],"defaultModel":null,"reasoningEfforts":[],"speeds":[],"installed":false,"adapterSupported":true},{"id":"grok","available":false,"models":[],"defaultModel":null,"reasoningEfforts":[],"speeds":[],"installed":true,"adapterSupported":false},{"id":"muse","available":false,"models":[],"defaultModel":null,"reasoningEfforts":[],"speeds":[],"installed":true,"adapterSupported":true}]"#
        let catalog = try JSONDecoder().decode([EngineCatalogEntry].self, from: Data(json.utf8))
        func readiness(_ id: String) -> EngineReadiness { EngineReadiness(entry: catalog.first { $0.id == id }) }
        XCTAssertEqual(readiness("claude"), .availableLoginUnconfirmed)
        XCTAssertEqual(readiness("codex"), .notFound)
        XCTAssertEqual(readiness("grok"), .foundUnsupported)
        XCTAssertEqual(readiness("muse"), .foundUnavailable)
        XCTAssertEqual(readiness("antigravity"), .notReported)
        for state in [EngineReadiness.notReported, .notFound, .foundUnsupported, .foundUnavailable, .availableLoginUnconfirmed] {
            XCTAssertFalse(state.label().localizedCaseInsensitiveContains("pront"), state.label())
        }
        XCTAssertTrue(EngineReadiness.availableLoginUnconfirmed.label().contains("login não confirmado"))
        XCTAssertEqual(EngineReadiness.preferredEngine(in: catalog), .claude)
        XCTAssertEqual(EngineReadiness.preferredEngine(in: Array(catalog.dropFirst())), .grok, "found before not found")
        XCTAssertNil(EngineReadiness.preferredEngine(in: []))
    }

    func testFriendlyLabelsKeepUnknownValuesVerbatim() {
        XCTAssertEqual(EngineChoiceLabel.effort("xhigh"), "Muito alto")
        XCTAssertEqual(EngineChoiceLabel.effort("custom-9"), "custom-9")
        XCTAssertEqual(EngineChoiceLabel.speed("fast"), "Rápida")
        XCTAssertEqual(EngineChoiceLabel.speed("turbo-x"), "turbo-x")
        XCTAssertEqual(DeviceToolLabel.title("mac.unknown.tool"), "mac.unknown.tool")
        XCTAssertEqual(DeviceToolLabel.policy(nil), "Sem decisão")
        XCTAssertEqual(DeviceToolLabel.policy("ask"), "Pede aprovação")
        XCTAssertEqual(DelegationStateLabel.title(.unknown), "Resultado não confirmado")

        let unknown = TurnOutcomePresentation(state: .unknown, code: nil)
        XCTAssertEqual(unknown.suggestion, .refreshConversation)
        XCTAssertTrue(unknown.detail.contains("Nada será reenviado"))
        XCTAssertEqual(TurnOutcomePresentation(state: .failed, code: "not_installed").suggestion, .chooseModel)
        XCTAssertEqual(TurnOutcomePresentation(state: .failed, code: "authentication_required").suggestion, .none)
        let other = TurnOutcomePresentation(state: .failed, code: "something_new")
        XCTAssertEqual(other.title, "A engine encerrou esta resposta com erro.")
        XCTAssertFalse(other.title.contains("something_new"), "codes stay in details")
    }
}
