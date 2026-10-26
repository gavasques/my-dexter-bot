import Foundation
import XCTest
@testable import DexterHostClient

final class AvatarAppearanceHostClientTests: XCTestCase, @unchecked Sendable {
    private let recipe = BotAvatarAppearance(body: .bean, eyes: .focused, colorHex: "#a45bcc", finish: .glass, motion: .subtle)
    private var recipeJSON: String { ##"{"version":1,"body":"bean","eyes":"focused","colorHex":"#A45BCC","finish":"glass","motion":"subtle"}"## }
    private func botJSON(recipe: String? = nil, revision: Int = 0) -> Data {
        let appearance = recipe.map { #", "avatarAppearance":\#($0)"# } ?? ""
        return Data(#"{"id":"bot-a","name":"Avatar","profileId":"synthetic","engine":"codex","ownerId":"synthetic-owner","createdAt":1,"revision":\#(revision),"avatarEmoji":"🦊"\#(appearance)}"#.utf8)
    }
    private func client(_ transport: AvatarRecipeTransport) -> HostClient {
        HostClient(baseURL: URL(string: "http://127.0.0.1:9991")!, transport: transport)
    }

    func testCanonicalRecipeAndLegacyBotDecodeWithoutInventingAppearance() throws {
        XCTAssertEqual(recipe.colorHex, "#A45BCC")
        XCTAssertEqual(try JSONDecoder().decode(BotAvatarAppearance.self, from: Data(recipeJSON.utf8)), recipe)
        XCTAssertEqual(try JSONDecoder().decode(Bot.self, from: botJSON(recipe: recipeJSON)).avatarAppearance, recipe)
        XCTAssertNil(try JSONDecoder().decode(Bot.self, from: botJSON()).avatarAppearance)
        XCTAssertNil(try JSONDecoder().decode(Bot.self, from: botJSON(recipe: "null")).avatarAppearance)
        for value in [
            recipeJSON.replacingOccurrences(of: #""version":1"#, with: #""version":2"#),
            recipeJSON.replacingOccurrences(of: #""body":"bean""#, with: #""body":"star""#),
            recipeJSON.replacingOccurrences(of: #""eyes":"focused""#, with: #""eyes":"unknown""#),
            recipeJSON.replacingOccurrences(of: "#A45BCC", with: "#a45bcc"),
            recipeJSON.replacingOccurrences(of: "#A45BCC", with: "red"),
            recipeJSON.replacingOccurrences(of: #""finish":"glass""#, with: #""finish":"chrome""#),
            recipeJSON.replacingOccurrences(of: #""motion":"subtle""#, with: #""motion":"hyper""#),
            "{}"
        ] {
            XCTAssertThrowsError(try JSONDecoder().decode(Bot.self, from: botJSON(recipe: value)), "Unsupported recipe must fail, preserving no fake fallback")
        }
    }

    func testCreationAndPatchEncodeAtomicRecipeAndDistinctOmitClearSemantics() throws {
        let encoder = JSONEncoder()
        let create = try JSONDecoder().decode(JSONValue.self, from: encoder.encode(CreateBotInput(name: "Avatar", profileId: "synthetic", engine: .codex, avatarAppearance: recipe)))
        guard case .object(let createFields) = create else { return XCTFail("Expected object") }
        XCTAssertNotNil(createFields["avatarAppearance"])
        let unchanged = try JSONDecoder().decode(JSONValue.self, from: encoder.encode(PatchBotInput(expectedRevision: 3, name: "Preserved")))
        guard case .object(let unchangedFields) = unchanged else { return XCTFail("Expected object") }
        XCTAssertNil(unchangedFields["avatarAppearance"])
        let clear = try JSONDecoder().decode(JSONValue.self, from: encoder.encode(PatchBotInput(expectedRevision: 3, avatarAppearance: .clear)))
        XCTAssertEqual(clear, .object(["expectedRevision": .integer(3), "avatarAppearance": .null]))
        let select = try JSONDecoder().decode(JSONValue.self, from: encoder.encode(PatchBotInput(expectedRevision: 3, avatarImageId: .clear, avatarAppearance: .set(recipe))))
        guard case .object(let selectFields) = select else { return XCTFail("Expected object") }
        XCTAssertEqual(selectFields["avatarImageId"], .null); XCTAssertNotNil(selectFields["avatarAppearance"])
        let invalid = BotAvatarAppearance(version: 2, body: .round, eyes: .oval, colorHex: "#ABCDEF", finish: .flat, motion: .none)
        XCTAssertThrowsError(try encoder.encode(invalid))
        XCTAssertThrowsError(try encoder.encode(PatchBotInput(expectedRevision: 0, avatarAppearance: .set(invalid))))
    }

    func testCreateAndPatchVerifyRecipeEqualityAndClearOutcome() async throws {
        let transport = AvatarRecipeTransport(responses: [botJSON(recipe: recipeJSON), botJSON(recipe: recipeJSON, revision: 1), botJSON(recipe: "null", revision: 2)])
        let client = client(transport); defer { client.close() }
        let created = try await client.createBot(.init(name: "Avatar", profileId: "synthetic", engine: .codex, avatarAppearance: recipe))
        XCTAssertEqual(created.avatarAppearance, recipe)
        let changed = try await client.updateBot(id: "bot-a", input: .init(expectedRevision: 0, avatarImageId: .clear, avatarAppearance: .set(recipe)))
        XCTAssertEqual(changed.avatarAppearance, recipe); XCTAssertEqual(changed.revision, 1)
        let cleared = try await client.updateBot(id: "bot-a", input: .init(expectedRevision: 1, avatarAppearance: .clear))
        XCTAssertNil(cleared.avatarAppearance)
        let calls = await transport.requests(); XCTAssertEqual(calls.map(\.httpMethod), ["POST", "PATCH", "PATCH"])
        let input = try JSONDecoder().decode(JSONValue.self, from: XCTUnwrap(calls[1].httpBody))
        guard case .object(let fields) = input else { return XCTFail("Expected object") }
        XCTAssertEqual(fields["avatarImageId"], .null)
        XCTAssertNotNil(fields["avatarAppearance"])
    }

    func testMissingChangedOrUnsupportedMutationRecipeFailsAndNeverRetries() async throws {
        let changed = recipeJSON.replacingOccurrences(of: "bean", with: "cloud")
        let unsupported = recipeJSON.replacingOccurrences(of: #""version":1"#, with: #""version":2"#)
        let transport = AvatarRecipeTransport(responses: [botJSON(), botJSON(recipe: changed, revision: 1), botJSON(recipe: recipeJSON, revision: 1), botJSON(recipe: unsupported, revision: 1)])
        let client = client(transport); defer { client.close() }
        do { _ = try await client.createBot(.init(name: "Avatar", profileId: "synthetic", engine: .codex, avatarAppearance: recipe)); XCTFail("Missing persisted recipe") }
        catch let error as HostClientError { XCTAssertEqual(error, .mutationOutcomeUnknown) }
        do { _ = try await client.updateBot(id: "bot-a", input: .init(expectedRevision: 0, avatarAppearance: .set(recipe))); XCTFail("Changed persisted recipe") }
        catch let error as HostClientError { XCTAssertEqual(error, .mutationOutcomeUnknown) }
        do { _ = try await client.updateBot(id: "bot-a", input: .init(expectedRevision: 0, avatarAppearance: .clear)); XCTFail("Recipe clear did not occur") }
        catch let error as HostClientError { XCTAssertEqual(error, .mutationOutcomeUnknown) }
        do { _ = try await client.updateBot(id: "bot-a", input: .init(expectedRevision: 0, avatarAppearance: .set(recipe))); XCTFail("Unsupported persisted recipe") }
        catch let error as HostClientError { XCTAssertEqual(error, .mutationOutcomeUnknown) }
        let calls = await transport.requests(); XCTAssertEqual(calls.count, 4, "Failure never retries a mutation")
    }

    func testInvalidRecipeAndUnpairedPatchFailBeforeTransport() async throws {
        let transport = AvatarRecipeTransport(responses: [])
        let client = client(transport); defer { client.close() }
        let invalid = BotAvatarAppearance(body: .round, eyes: .oval, colorHex: "not a color", finish: .flat, motion: .none)
        do { _ = try await client.createBot(.init(name: "Avatar", profileId: "synthetic", engine: .codex, avatarAppearance: invalid)); XCTFail("Invalid input") }
        catch let error as HostClientError { XCTAssertEqual(error, .invalidRequest) }
        do { _ = try await client.updateBot(id: "bot-a", input: .init(expectedRevision: 0, avatarAppearance: .set(invalid))); XCTFail("Invalid input") }
        catch let error as HostClientError { XCTAssertEqual(error, .invalidRequest) }
        let paired = HostClient(baseURL: URL(string: "http://127.0.0.1:9991")!, accessPolicy: .unpairedHost, transport: transport)
        defer { paired.close() }
        do { _ = try await paired.updateBot(id: "bot-a", input: .init(expectedRevision: 0, avatarAppearance: .set(recipe))); XCTFail("Owner-only mutation") }
        catch let error as HostClientError { XCTAssertEqual(error, .forbidden) }
        let calls = await transport.requests(); XCTAssertEqual(calls.count, 0)
    }
}

private actor AvatarRecipeTransport: HTTPTransport {
    private var responses: [Data]
    private var captured: [URLRequest] = []
    init(responses: [Data]) { self.responses = responses }
    func send(_ request: URLRequest) async throws -> TransportResponse {
        captured.append(request)
        guard !responses.isEmpty else { throw URLError(.badServerResponse) }
        return .init(statusCode: 200, data: responses.removeFirst())
    }
    func requests() -> [URLRequest] { captured }
}
