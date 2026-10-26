#if os(macOS)
import CryptoKit
import Foundation
import XCTest
import DexterHostClient
@testable import DexterAppCore

/// Output folders editor. Scripted transport (no process) and, when `DEXTER_OUTPUT_FILES_LIVE` names the info file of
/// `scripts/output-files-live-host.mjs`, the actual SDK over real loopback HTTP against the TypeScript host (synthetic data).
@MainActor final class OutputFilesEditorTests: XCTestCase {
    private static let hostID = "host_synthetic_outputs"
    private func status(revision: Int = 1, kind: String = "host_data_legacy", path: String = "/synthetic/data") -> Data {
        let layout = kind == "host_data_legacy" ? "legacy" : "v1"
        return Data("""
        {"version":1,"hostId":"\(Self.hostID)","revision":\(revision),"persisted":true,"current":{"generation":\(revision),"kind":"\(kind)","layout":"\(layout)","path":"\(path)","current":true,"availability":"available","namespaces":{"general":\(layout == "v1"),"bots":true,"teams":true},"createdAt":1,"retiredAt":null},"host":{"platform":"darwin"},"scope":{"botFileTools":"own_bot_namespace","teamFileTools":"team_namespace_revalidated","groupTurns":"no_file_tools","terminalCwd":"output_namespace_not_os_sandbox","engineNativeWorkspace":"internal_not_outputs","contextDocuments":"separate_custody","sharing":"not_implemented","remoteBrowsing":"owner_loopback_only"},"limits":{"pageEntries":200,"scannedEntries":10000,"chunkBytes":8388608,"exportBytes":2147483648,"hashedBytes":268435456,"toolFileBytes":65536}}
        """.utf8)
    }
    private func locations(revision: Int = 1) -> Data {
        Data(#"{"version":1,"hostId":"\#(Self.hostID)","revision":\#(revision),"items":[{"generation":1,"kind":"host_data_legacy","layout":"legacy","path":"/synthetic/data","current":true,"availability":"available","namespaces":{"general":false,"bots":true,"teams":true},"createdAt":1,"retiredAt":null}]}"#.utf8)
    }
    private var namespaces: Data { Data(#"{"version":1,"hostId":"\#(Self.hostID)","generation":1,"items":[{"ref":"bot:bot_a","kind":"bot","id":"bot_a","label":"A","status":"active","exists":true,"relativePath":"bot-files/bot_a"}],"truncated":false}"#.utf8) }

    func testBaseResolutionNeverFallsBackFromAConfiguredVPS() {
        XCTAssertEqual(OutputFilesBase.resolve(configuredRemoteHostID: "vps-host", localHostConfigured: true), .remote(hostID: "vps-host"))
        XCTAssertEqual(OutputFilesBase.resolve(configuredRemoteHostID: nil, localHostConfigured: true), .thisMac)
        XCTAssertNil(OutputFilesBase.resolve(configuredRemoteHostID: nil, localHostConfigured: false))
    }

    func testOfflineOrRemoteBaseStaysOnThatBaseAndOffersNoFinderPath() async throws {
        let offline = HostClient(baseURL: URL(string: "http://127.0.0.1:9994")!, transport: ScriptedTransport([.failure(URLError(.cannotConnectToHost))]))
        defer { offline.close() }
        let editor = OutputFilesEditor(base: .remote(hostID: "vps-host"), client: offline)
        await editor.reload()
        // A loopback client never stands in for a remote base (refused before any request; offline VPS: OutputFilesPairedTests).
        XCTAssertEqual(editor.notice, .remoteBrowsingUnavailable); XCTAssertNil(editor.status)
        let unpaired = HostClient(baseURL: URL(string: "http://127.0.0.1:9994")!, accessPolicy: .unpairedHost, transport: ScriptedTransport([]))
        defer { unpaired.close() }
        let remote = OutputFilesEditor(base: .remote(hostID: "vps-host"), client: unpaired)
        await remote.reload()
        XCTAssertEqual(remote.notice, .remoteBrowsingUnavailable, "remote browsing needs an approved owner scope; never a local path")
        let location = try JSONDecoder().decode(OutputLocations.self, from: locations()).items[0]
        XCTAssertEqual(remote.access(location: location), .downloadOnly)
        let local = OutputFilesEditor(base: .thisMac, client: offline)
        XCTAssertEqual(local.access(location: location), .unavailable, "legacy root is the data directory: no general folder to reveal")
        let ns = try JSONDecoder().decode(OutputNamespaces.self, from: namespaces).items[0]
        XCTAssertEqual(local.access(location: location, namespace: ns, entryPath: "slides"), .revealInFinder(URL(fileURLWithPath: "/synthetic/data/bot-files/bot_a/slides")))
        XCTAssertEqual(local.access(location: location, namespace: ns, entryPath: "../escape"), .unavailable)
    }

    func testUnknownDestinationKeepsTheSameRequestUntilItsReceiptIsRead() async throws {
        let transport = ScriptedTransport([
            .success(200, status()), .success(200, locations()), .success(200, namespaces),
            .failure(URLError(.networkConnectionLost)),                                         // PUT: ACK lost
            .success(404, Data(#"{"error":"not_found","message":"x"}"#.utf8)),                  // receipt not visible yet
        ])
        let client = HostClient(baseURL: URL(string: "http://127.0.0.1:9994")!, transport: transport)
        defer { client.close() }
        let editor = OutputFilesEditor(base: .thisMac, client: client)
        await editor.reload()
        XCTAssertEqual(editor.status?.revision, 1)
        await editor.chooseDestination(.ownerPath("/synthetic/chosen"))
        XCTAssertEqual(editor.notice, .destinationUnknown)
        let pending = try XCTUnwrap(editor.pendingDestination)
        XCTAssertFalse(editor.canChooseDestination)
        // A different choice is refused while the first outcome is unknown: only the receipt read is sent.
        await transport.enqueue([.success(404, Data(#"{"error":"not_found","message":"x"}"#.utf8))])
        await editor.chooseDestination(.hostDataDefault)
        XCTAssertEqual(editor.notice, .destinationUnknown); XCTAssertEqual(editor.pendingDestination, pending)
        // Retry: receipt still absent, the SAME request is sent again; the host replays/applies it once.
        let receipt = Data(#"{"version":1,"hostId":"\#(Self.hostID)","clientRequestId":"\#(pending.clientRequestId)","requestHash":"\#(try XCTUnwrap(pending.requestHash))","previousRevision":1,"revision":2,"previousGeneration":1,"generation":2,"destination":{"kind":"owner_path","path":"/synthetic/chosen"},"existingFilesMoved":false,"createdAt":5}"#.utf8)
        await transport.enqueue([.success(404, Data(#"{"error":"not_found","message":"x"}"#.utf8)), .success(200, receipt),
                                 .success(200, status(revision: 2, kind: "owner_path", path: "/synthetic/chosen")), .success(200, locations(revision: 2)), .success(200, namespaces)])
        await editor.retryPendingDestination()
        XCTAssertNil(editor.pendingDestination); XCTAssertEqual(editor.notice, .destinationSaved)
        XCTAssertEqual(editor.lastReceipt?.existingFilesMoved, false)
        let puts = await transport.sent().filter { $0.httpMethod == "PUT" }
        XCTAssertEqual(puts.count, 2)
        let bodies = try puts.map { try JSONDecoder().decode(JSONValue.self, from: XCTUnwrap($0.httpBody)) }
        XCTAssertEqual(bodies[0], bodies[1], "byte-equal retry of the original decision")
    }

    /// Actual SDK → real HTTP → TypeScript host (run by `scripts/swift-live.sh`); skipped when no live host is named.
    func testLiveSDKAgainstRealHost() async throws {
        guard let infoPath = ProcessInfo.processInfo.environment["DEXTER_OUTPUT_FILES_LIVE"] else { throw XCTSkip("no live synthetic host") }
        struct Info: Decodable { let url: String; let hostId: String; let botId: String; let chosen: String; let exportDir: String; let binaryPath: String; let binaryBytes: Int64; let binarySha256: String }
        let info = try JSONDecoder().decode(Info.self, from: Data(contentsOf: URL(fileURLWithPath: infoPath)))
        let base = try XCTUnwrap(URL(string: info.url)); XCTAssertNotEqual(base.port, 4317); XCTAssertNotEqual(base.port, 4318)
        let client = HostClient(baseURL: base)
        defer { client.close() }
        let editor = OutputFilesEditor(base: .thisMac, client: client)
        await editor.reload()
        XCTAssertNil(editor.notice); XCTAssertEqual(editor.status?.hostId, info.hostId); XCTAssertEqual(editor.status?.current.kind, .hostDataLegacy)
        await editor.browse(namespace: .bot(info.botId), path: "slides")
        XCTAssertEqual(editor.browsing?.items.map(\.name), ["clip.mp4", "leia-me.txt"])
        let item = try await client.outputItem(namespace: .bot(info.botId), path: info.binaryPath)
        XCTAssertEqual(item.bytes, info.binaryBytes); XCTAssertEqual(item.sha256, info.binarySha256); XCTAssertEqual(item.mediaType, "video/mp4")
        let target = URL(fileURLWithPath: info.exportDir).appendingPathComponent("clip.mp4")
        let exported = await editor.export(item, to: target)
        XCTAssertEqual(exported?.sha256, info.binarySha256); XCTAssertEqual(exported?.bytes, info.binaryBytes)
        XCTAssertEqual(SHA256.hash(data: try Data(contentsOf: target)).map { String(format: "%02x", $0) }.joined(), info.binarySha256)
        let second = await editor.export(item, to: target)
        XCTAssertNil(second); XCTAssertEqual(editor.notice, .exportFailed, "never overwrites the owner's file")
        await editor.chooseDestination(.ownerPath(info.chosen))
        XCTAssertEqual(editor.notice, .destinationSaved); XCTAssertNil(editor.pendingDestination)
        XCTAssertEqual(editor.lastReceipt?.existingFilesMoved, false); XCTAssertEqual(editor.status?.current.path, info.chosen)
        let current = try XCTUnwrap(editor.locations.first { $0.current }), botNamespace = try XCTUnwrap(editor.namespaces.first { $0.ref == .bot(info.botId) })
        XCTAssertEqual(editor.access(location: current, namespace: botNamespace), .revealInFinder(URL(fileURLWithPath: info.chosen).appendingPathComponent("Bots").appendingPathComponent(info.botId)))
        XCTAssertEqual(OutputFilesEditor(base: .remote(hostID: info.hostId), client: client).access(location: current), .downloadOnly)
        // Outputs written before the change stay reachable in their generation.
        await editor.browse(namespace: .bot(info.botId), path: "slides", generation: 1)
        XCTAssertEqual(editor.browsing?.generation, 1); XCTAssertEqual(editor.browsing?.items.map(\.name), ["clip.mp4", "leia-me.txt"])
        let replay = try await client.outputDestinationReceipt(clientRequestID: try XCTUnwrap(editor.lastReceipt?.clientRequestId))
        XCTAssertEqual(replay, editor.lastReceipt)
    }
}

private actor ScriptedTransport: HTTPTransport {
    enum Step: Sendable { case success(Int, Data); case failure(URLError) }
    private var steps: [Step]
    private var captured: [URLRequest] = []
    init(_ steps: [Step]) { self.steps = steps }
    func enqueue(_ more: [Step]) { steps += more }
    func send(_ request: URLRequest) async throws -> TransportResponse {
        captured.append(request)
        guard !steps.isEmpty else { throw URLError(.badServerResponse) }
        switch steps.removeFirst() {
        case .success(let status, let data): return TransportResponse(statusCode: status, data: data)
        case .failure(let error): throw error
        }
    }
    func sent() -> [URLRequest] { captured }
}
#endif
