import DexterHostClient
import Foundation
import XCTest
@testable import DexterAppCore

@MainActor
final class BotCreationOutcomeTests: XCTestCase {
    private let recipe = BotAvatarAppearance(body: .bean, eyes: .focused, colorHex: "#A45BCC", finish: .glass, motion: .subtle)

    private func connectedModel(_ wire: BotCreationSyntheticTransport) async -> DexterAppModel {
        let model = DexterAppModel(client: HostClient(baseURL: URL(string: "http://127.0.0.1:49831")!, transport: wire),
            storage: BotCreationMemoryStorage(), pairing: PairedHostOnboarding(journal: UnavailableClientClaimJournal(),
                storage: EphemeralPairedHostStateStorage()))
        await model.refresh()
        XCTAssertTrue(model.canUseHost)
        XCTAssertTrue(model.isOnline, "The synthetic canonical health and list must be admitted before creation")
        XCTAssertTrue(model.bots.isEmpty)
        return model
    }

    func testCreatedBotReceivesRecipeInTheOnlyPostAndAppearsInModelAndHostList() async throws {
        let wire = BotCreationSyntheticTransport(outcome: .success)
        let model = await connectedModel(wire)
        let result = await model.createBot(name: "Synthetic mascot", engine: .codex, avatarAppearance: recipe)
        XCTAssertEqual(result, .created(botID: BotCreationSyntheticTransport.createdID))
        XCTAssertEqual(model.bots.count, 1)
        XCTAssertEqual(model.bots.first?.avatarAppearance, recipe)
        XCTAssertEqual(model.selectedBotID, BotCreationSyntheticTransport.createdID)
        let posts = await wire.posts()
        XCTAssertEqual(posts.count, 1)
        let input = try JSONDecoder().decode(CreateBotInput.self, from: XCTUnwrap(posts.first?.httpBody))
        XCTAssertEqual(input.name, "Synthetic mascot")
        XCTAssertEqual(input.engine, .codex)
        XCTAssertEqual(input.profileId, "default")
        XCTAssertEqual(input.avatarAppearance, recipe)
        XCTAssertNil(input.avatarImageId)
        await model.refresh()
        XCTAssertEqual(model.bots.map(\.id), [BotCreationSyntheticTransport.createdID])
        XCTAssertEqual(model.bots.first?.avatarAppearance, recipe)
        let afterRefresh = await wire.posts()
        XCTAssertEqual(afterRefresh.count, 1, "List reconciliation must not create a second bot")
        model.useFixture()
    }

    func testDefinitiveClientRefusalsReturnRefusedWithoutRetryOrOptimisticBot() async {
        for status in [400, 403, 404, 409, 413, 415] {
            let wire = BotCreationSyntheticTransport(outcome: .http(status))
            let model = await connectedModel(wire)
            let result = await model.createBot(name: "Refused mascot", engine: .codex, avatarAppearance: recipe)
            XCTAssertEqual(result, .refused, "HTTP \(status)")
            XCTAssertTrue(model.bots.isEmpty)
            XCTAssertNil(model.selectedBotID)
            let posts = await wire.posts(), persisted = await wire.persistedBots()
            XCTAssertEqual(posts.count, 1, "HTTP \(status) must not retry")
            XCTAssertTrue(persisted.isEmpty)
            model.useFixture()
        }
    }

    func testServerFailuresIncludingNotReadyAreUnconfirmedAndNeverRepeatThePost() async {
        for status in [500, 502, 503] {
            let wire = BotCreationSyntheticTransport(outcome: .http(status))
            let model = await connectedModel(wire)
            let result = await model.createBot(name: "Unconfirmed mascot", engine: .codex, avatarAppearance: recipe)
            XCTAssertEqual(result, .unconfirmed, "HTTP \(status) does not prove the bot was not created")
            XCTAssertTrue(model.bots.isEmpty)
            XCTAssertNil(model.selectedBotID)
            let posts = await wire.posts()
            XCTAssertEqual(posts.count, 1, "Server failure must not retry")
            model.useFixture()
        }
    }

    func testLostResponseRemainsUnconfirmedAndReadingTheHostListRecoversTheSingleEffect() async {
        let wire = BotCreationSyntheticTransport(outcome: .lostAfterCreation)
        let model = await connectedModel(wire)
        let result = await model.createBot(name: "Lost reply mascot", engine: .codex, avatarAppearance: recipe)
        XCTAssertEqual(result, .unconfirmed)
        XCTAssertTrue(model.bots.isEmpty, "An unconfirmed response must not produce an optimistic bot")
        let persisted = await wire.persistedBots()
        XCTAssertEqual(persisted.count, 1, "Synthetic effect committed before transport lost its response")
        await model.refresh()
        XCTAssertEqual(model.bots.map(\.id), [BotCreationSyntheticTransport.createdID])
        XCTAssertEqual(model.bots.first?.avatarAppearance, recipe)
        let posts = await wire.posts()
        XCTAssertEqual(posts.count, 1, "Recovery is a read, not a repeated mutation")
        model.useFixture()
    }

    func testContractAndRecipeResponseMismatchAreUnconfirmedWithoutFallbackOrRetry() async {
        for outcome in [BotCreationSyntheticTransport.Outcome.malformed, .unsupportedRecipe, .missingRecipe, .changedRecipe] {
            let wire = BotCreationSyntheticTransport(outcome: outcome)
            let model = await connectedModel(wire)
            let result = await model.createBot(name: "Mismatched mascot", engine: .codex, avatarAppearance: recipe)
            XCTAssertEqual(result, .unconfirmed, "\(outcome)")
            XCTAssertTrue(model.bots.isEmpty)
            XCTAssertNil(model.selectedBotID)
            let posts = await wire.posts()
            XCTAssertEqual(posts.count, 1)
            await model.refresh()
            XCTAssertEqual(model.bots.count, 1, "Only the later canonical read can confirm the synthetic effect")
            XCTAssertEqual(model.bots.first?.avatarAppearance, recipe)
            let afterRead = await wire.posts()
            XCTAssertEqual(afterRead.count, 1)
            model.useFixture()
        }
    }

    func testCancellationAfterDispatchIsUnconfirmedAndDoesNotRetry() async {
        let wire = BotCreationSyntheticTransport(outcome: .hold)
        let model = await connectedModel(wire)
        let operation = Task { await model.createBot(name: "Cancelled mascot", engine: .codex, avatarAppearance: recipe) }
        await wire.waitUntilHeld()
        operation.cancel()
        let result = await operation.value
        XCTAssertEqual(result, .unconfirmed)
        XCTAssertTrue(model.bots.isEmpty)
        let posts = await wire.posts()
        XCTAssertEqual(posts.count, 1)
        model.useFixture()
    }

    func testChangedHostGenerationCannotAdoptALateCreatedBot() async throws {
        let wire = BotCreationSyntheticTransport(outcome: .hold)
        let model = await connectedModel(wire)
        let operation = Task { await model.createBot(name: "Late mascot", engine: .codex, avatarAppearance: recipe) }
        await wire.waitUntilHeld()
        model.useFixture()
        let fixtureIDs = model.bots.map(\.id)
        try await wire.releaseSuccessfulCreation()
        let result = await operation.value
        XCTAssertEqual(result, .unconfirmed)
        XCTAssertTrue(model.isFixture)
        XCTAssertEqual(model.bots.map(\.id), fixtureIDs)
        XCTAssertFalse(model.bots.contains { $0.id == BotCreationSyntheticTransport.createdID })
        let posts = await wire.posts()
        XCTAssertEqual(posts.count, 1)
    }

    func testUnavailableHostAndInvalidRecipeAreRefusedBeforeAnyPost() async {
        let wire = BotCreationSyntheticTransport(outcome: .success)
        let model = await connectedModel(wire)
        let invalid = BotAvatarAppearance(version: 2, body: .round, eyes: .oval, colorHex: "#ABCDEF", finish: .flat, motion: .none)
        let invalidResult = await model.createBot(name: "Invalid recipe", engine: .codex, avatarAppearance: invalid)
        XCTAssertEqual(invalidResult, .refused)
        XCTAssertTrue(model.bots.isEmpty)
        model.useFixture()
        let unavailableResult = await model.createBot(name: "Unavailable host", engine: .codex, avatarAppearance: recipe)
        XCTAssertEqual(unavailableResult, .refused)
        let posts = await wire.posts()
        XCTAssertTrue(posts.isEmpty)
    }
}

@MainActor
private final class BotCreationMemoryStorage: DexterAppStateStorage {
    private var data: Data?
    func readData() -> Data? { data }
    func writeData(_ data: Data) { self.data = data }
    func removeData() { data = nil }
}

/// In-memory HTTP protocol fixture. No network, engine, personal preferences or credential storage is used.
private actor BotCreationSyntheticTransport: HTTPTransport {
    enum Outcome: Sendable { case success, http(Int), lostAfterCreation, malformed, unsupportedRecipe, missingRecipe, changedRecipe, hold }
    static let createdID = "bot_creation_outcome_r1"
    private let outcome: Outcome
    private var captured: [URLRequest] = []
    private var bots: [Bot] = []
    private var held: CheckedContinuation<TransportResponse, Error>?
    private var arrival: [CheckedContinuation<Void, Never>] = []
    private var heldInput: CreateBotInput?
    init(outcome: Outcome) { self.outcome = outcome }
    func posts() -> [URLRequest] { captured.filter { $0.httpMethod == "POST" } }
    func persistedBots() -> [Bot] { bots }
    func waitUntilHeld() async {
        if held != nil { return }
        await withCheckedContinuation { arrival.append($0) }
    }
    private func response(_ object: [String: Any], status: Int = 200) throws -> TransportResponse {
        .init(statusCode: status, data: try JSONSerialization.data(withJSONObject: object))
    }
    private func createdBot(_ input: CreateBotInput, appearance: BotAvatarAppearance?) -> Bot {
        Bot(id: Self.createdID, name: input.name, profileId: input.profileId, engine: input.engine,
            ownerId: "synthetic_creation_owner_r1", createdAt: 1, avatarAppearance: appearance)
    }
    func releaseSuccessfulCreation() throws {
        guard let input = heldInput, let held else { throw URLError(.badServerResponse) }
        let bot = createdBot(input, appearance: input.avatarAppearance)
        bots = [bot]; self.held = nil; heldInput = nil
        held.resume(returning: .init(statusCode: 201, data: try JSONEncoder().encode(bot)))
    }
    private func cancelHeld() {
        held?.resume(throwing: CancellationError()); held = nil; heldInput = nil
    }
    func send(_ request: URLRequest) async throws -> TransportResponse {
        captured.append(request)
        let path = request.url?.path ?? "", method = request.httpMethod ?? "GET"
        if method == "POST", path == "/v1/bots" {
            let input = try JSONDecoder().decode(CreateBotInput.self, from: request.httpBody ?? Data())
            if case .http(let status) = outcome { return try response(["error": "synthetic_refusal"], status: status) }
            if case .hold = outcome {
                heldInput = input
                return try await withTaskCancellationHandler {
                    try Task.checkCancellation()
                    return try await withCheckedThrowingContinuation { continuation in
                        held = continuation
                        let waiters = arrival; arrival = []
                        waiters.forEach { $0.resume() }
                    }
                } onCancel: { Task { await self.cancelHeld() } }
            }
            let bot = createdBot(input, appearance: input.avatarAppearance)
            bots = [bot]
            switch outcome {
            case .lostAfterCreation: throw URLError(.networkConnectionLost)
            case .malformed: return .init(statusCode: 201, data: Data("{".utf8))
            case .unsupportedRecipe:
                var value = try JSONSerialization.jsonObject(with: JSONEncoder().encode(bot)) as! [String: Any]
                var appearance = value["avatarAppearance"] as! [String: Any]
                appearance["version"] = 2; value["avatarAppearance"] = appearance
                return try response(value, status: 201)
            case .missingRecipe:
                return .init(statusCode: 201, data: try JSONEncoder().encode(createdBot(input, appearance: nil)))
            case .changedRecipe:
                let changed = BotAvatarAppearance(body: .cloud, eyes: .wide, colorHex: "#42C6B5", finish: .flat, motion: .lively)
                return .init(statusCode: 201, data: try JSONEncoder().encode(createdBot(input, appearance: changed)))
            default: return .init(statusCode: 201, data: try JSONEncoder().encode(bot))
            }
        }
        guard method == "GET" else { throw URLError(.unsupportedURL) }
        switch path {
        case "/health":
            return try response(["protocolVersion": 1, "mode": "local-development", "engineRouting": "host-routed",
                "remotePairing": "not_implemented", "hostId": "synthetic_creation_host_r1",
                "state": ["hostId": "synthetic_creation_host_r1", "ownerId": "synthetic_creation_owner_r1", "schemaVersion": 16,
                    "counts": ["bots": bots.count, "threads": 0, "messages": 0, "actions": 0, "devices": 0, "grants": 0]],
                "runtime": ["state": "running", "engines": ["codex"]]])
        case "/v1/bots":
            return .init(statusCode: 200, data: try JSONEncoder().encode(BotCreationList(items: bots)))
        case "/v1/engines/catalog":
            return try response(["items": [["id": "codex", "available": true, "installed": true, "adapterSupported": true,
                "models": [], "reasoningEfforts": [], "speeds": []]]])
        case "/v1/live-voice/settings":
            return try response(["hostID": "synthetic_creation_host_r1", "enabled": false, "defaultVoice": "bossa", "revision": 0])
        case "/v1/actions", "/v1/teams", "/v1/bots/\(Self.createdID)/threads":
            return try response(["items": []])
        default: throw URLError(.unsupportedURL)
        }
    }
}

private struct BotCreationList: Encodable { let items: [Bot] }
