#if os(macOS)
import CryptoKit
import DexterHostClient
import Foundation
import XCTest
@testable import DexterAppCore

/// Wire fixture originates in the real owner HTTP route/SQLite/engine test, not a grant stand-in.
private let executionAccessWireFixture = Data(#"""
{"before":{"hostId":"host_62533d96-aac4-4c34-9dd0-c2132fe85359","botId":"bot_bb018df3-f641-4aa5-8769-7a77891c0c18","ownerId":"own_48c9c17e-3608-4746-a6a9-0a58d69066ae","botRevision":0,"scopeVersion":"d03.access.v1","inventoryHash":"904d5924b2221c99094242b2364e701e1a60995a8dfcf5190499e5041ed15f88","entries":[{"operation":"terminal","grant":{"botId":"bot_bb018df3-f641-4aa5-8769-7a77891c0c18","tool":"dexter.harness.terminal.run","destination":"dexter-harness-owner-proposals","policy":"ask","expiresAt":null,"revision":1},"provisional":true,"enabled":false},{"operation":"cli","grant":null,"provisional":false,"enabled":false},{"operation":"files_write","grant":null,"provisional":false,"enabled":false},{"operation":"automation","grant":null,"provisional":false,"enabled":false}]},"input":{"expectedHostId":"host_62533d96-aac4-4c34-9dd0-c2132fe85359","clientRequestId":"human-enable-terminal","expectedBotRevision":0,"expectedInventoryHash":"904d5924b2221c99094242b2364e701e1a60995a8dfcf5190499e5041ed15f88","scopeVersion":"d03.access.v1","operation":"terminal","enabled":true},"receipt":{"id":"gar_96173db8-577a-4779-837c-f17802f413c3","clientRequestId":"human-enable-terminal","inputHash":"644decc1488c6cce34e4a5fb10d0ab0de4c30259cf6a5dbfdbe66f76f173f98a","hostId":"host_62533d96-aac4-4c34-9dd0-c2132fe85359","botId":"bot_bb018df3-f641-4aa5-8769-7a77891c0c18","ownerId":"own_48c9c17e-3608-4746-a6a9-0a58d69066ae","input":{"expectedHostId":"host_62533d96-aac4-4c34-9dd0-c2132fe85359","clientRequestId":"human-enable-terminal","expectedBotRevision":0,"expectedInventoryHash":"904d5924b2221c99094242b2364e701e1a60995a8dfcf5190499e5041ed15f88","scopeVersion":"d03.access.v1","operation":"terminal","enabled":true},"previous":{"hostId":"host_62533d96-aac4-4c34-9dd0-c2132fe85359","botId":"bot_bb018df3-f641-4aa5-8769-7a77891c0c18","ownerId":"own_48c9c17e-3608-4746-a6a9-0a58d69066ae","botRevision":0,"scopeVersion":"d03.access.v1","inventoryHash":"904d5924b2221c99094242b2364e701e1a60995a8dfcf5190499e5041ed15f88","entries":[{"operation":"terminal","grant":{"botId":"bot_bb018df3-f641-4aa5-8769-7a77891c0c18","tool":"dexter.harness.terminal.run","destination":"dexter-harness-owner-proposals","policy":"ask","expiresAt":null,"revision":1},"provisional":true,"enabled":false},{"operation":"cli","grant":null,"provisional":false,"enabled":false},{"operation":"files_write","grant":null,"provisional":false,"enabled":false},{"operation":"automation","grant":null,"provisional":false,"enabled":false}]},"access":{"hostId":"host_62533d96-aac4-4c34-9dd0-c2132fe85359","botId":"bot_bb018df3-f641-4aa5-8769-7a77891c0c18","ownerId":"own_48c9c17e-3608-4746-a6a9-0a58d69066ae","botRevision":0,"scopeVersion":"d03.access.v1","inventoryHash":"6b27ac2d5e3e075c8bc17b500631879f24a11a6ec02c130f19d9e0f92ffaafbc","entries":[{"operation":"terminal","grant":{"botId":"bot_bb018df3-f641-4aa5-8769-7a77891c0c18","tool":"dexter.harness.terminal.run","destination":"dexter-harness-owner-proposals","policy":"ask","expiresAt":null,"revision":2},"provisional":false,"enabled":true},{"operation":"cli","grant":null,"provisional":false,"enabled":false},{"operation":"files_write","grant":null,"provisional":false,"enabled":false},{"operation":"automation","grant":null,"provisional":false,"enabled":false}]},"revocationEffects":{"blockedActionIds":[],"abortedActionIds":[]},"createdAt":1791757350220},"policy":{"hostId":"host_62533d96-aac4-4c34-9dd0-c2132fe85359","botId":"bot_bb018df3-f641-4aa5-8769-7a77891c0c18","ownerId":"own_48c9c17e-3608-4746-a6a9-0a58d69066ae","mode":"approve_all","revision":1,"eligibleScopeVersion":"d03.execution.v1","updatedAt":1791757346594,"receiptId":"apr_e47ecf9b-7dbe-49fe-a864-ccd0a7055a2a"}}
"""#.utf8)
@MainActor final class D03R2ExecutionAccessTests: XCTestCase {
    func testHumanDraftCancelWritesNothingThenConfirmationUsesExactClientRouteAndReceipt() async throws {
        let transport = try ExecutionAccessTransport(fixture: executionAccessWireFixture), model = await makeModel(transport)
        let bot = try XCTUnwrap(model.bots.first), editor = BotExecutionAccessEditor(bot: bot, model: model)
        await editor.load()
        XCTAssertTrue(editor.baseline?.entries.first?.provisional == true)
        let abandoned = try XCTUnwrap(editor.prepareHumanChange(operation: .terminal, enabled: true))
        XCTAssertTrue(abandoned.request.input.enabled)
        XCTAssertNil(editor.pending)
        let noWrites = await transport.writeCount(); XCTAssertEqual(noWrites, 0)
        let confirmation = try XCTUnwrap(editor.prepareHumanChange(operation: .terminal, enabled: true))
        XCTAssertNotEqual(abandoned.request.input.clientRequestId, confirmation.request.input.clientRequestId)
        await editor.saveHumanChoice(confirmation)
        XCTAssertEqual(editor.notice, .saved); XCTAssertNil(editor.pending)
        XCTAssertEqual(editor.lastReceipt?.input, confirmation.request.input)
        XCTAssertEqual(editor.baseline?.entries.first?.grant?.revision, 2)
        let count = await transport.writeCount(); XCTAssertEqual(count, 1)
        let keys = await transport.lastBodyKeys()
        XCTAssertEqual(keys, ["clientRequestId","enabled","expectedBotRevision","expectedHostId","expectedInventoryHash","operation","scopeVersion"])
        await editor.saveHumanChoice(confirmation) // Its old inventory snapshot cannot be resubmitted.
        let after = await transport.writeCount(); XCTAssertEqual(after, 1)
        editor.close()
    }
    func testLostReceiptSurvivesPanelCloseAndReconcileUsesOnlyExactGETAndNoNewGrantRevision() async throws {
        let transport = try ExecutionAccessTransport(fixture: executionAccessWireFixture), model = await makeModel(transport)
        await transport.dropResponseAfterCommit()
        let bot = try XCTUnwrap(model.bots.first), editor = BotExecutionAccessEditor(bot: bot, model: model)
        await editor.load()
        let confirmation = try XCTUnwrap(editor.prepareHumanChange(operation: .terminal, enabled: true))
        await editor.saveHumanChoice(confirmation)
        XCTAssertEqual(editor.notice, .saveUnknown)
        XCTAssertEqual(editor.pending?.input, confirmation.request.input)
        editor.close()
        let reopened = BotExecutionAccessEditor(bot: bot, model: model)
        await reopened.load()
        XCTAssertEqual(reopened.notice, .saved); XCTAssertNil(reopened.pending)
        let count = await transport.writeCount(); XCTAssertEqual(count, 1)
        let path = await transport.lastReceiptPath()
        XCTAssertEqual(path, "/v1/bots/\(bot.id)/execution-access/receipts/\(confirmation.request.input.clientRequestId)")
        XCTAssertEqual(reopened.baseline?.entries.first?.grant?.revision, 2)
        reopened.close()
    }
    private func makeModel(_ transport: ExecutionAccessTransport) async -> DexterAppModel {
        let model = DexterAppModel(client:HostClient(baseURL:URL(string:"http://127.0.0.1:49986")!,transport:transport),storage:ExecutionAccessStorage())
        await model.refresh(); XCTAssertTrue(model.isOnline); return model
    }
}
@MainActor private final class ExecutionAccessStorage: DexterAppStateStorage {
    var data: Data? = try? JSONEncoder().encode(DexterPersistedAppState(version:1,mode:.loopback,loopbackAddress:"http://127.0.0.1:49986",pendingRequests:[]))
    func readData() -> Data? { data }
    func readState() -> DexterStoredState { data.map(DexterStoredState.data) ?? .missing }
    func writeData(_ value:Data) { data = value }
    func removeData() { data = nil }
}
private actor ExecutionAccessTransport: HTTPTransport {
    private let fixture: Data
    private let before: BotExecutionAccess
    private var saved: Data?
    private var access: Data
    private var writes = 0, drop = false, bodyKeys: [String] = []
    private var receiptPath: String?
    init(fixture: Data) throws {
        self.fixture = fixture
        let decoded = try JSONSerialization.jsonObject(with:fixture) as! [String:Any]
        access = try JSONSerialization.data(withJSONObject:decoded["before"]!)
        before = try JSONDecoder().decode(BotExecutionAccess.self,from:access)
    }
    func dropResponseAfterCommit() { drop = true }
    func writeCount() -> Int { writes }
    func lastBodyKeys() -> [String] { bodyKeys }
    func lastReceiptPath() -> String? { receiptPath }
    func send(_ request: URLRequest) async throws -> TransportResponse {
        let path = request.url!.path, method = request.httpMethod ?? "GET", botID = before.botId
        let value: [String:Any]
        switch path {
        case "/health": value = ["protocolVersion":1,"mode":"local-development","engineRouting":"synthetic","remotePairing":"not_implemented","hostId":before.hostId,"state":[:]]
        case "/v1/bots": value = ["items":[["id":botID,"name":"Synthetic access","profileId":"synthetic","engine":"claude","ownerId":before.ownerId,"createdAt":1,"revision":before.botRevision]]]
        case "/v1/bots/\(botID)/threads", "/v1/events", "/v1/actions", "/v1/teams", "/v1/live-voice/settings": value = ["items":[],"nextCursor":0]
        case "/v1/bots/\(botID)/execution-access":
            if method == "PATCH" {
                let data = try XCTUnwrap(request.httpBody)
                let input = try JSONSerialization.jsonObject(with:data) as! [String:Any]
                bodyKeys = input.keys.sorted(); writes += 1
                var receipt = (try JSONSerialization.jsonObject(with:fixture) as! [String:Any])["receipt"] as! [String:Any]
                receipt["input"] = input; receipt["clientRequestId"] = input["clientRequestId"]
                var hashInput = input; hashInput["botId"] = botID; hashInput["ownerId"] = before.ownerId
                let bytes = try JSONSerialization.data(withJSONObject:hashInput,options:[.sortedKeys,.withoutEscapingSlashes])
                receipt["inputHash"] = SHA256.hash(data:bytes).map { String(format:"%02x",$0) }.joined()
                saved = try JSONSerialization.data(withJSONObject:receipt)
                access = try JSONSerialization.data(withJSONObject:receipt["access"]!)
                if drop { drop = false; throw HostClientError.hostFailure }
                return TransportResponse(statusCode:200,data:saved!)
            }
            return TransportResponse(statusCode:200,data:access)
        default:
            if path.hasPrefix("/v1/bots/\(botID)/execution-access/receipts/") {
                receiptPath = path; guard let saved else { throw HostClientError.notFound }
                return TransportResponse(statusCode:200,data:saved)
            }
            throw HostClientError.notFound
        }
        return TransportResponse(statusCode:200,data:try JSONSerialization.data(withJSONObject:value))
    }
}
#endif
