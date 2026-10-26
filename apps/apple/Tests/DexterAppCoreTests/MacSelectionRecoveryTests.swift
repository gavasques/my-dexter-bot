import Foundation
import XCTest
@testable import DexterAppCore
import DexterHostClient

@MainActor private final class SelectionRecoveryMemory: DexterAppStateStorage {
    var bytes: Data?
    func readData() -> Data? { bytes }
    func writeData(_ data: Data) { bytes = data }
    func removeData() { bytes = nil }
}

private actor SelectionRecoveryTransport: HTTPTransport {
    var identity = "installation-one"
    var botIDs = ["first", "last"]
    var threads: [(id: String, bot: String, date: Int)] = [
        ("first-thread", "first", 1), ("last-old", "last", 2), ("last-new", "last", 3)
    ]
    var writes = 0
    func changeIdentity() { identity = "installation-two" }
    func removeLastBot() { botIDs = ["first"]; threads = [] }
    func removeOldThread() { threads.removeAll { $0.id == "last-old" } }
    func writeCount() -> Int { writes }
    func send(_ request: URLRequest) async throws -> TransportResponse {
        let path = request.url!.path
        if request.httpMethod != "GET" { writes += 1 }
        let value: [String: Any]
        switch path {
        case "/health":
            value = ["protocolVersion": 1, "mode": "local-development", "engineRouting": "synthetic",
                "remotePairing": "not_implemented", "hostId": "host", "installationId": identity, "state": [:]]
        case "/v1/bots":
            value = ["items": botIDs.map { ["id": $0, "name": $0, "profileId": "profile", "engine": "claude", "ownerId": "owner", "createdAt": 1] as [String: Any] }]
        case let p where p.hasPrefix("/v1/bots/") && p.hasSuffix("/threads"):
            let bot = p.split(separator: "/")[2]
            value = ["items": threads.filter { $0.bot == bot }.map {
                ["id": $0.id, "botId": $0.bot, "createdAt": $0.date] as [String: Any]
            }]
        case "/v1/events":
            value = ["items": threads.enumerated().map { i, t in
                ["id": "event-" + t.id, "cursor": i + 1, "kind": "thread.created", "botId": t.bot,
                    "entityId": t.id, "createdAt": t.date] as [String: Any]
            }, "nextCursor": threads.count]
        default:
            if path.hasPrefix("/v1/threads/"), path.split(separator: "/").count == 3,
               let thread = threads.first(where: { $0.id == String(path.dropFirst("/v1/threads/".count)) }) {
                value = ["id": thread.id, "botId": thread.bot, "createdAt": thread.date]
            } else { value = ["items": [], "nextCursor": 0] }
        }
        return TransportResponse(statusCode: 200, data: try JSONSerialization.data(withJSONObject: value))
    }
}

@MainActor final class MacSelectionRecoveryTests: XCTestCase {
    private func makeModel(_ transport: SelectionRecoveryTransport, _ storage: SelectionRecoveryMemory,
                           address: String = "http://127.0.0.1:4317") -> DexterAppModel {
        DexterAppModel(client: HostClient(baseURL: URL(string: address)!, transport: transport), storage: storage)
    }

    private func selectedSnapshot(_ transport: SelectionRecoveryTransport, _ storage: SelectionRecoveryMemory) async -> DexterAppModel {
        let model = makeModel(transport, storage)
        await model.refresh()
        model.selectBot(id: "last")
        XCTAssertNotNil(model.presentThread("last-old", for: "last"))
        return model
    }

    func testRestartRestoresExactBotAndOlderConversationWithoutWritesOrMessageBodies() async throws {
        let host = SelectionRecoveryTransport(), storage = SelectionRecoveryMemory()
        _ = await selectedSnapshot(host, storage)
        let snapshot = try XCTUnwrap(storage.bytes)
        let decoded = try XCTUnwrap(DexterAppStateValidation.decode(snapshot))
        XCTAssertEqual(decoded.lastSelection?.botID, "last")
        XCTAssertEqual(decoded.lastSelection?.threadID, "last-old")
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: snapshot) as? [String: Any])
        XCTAssertEqual(Set(json.keys), ["version", "mode", "loopbackAddress", "pendingRequests", "lastSelection"])
        let selection = try XCTUnwrap(json["lastSelection"] as? [String: Any])
        XCTAssertEqual(Set(selection.keys), ["hostAddress", "hostIdentity", "botID", "threadID"])
        let restarted = makeModel(host, storage)
        XCTAssertNil(restarted.selectedBotID, "stored navigation is not authority before health validates")
        await restarted.refresh()
        XCTAssertEqual(restarted.selectedBotID, "last")
        XCTAssertEqual(restarted.presentedThreadID, "last-old", "restore exact selection, not newest thread")
        XCTAssertTrue(restarted.messages.isEmpty)
        let opened = await restarted.openConversationForSelectedBot("last")
        XCTAssertTrue(opened)
        let writes = await host.writeCount()
        XCTAssertEqual(writes, 0)
    }

    func testChangedInstallationNeverRestoresSavedBotOrThread() async {
        let host = SelectionRecoveryTransport(), storage = SelectionRecoveryMemory()
        _ = await selectedSnapshot(host, storage)
        await host.changeIdentity()
        let restarted = makeModel(host, storage)
        await restarted.refresh()
        XCTAssertEqual(restarted.selectedBotID, "first")
        XCTAssertEqual(restarted.presentedThreadID, "first-thread")
        XCTAssertNotNil(restarted.persistenceNotice)
        let writes = await host.writeCount()
        XCTAssertEqual(writes, 0)
    }

    func testChangedAddressDoesNotRestoreEvenWithSameInstallationID() async throws {
        let host = SelectionRecoveryTransport(), storage = SelectionRecoveryMemory()
        _ = await selectedSnapshot(host, storage)
        var snapshot = try XCTUnwrap(DexterAppStateValidation.decode(try XCTUnwrap(storage.bytes)))
        snapshot.loopbackAddress = "http://127.0.0.1:5317"
        storage.bytes = try XCTUnwrap(DexterAppStateValidation.encode(snapshot))
        let restarted = makeModel(host, storage, address: "http://127.0.0.1:5317")
        await restarted.refresh()
        XCTAssertEqual(restarted.selectedBotID, "first")
        XCTAssertEqual(restarted.presentedThreadID, "first-thread")
        let writes = await host.writeCount()
        XCTAssertEqual(writes, 0)
    }

    func testInstallationChangeDuringRefreshDropsLiveSelection() async {
        let host = SelectionRecoveryTransport(), storage = SelectionRecoveryMemory()
        let model = await selectedSnapshot(host, storage)
        await host.changeIdentity()
        await model.refresh()
        XCTAssertEqual(model.selectedBotID, "first")
        XCTAssertEqual(model.presentedThreadID, "first-thread")
        XCTAssertNotNil(model.persistenceNotice)
        let writes = await host.writeCount()
        XCTAssertEqual(writes, 0)
    }

    func testMissingThreadUsesExistingFallbackAndMissingBotNeverAutoCreates() async {
        let host = SelectionRecoveryTransport(), storage = SelectionRecoveryMemory()
        _ = await selectedSnapshot(host, storage)
        await host.removeOldThread()
        let restarted = makeModel(host, storage)
        await restarted.refresh()
        XCTAssertEqual(restarted.selectedBotID, "last")
        XCTAssertEqual(restarted.presentedThreadID, "last-new")
        XCTAssertNotNil(restarted.persistenceNotice)
        await host.removeLastBot()
        let missing = makeModel(host, storage)
        await missing.refresh()
        XCTAssertEqual(missing.selectedBotID, "first")
        XCTAssertNil(missing.presentedThreadID)
        let opened = await missing.openConversationForSelectedBot("first")
        XCTAssertFalse(opened)
        XCTAssertNotNil(missing.errorMessage)
        await missing.refresh()
        let again = await missing.openConversationForSelectedBot("first")
        XCTAssertFalse(again)
        let writes = await host.writeCount()
        XCTAssertEqual(writes, 0)
    }

    func testLegacyV1KeepsPendingRequestAndDefaultsToFirstBot() async throws {
        let host = SelectionRecoveryTransport(), storage = SelectionRecoveryMemory()
        let requestID = UUID().uuidString.lowercased()
        storage.bytes = try JSONSerialization.data(withJSONObject: ["version": 1, "mode": "loopback",
            "loopbackAddress": "http://127.0.0.1:4317", "pendingRequests": [["hostAddress": "http://127.0.0.1:4317",
                "threadID": "first-thread", "clientRequestID": requestID,
                "contentDigest": DexterAppStateValidation.contentDigest("private message")]]])
        let legacy = try XCTUnwrap(DexterAppStateValidation.decode(try XCTUnwrap(storage.bytes)))
        XCTAssertNil(legacy.lastSelection)
        let model = makeModel(host, storage)
        await model.refresh()
        XCTAssertEqual(model.selectedBotID, "first")
        XCTAssertNotNil(model.presentThread("first-thread", for: "first"))
        XCTAssertEqual(model.pendingSubmission?.clientRequestID, requestID)
        let saved = try XCTUnwrap(DexterAppStateValidation.decode(try XCTUnwrap(storage.bytes)))
        XCTAssertEqual(saved.pendingRequests, legacy.pendingRequests)
        let writes = await host.writeCount()
        XCTAssertEqual(writes, 0)
    }

    func testCorruptSnapshotRemainsUntouchedAndCannotRestore() async {
        let storage = SelectionRecoveryMemory(), host = SelectionRecoveryTransport()
        storage.bytes = Data("{broken snapshot".utf8)
        let original = storage.bytes
        let model = makeModel(host, storage)
        XCTAssertTrue(model.requiresStorageReset)
        await model.refresh()
        XCTAssertTrue(model.isFixture)
        XCTAssertEqual(storage.bytes, original)
        let writes = await host.writeCount()
        XCTAssertEqual(writes, 0)
    }
}
