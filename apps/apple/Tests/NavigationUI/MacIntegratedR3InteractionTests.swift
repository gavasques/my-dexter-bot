import AppKit
import Foundation
import XCTest
import DexterHostClient
@testable import DexterAppCore
@testable import DexterNavigationUI

/// No window is created or driven. Compiles RootView + ChatView and exercises their actual
/// native key adapter/button and production reservation against AppModel/HostClient HTTP requests.
@MainActor final class MacIntegratedR3InteractionTests: XCTestCase {
    func testArrowsAutoRepeatEscapeReturnAndSidebarScopeChangeProduceZeroPOSTs() async throws {
        let (model, transport, action) = try await fixture()
        defer { model.closeThreadPresentation() }
        let keyView = MacApprovalReviewKeyView()
        let gate = IntegratedR3Gate(model: model, action: action)
        keyView.eligible = true; keyView.intent = { intent, _ in gate.handle(intent) }
        for repeated in [false, true] {
            for code: UInt16 in [125, 126, 36, 76] {
                XCTAssertTrue(keyView.handle(event(code, repeatKey: repeated), focused: true))
            }
        }
        XCTAssertTrue(keyView.handle(event(53), focused: true))
        keyView.eligible = false
        XCTAssertTrue(keyView.handle(event(35, characters: "p", flags: [.command, .shift], repeatKey: true), focused: true))
        XCTAssertFalse(keyView.handle(event(35, characters: "p", flags: [.command, .shift]), focused: false))
        let next = try XCTUnwrap(model.presentThread("r3-thread-b", for: "r3-bot"))
        await model.loadPresentedThread("r3-thread-b", generation: next)
        gate.handle(.decide(.allow)) // old review scope cannot authorize a new sidebar destination
        await gate.task?.value
        let requests = await transport.requests
        XCTAssertTrue(requests.allSatisfy { $0.httpMethod == "GET" })
    }

    func testExactShortcutAndNativeButtonEachDecideOnceWithOriginalHashNoExtraFields() async throws {
        for decision in [ApprovalDecision.allow, .deny] {
            let (model, transport, action) = try await fixture()
            let gate = IntegratedR3Gate(model: model, action: action)
            let keyView = MacApprovalReviewKeyView(); keyView.eligible = true
            keyView.intent = { intent, _ in gate.handle(intent) }
            let character = decision == .allow ? "p" : "d"
            XCTAssertTrue(keyView.handle(event(decision == .allow ? 35 : 2, characters: character, flags: [.command, .shift]), focused: true))
            // A second key or button event in the same runloop cannot schedule another POST.
            keyView.handle(event(35, characters: "p", flags: [.command, .shift], repeatKey: true), focused: true)
            let button = MacExactApprovalNSButton(title: "Synthetic approval", target: nil, action: nil)
            button.callback = { _ in gate.handle(.decide(decision)) }
            button.activate()
            button.keyDown(with: event(36)); button.keyDown(with: event(125, repeatKey: true))
            XCTAssertFalse(button.performKeyEquivalent(with: event(36)))
            await gate.task?.value
            let posts = await transport.requests.filter { $0.httpMethod == "POST" }
            XCTAssertEqual(posts.count, 1)
            XCTAssertEqual(posts.first?.url?.path, "/v1/actions/r3-action/decisions")
            let body = try XCTUnwrap(try JSONSerialization.jsonObject(with: try XCTUnwrap(posts.first?.httpBody)) as? [String: String])
            XCTAssertEqual(body, ["decision": decision.rawValue, "requestHash": String(repeating: "c", count: 64)])
            model.closeThreadPresentation()
        }
        // Native button's intentional action independently exercises the same gate.
        let (model, transport, action) = try await fixture()
        let gate = IntegratedR3Gate(model: model, action: action)
        let button = MacExactApprovalNSButton(title: "Synthetic approval", target: nil, action: nil)
        button.callback = { _ in gate.handle(.decide(.allow)) }; button.activate(); button.activate()
        await gate.task?.value
        let posts = await transport.requests.filter { $0.httpMethod == "POST" }; XCTAssertEqual(posts.count, 1)
        model.closeThreadPresentation()
    }

    func testExtraModifiersUnknownKeysAndInFlightNeverDecide() {
        for extra: NSEvent.ModifierFlags in [.option, .control] {
            XCTAssertEqual(ApprovalReviewIntent.route(.character("p"), command: true, shift: true,
                option: extra == .option, control: extra == .control, repeated: false, focused: true, eligible: true), .ignore)
        }
        XCTAssertEqual(ApprovalReviewIntent.route(.character("p"), command: true, shift: true,
            option: false, control: false, repeated: false, focused: true, eligible: false), .consume)
        XCTAssertEqual(ApprovalReviewIntent.route(.enter, command: false, shift: false,
            option: false, control: false, repeated: true, focused: true, eligible: true), .consume)
    }

    func testNativeCreateMenuHasStableLabelIntrinsicHitAreaAndOnlyExistingRoutes() {
        let control = MacSidebarCreatePopUp(frame: NSRect(x: 0, y: 0, width: 32, height: 32), pullsDown: true)
        XCTAssertEqual(control.intrinsicContentSize, NSSize(width: 32, height: 32))
        XCTAssertEqual(control.bounds.size, NSSize(width: 32, height: 32))
        XCTAssertEqual(control.accessibilityLabel(), "Criar bot ou time")
        var bots = 0, teams = 0
        control.createBot = { bots += 1 }; control.createTeam = { teams += 1 }
        control.newBot(); control.newTeam(); XCTAssertEqual(bots + teams, 0)
        control.botAllowed = true; control.teamAllowed = true
        control.newBot(); control.newTeam(); XCTAssertEqual(bots, 1); XCTAssertEqual(teams, 1)
    }

    func testReservationRejectsChangedHashBasePresentationAndExpiredSnapshot() async throws {
        let (model, _, action) = try await fixture()
        defer { model.closeThreadPresentation() }
        var gate = ApprovalDecisionGate()
        let scope = model.nativeComposerScope, generation = model.threadPresentationGeneration
        var raw = try XCTUnwrap(try JSONSerialization.jsonObject(with: JSONEncoder().encode(action)) as? [String: Any])
        raw["requestHash"] = String(repeating: "d", count: 64)
        let changed = try JSONDecoder().decode(Action.self, from: JSONSerialization.data(withJSONObject: raw))
        XCTAssertFalse(gate.reserve(action, expectedHostScope: scope, currentHostScope: scope,
            expectedGeneration: generation, currentGeneration: generation, visibleThread: "r3-thread-a",
            selectedThread: "r3-thread-a", currentAction: changed, hostAvailable: true, atMilliseconds: 1))
        for (currentScope, currentGeneration, selectedThread, available) in [
            (UUID(), generation, "r3-thread-a", true), (scope, generation + 1, "r3-thread-a", true),
            (scope, generation, "r3-thread-b", true), (scope, generation, "r3-thread-a", false)] {
            XCTAssertFalse(gate.reserve(action, expectedHostScope: scope, currentHostScope: currentScope,
                expectedGeneration: generation, currentGeneration: currentGeneration, visibleThread: "r3-thread-a",
                selectedThread: selectedThread, currentAction: action, hostAvailable: available, atMilliseconds: 1))
        }
        raw["approvalExpiresAt"] = 10
        let expired = try JSONDecoder().decode(Action.self, from: JSONSerialization.data(withJSONObject: raw))
        XCTAssertFalse(gate.reserve(expired, expectedHostScope: scope, currentHostScope: scope,
            expectedGeneration: generation, currentGeneration: generation, visibleThread: "r3-thread-a",
            selectedThread: "r3-thread-a", currentAction: expired, hostAvailable: true, atMilliseconds: 10))
        XCTAssertTrue(gate.actionIDs.isEmpty)
    }

    private func event(_ code: UInt16, characters: String = "", flags: NSEvent.ModifierFlags = [], repeatKey: Bool = false) -> NSEvent {
        NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: 1, windowNumber: 0,
            context: nil, characters: characters, charactersIgnoringModifiers: characters, isARepeat: repeatKey, keyCode: code)!
    }
    private func fixture() async throws -> (DexterAppModel, IntegratedR3Transport, Action) {
        let transport = IntegratedR3Transport()
        let model = DexterAppModel(client: HostClient(baseURL: URL(string: "http://127.0.0.1:49216")!, transport: transport), storage: IntegratedR3Storage())
        await model.refresh(); XCTAssertTrue(model.isOnline)
        model.selectBot(id: "r3-bot"); await model.refresh()
        _ = try XCTUnwrap(model.presentThread("r3-thread-a", for: "r3-bot"))
        return (model, transport, try XCTUnwrap(model.actions.first))
    }
}

@MainActor private final class IntegratedR3Gate {
    let model: DexterAppModel; let action: Action; let scope: UUID
    let generation: UInt64
    var reservation = ApprovalDecisionGate(); var task: Task<Void, Never>?
    init(model: DexterAppModel, action: Action) { self.model = model; self.action = action; scope = model.nativeComposerScope; generation = model.threadPresentationGeneration }
    func handle(_ intent: ApprovalReviewIntent) {
        guard case .decide(let decision) = intent,
              reservation.reserve(action, expectedHostScope: scope, currentHostScope: model.nativeComposerScope,
                expectedGeneration: generation, currentGeneration: model.threadPresentationGeneration,
                visibleThread: action.request.threadId, selectedThread: model.selectedThreadID,
                currentAction: model.actions.first(where: { $0.id == action.id }), hostAvailable: model.canUseHost && model.isOnline,
                atMilliseconds: Int64(Date().timeIntervalSince1970 * 1000)) else { return }
        task = Task { await model.decide(action, as: decision); reservation.release(action.id) }
    }
}
@MainActor private final class IntegratedR3Storage: DexterAppStateStorage {
    var bytes: Data?
    func readData() -> Data? { bytes }
    func writeData(_ data: Data) { bytes = data }
    func removeData() { bytes = nil }
}
private actor IntegratedR3Transport: HTTPTransport {
    private(set) var requests: [URLRequest] = []
    private var state = "awaiting_approval"
    func send(_ request: URLRequest) async throws -> TransportResponse {
        requests.append(request); let path = request.url!.path
        let body: [String: Any]
        switch path {
        case "/health": body = ["protocolVersion": 1, "mode": "local-development", "engineRouting": "synthetic", "remotePairing": "not_implemented", "hostId": "synthetic-r3-ui", "state": [:]]
        case "/v1/bots": body = ["items": [["id": "r3-bot", "name": "Synthetic R3", "profileId": "r3-profile", "engine": "claude", "ownerId": "r3-owner", "createdAt": 1]]]
        case "/v1/bots/r3-bot/threads": body = ["items": ["r3-thread-a", "r3-thread-b"].map { ["id": $0, "botId": "r3-bot", "createdAt": 1] }]
        case "/v1/events": body = ["items": ["r3-thread-a", "r3-thread-b"].enumerated().map { i, id in
            ["id": "r3-event-\(i)", "cursor": i + 1, "kind": "thread.created", "botId": "r3-bot", "entityId": id, "createdAt": 1] as [String: Any]
        }, "nextCursor": 2]
        case "/v1/threads/r3-thread-a", "/v1/threads/r3-thread-b": body = ["id": path.hasSuffix("r3-thread-a") ? "r3-thread-a" : "r3-thread-b", "botId": "r3-bot", "createdAt": 1]
        case "/v1/teams", "/v1/threads/r3-thread-b/turns", "/v1/threads/r3-thread-b/messages": body = ["items": [], "nextCursor": 0]
        case "/v1/actions": body = ["items": [action()]]
        case "/v1/actions/r3-action": body = action()
        case "/v1/actions/r3-action/continuation": body = ["continuation": NSNull()]
        case "/v1/actions/r3-action/decisions":
            let input = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
            state = input["decision"] as? String == "allow" ? "succeeded" : "denied"; body = action()
        default: throw HostClientError.notFound
        }
        return TransportResponse(statusCode: 200, data: try JSONSerialization.data(withJSONObject: body))
    }
    private func action() -> [String: Any] {
        ["id": "r3-action", "request": ["botId": "r3-bot", "threadId": "r3-thread-a", "tool": "dexter.harness.files.write", "destination": "synthetic-workspace", "arguments": ["input": ["path": "synthetic.txt", "text": "synthetic text"]], "idempotencyKey": "r3-ui-exact"],
         "requestHash": String(repeating: "c", count: 64), "grantRevision": 3, "state": state,
         "createdAt": 1, "updatedAt": state == "awaiting_approval" ? 1 : 2, "reason": state == "denied" ? "user_denied" : NSNull()]
    }
}
