#if os(macOS)
import DexterClientIdentity
@testable import DexterAppCore
import DexterHostClient
import Foundation
import XCTest

/// Owner invitation controller. Unit cases use a scripted transport; the live case drives the real SDK over loopback HTTP
/// into a real TypeScript host with a synthetic LAB certificate (scripts/swift-live.sh). No Keychain, account or TCC.
@MainActor
final class OwnerPairingOfferEditorTests: XCTestCase {
    private static let unavailable = Data(#"{"version":1,"hostId":"host_unit","revision":1,"journalPin":null,"availability":"unavailable","reason":"app_client_channel_unconfigured","channel":{"status":"unconfigured","installationId":null,"hostUrl":null,"hostFingerprint":null,"certificateNotAfter":null},"ttl":null,"roles":["client-ios","client-mac"],"scopes":{"historical":["approvals.decide","approvals.read","chat.read","chat.write","devices.manage","devices.read","grants.manage","grants.read"],"optIn":["connections.manage","connections.read","mcp.manage","mcp.read","outputs.manage","outputs.read"]},"limits":{"invitationDeliveries":3,"invitationBytes":8192}}"#.utf8)
    private static let available = Data(#"{"version":1,"hostId":"host_unit","revision":4,"journalPin":"\#(String(repeating: "c", count: 64))","availability":"available","reason":null,"channel":{"status":"listening","installationId":"host_unit","hostUrl":"https://127.0.0.1:9443","hostFingerprint":"\#(String(repeating: "b", count: 64))","certificateNotAfter":1900000000000},"ttl":{"minSeconds":60,"maxSeconds":600,"defaultSeconds":600},"roles":["client-ios","client-mac"],"scopes":{"historical":["approvals.decide","approvals.read","chat.read","chat.write","devices.manage","devices.read","grants.manage","grants.read"],"optIn":["connections.manage","connections.read","mcp.manage","mcp.read","outputs.manage","outputs.read"]},"limits":{"invitationDeliveries":3,"invitationBytes":8192}}"#.utf8)
    private func client(_ transport: EditorScriptedTransport) -> HostClient { HostClient(baseURL: URL(string: "http://127.0.0.1:4999")!, transport: transport) }

    func testUnavailableChannelIsExplicitAndSendsNoMutation() async throws {
        let transport = EditorScriptedTransport([.success(200, Self.unavailable)])
        let editor = OwnerPairingOfferEditor(client: client(transport))
        await editor.reload()
        XCTAssertEqual(editor.unavailableReason, .channelUnconfigured)
        editor.role = .clientIOS
        XCTAssertFalse(editor.canCreate, "no false button: the channel is not configured")
        await editor.create()
        let sent = await transport.sent()
        XCTAssertEqual(sent.map(\.httpMethod), ["GET"], "only the status read")
        XCTAssertNil(editor.invitationText)
    }

    func testDraftIsExplicitOutputsOffAndManageNeverIncludesRead() async throws {
        let transport = EditorScriptedTransport([.success(200, Self.available)])
        let editor = OwnerPairingOfferEditor(client: client(transport))
        await editor.reload()
        XCTAssertFalse(editor.canCreate, "no default device kind")
        editor.role = .clientMac
        XCTAssertTrue(editor.canCreate)
        XCTAssertEqual(editor.draftScopes, OwnerPairingScopes.historical, "outputs.* are off until a human turns them on")
        editor.selection.set(PairingScopeCatalog.outputsManage, on: true)
        XCTAssertTrue(editor.draftScopes.contains("outputs.manage")); XCTAssertFalse(editor.draftScopes.contains("outputs.read"))
        XCTAssertEqual(editor.effectiveTTLSeconds, 600)
        editor.ttlSeconds = 900
        XCTAssertNil(editor.effectiveTTLSeconds, "beyond the host's offer lifetime")
        XCTAssertFalse(editor.canCreate)
    }

    func testLostAckIsReadNeverRepostedAutomaticallyAndHumanRetryIsTheSameRequest() async throws {
        let transport = EditorScriptedTransport([.success(200, Self.available), .failure(URLError(.networkConnectionLost)),
                                                 .success(404, Data(#"{"error":"not_found"}"#.utf8))])
        let editor = OwnerPairingOfferEditor(client: client(transport))
        await editor.reload()
        editor.role = .clientIOS
        await editor.create()
        XCTAssertEqual(editor.notice, .outcomeUnknown)
        let pending = try XCTUnwrap(editor.pendingCreate)
        var sent = await transport.sent()
        XCTAssertEqual(sent.map { "\($0.httpMethod!) \($0.url!.path)" }, ["GET /v1/owner/app-client-pairing/status", "POST /v1/owner/app-client-pairing/offers",
                                                                         "GET /v1/owner/app-client-pairing/receipts/\(pending.clientRequestId)"])
        XCTAssertFalse(editor.canCreate, "a pending decision blocks a different one")
        await transport.enqueue([.failure(URLError(.timedOut)), .success(404, Data(#"{"error":"not_found"}"#.utf8))])
        await editor.retryPendingCreate()
        sent = await transport.sent()
        let posts = sent.filter { $0.httpMethod == "POST" }
        XCTAssertEqual(posts.count, 2)
        let bodies = try posts.map { try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap($0.httpBody)) as? NSDictionary) }
        XCTAssertEqual(bodies[0], bodies[1], "the human retry re-sends the exact same request (same id, revision, draft)")
        XCTAssertEqual(bodies[0]["clientRequestId"] as? String, pending.clientRequestId)
        XCTAssertEqual(editor.pendingCreate, pending)
        editor.abandonPendingCreate()
        XCTAssertNil(editor.pendingCreate)
    }

    /// After a restore (or a lost journal) the host refuses the old pending request by its journal pin: the human retry gets
    /// 409, the controller drops it, re-reads the status (new pin) and no code was shown; a new decision uses the new pin.
    func testRetryAfterRestoreIsRefusedAndTheNewPinIsUsedOnlyForANewRequest() async throws {
        let restored = Data(String(data: Self.available, encoding: .utf8)!.replacingOccurrences(of: String(repeating: "c", count: 64), with: String(repeating: "d", count: 64)).utf8)
        let transport = EditorScriptedTransport([.success(200, Self.available), .failure(URLError(.networkConnectionLost)),
                                                 .success(404, Data(#"{"error":"not_found"}"#.utf8))])
        let editor = OwnerPairingOfferEditor(client: client(transport))
        await editor.reload()
        editor.role = .clientIOS
        await editor.create()
        let pending = try XCTUnwrap(editor.pendingCreate)
        XCTAssertEqual(pending.expectedJournalPin, String(repeating: "c", count: 64))
        await transport.enqueue([.success(409, Data(#"{"error":"conflict","message":"Owner pairing journal changed; re-read the status before deciding again."}"#.utf8)),
                                 .success(200, restored)])
        await editor.retryPendingCreate()
        XCTAssertEqual(editor.notice, .conflict); XCTAssertNil(editor.pendingCreate); XCTAssertNil(editor.invitationText)
        XCTAssertEqual(editor.status?.journalPin, String(repeating: "d", count: 64))
        var sent = await transport.sent()
        XCTAssertEqual(sent.filter { $0.httpMethod == "POST" }.count, 2, "the refused retry is not repeated")
        await transport.enqueue([.failure(URLError(.timedOut)), .success(404, Data(#"{"error":"not_found"}"#.utf8))])
        await editor.create()
        sent = await transport.sent()
        let last = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(sent.filter { $0.httpMethod == "POST" }.last?.httpBody)) as? [String: Any])
        XCTAssertEqual(last["expectedJournalPin"] as? String, String(repeating: "d", count: 64))
        XCTAssertNotEqual(last["clientRequestId"] as? String, pending.clientRequestId, "a new decision is a new request id")
    }

    /// Real SDK → loopback HTTP → real TypeScript host (synthetic LAB TLS identity; random port). Lost ACK, restart,
    /// cancel and host switch are exercised against the host itself.
    func testLiveOwnerInvitationAgainstRealHost() async throws {
        guard let infoPath = ProcessInfo.processInfo.environment["DEXTER_OWNER_PAIRING_LIVE"] else { throw XCTSkip("no live synthetic host") }
        struct Info: Decodable { let url: String; let pid: Int32; let generation: Int; let hostId: String; let appClientUrl: String; let hostFingerprint: String }
        func info() throws -> Info { try JSONDecoder().decode(Info.self, from: Data(contentsOf: URL(fileURLWithPath: infoPath))) }
        func waitGeneration(_ value: Int) async throws -> Info {
            for _ in 0..<200 { if let current = try? info(), current.generation >= value { return current }; try await Task.sleep(nanoseconds: 50_000_000) }
            throw XCTSkip("live host did not cycle")
        }
        let first = try info()
        let base = try XCTUnwrap(URL(string: first.url)); XCTAssertNotEqual(base.port, 4317); XCTAssertNotEqual(base.port, 4318)
        let client = HostClient(baseURL: base)
        defer { client.close() }
        let editor = OwnerPairingOfferEditor(client: client)
        await editor.reload()
        XCTAssertEqual(editor.status?.availability, .available); XCTAssertEqual(editor.status?.channel.hostUrl, first.appClientUrl)
        XCTAssertEqual(editor.status?.channel.hostFingerprint, first.hostFingerprint)
        editor.role = .clientIOS
        editor.selection.set(PairingScopeCatalog.outputsManage, on: true)
        await editor.create()
        XCTAssertEqual(editor.notice, .created)
        let text = try XCTUnwrap(editor.invitationText)
        // The other device's own importer ("Conectar a outra base…") accepts it as-is, for its kind only.
        let imported = try ImportedClientOffer.decode(Data(text.utf8), platform: .clientIOS)
        XCTAssertEqual(imported.scopes.map(\.rawValue), (OwnerPairingScopes.historical + ["outputs.manage"]).sorted())
        XCTAssertFalse(imported.scopes.contains(.outputsRead))
        XCTAssertEqual(imported.bundle.host.url.absoluteString, first.appClientUrl)
        XCTAssertThrowsError(try ImportedClientOffer.decode(Data(text.utf8), platform: .clientMac))
        XCTAssertEqual(editor.record?.receipt.grantsCreated, 0)

        // Lost ACK: the host applies the POST, the response is dropped; the controller READS the receipt and the pinned
        // invitation; exactly one POST reached the host.
        let lossy = LossyTransport()
        let lossyClient = HostClient(baseURL: base, transport: lossy)
        defer { lossyClient.close() }
        let recovered = OwnerPairingOfferEditor(client: lossyClient)
        await recovered.reload()
        recovered.role = .clientMac
        await recovered.create()
        XCTAssertEqual(recovered.notice, .created)
        let posts = await lossy.posts()
        XCTAssertEqual(posts, 1, "never re-posted automatically")
        let recoveredText = try XCTUnwrap(recovered.invitationText)
        XCTAssertNoThrow(try ImportedClientOffer.decode(Data(recoveredText.utf8), platform: .clientMac))
        XCTAssertEqual(recovered.record?.live.offerState, .open)

        // Host restart: the receipt survives; the host never re-issues the code; the owner cancels by the exact flow.
        let pinBefore = try XCTUnwrap(recovered.status?.journalPin)
        kill(first.pid, SIGUSR1)
        _ = try await waitGeneration(first.generation + 1)
        let pinAfter = try await client.ownerPairingStatus().journalPin
        XCTAssertEqual(pinAfter, pinBefore, "a restart keeps the journal continuity")
        let receipt = try XCTUnwrap(recovered.record?.receipt)
        let afterRestart = try await client.ownerPairingRecord(clientRequestID: receipt.clientRequestId)
        XCTAssertEqual(afterRestart?.receipt, receipt); XCTAssertEqual(afterRestart?.live.invitation, .notRetained)
        let read = try await client.ownerPairingInvitation(for: receipt)
        XCTAssertEqual(read, .unavailable(offerID: receipt.offer?.offerId, reason: .notRetained))
        await recovered.reload(); await recovered.refreshRecord()
        XCTAssertTrue(recovered.canCancel)
        await recovered.cancelCurrentOffer()
        XCTAssertEqual(recovered.notice, .cancelled); XCTAssertEqual(recovered.record?.live.offerState, .cancelled); XCTAssertNil(recovered.invitationText)

        // Host switch: the old decision is never sent to another base.
        let stale = try XCTUnwrap(editor.status)
        kill(first.pid, SIGUSR2)
        let switched = try await waitGeneration(first.generation + 2)
        XCTAssertNotEqual(switched.hostId, first.hostId)
        await editor.reload()
        XCTAssertEqual(editor.notice, .hostChanged); XCTAssertNil(editor.status); XCTAssertFalse(editor.canCreate); XCTAssertNil(editor.invitationText)
        do { _ = try await client.createOwnerPairingOffer(CreateOwnerPairingOfferInput(status: stale, role: .clientIOS, scopes: OwnerPairingScopes.historical, ttlSeconds: 600)); XCTFail() }
        catch { XCTAssertEqual(error as? HostClientError, .conflict) }
    }
}

private actor EditorScriptedTransport: HTTPTransport {
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

/// Real loopback transport that drops the RESPONSE of the first POST after the host processed it (lost ACK).
private actor LossyTransport: HTTPTransport {
    private let real = URLSessionTransport(session: URLSession(configuration: .ephemeral))
    private var postCount = 0
    func send(_ request: URLRequest) async throws -> TransportResponse { try await sendWithoutRedirects(request) }
    func sendWithoutRedirects(_ request: URLRequest) async throws -> TransportResponse {
        let response = try await real.sendWithoutRedirects(request)
        if request.httpMethod == "POST" { postCount += 1; if postCount == 1 { throw URLError(.networkConnectionLost) } }
        return response
    }
    func posts() -> Int { postCount }
}
#endif
