#if os(macOS)
import DexterClientIdentity
@testable import DexterAppCore
@testable import DexterHostClient
import Foundation
import XCTest

/// "Pedidos de aparelhos" in the app layer (ux-main-opus55-pairing-claims): the window session over the real
/// `OwnerPairingClaimsEditor`, the model factory, the review words and the verification code. Scripted transports only:
/// no TLS, Keychain, account, process, provider or 4317/4318. The controller's own invariants are proven by its lane.
@MainActor final class UXPairingClaimsTests: XCTestCase {
    private static let fingerprint = "0123456789abcdef" + String(repeating: "b", count: 48)
    private static func claim(offerRequest: String?) -> String {
        #"{"claimId":"ccl_11111111-2222-4333-8444-555555555555","offerId":"cof_11111111-2222-4333-8444-555555555555","kind":"pair","role":"client-mac","scopes":["approvals.decide","approvals.read","chat.read","chat.write","devices.manage","devices.read","grants.manage","grants.read","outputs.read"],"targetDeviceId":null,"approvedDeviceId":null,"clientFingerprint":"\#(fingerprint)","name":"MacBook da Ana","status":"pending","createdAt":1800000000000,"expiresAt":1800000600000,"decidedAt":null,"claimPin":"\#(String(repeating: "a", count: 64))","offerClientRequestId":\#(offerRequest.map { "\"\($0)\"" } ?? "null"),"binding":null}"#
    }
    private static func list(pin: Character = "c", revision: Int = 2, items: [String]) -> Data {
        Data(#"{"version":1,"hostId":"host_unit","revision":\#(revision),"journalPin":"\#(String(repeating: pin, count: 64))","availability":"available","reason":null,"items":[\#(items.joined(separator: ","))],"truncated":false}"#.utf8)
    }
    private static let unconfigured = Data(#"{"version":1,"hostId":"host_unit","revision":1,"journalPin":null,"availability":"unavailable","reason":"app_client_channel_unconfigured","items":[],"truncated":false}"#.utf8)
    private static let notFound = Data(#"{"error":"not_found","message":"Claim decision receipt absent; outcome remains unconfirmed."}"#.utf8)

    private func session(_ transport: ClaimsUITransport) -> OwnerPairingClaimsSession {
        OwnerPairingClaimsSession(client: HostClient(baseURL: URL(string: "http://127.0.0.1:49961")!, transport: transport), scope: "s")
    }

    func testOnlyThisMacsOwnerBaseGetsAClaimsSession() async throws {
        let model = DexterAppModel(client: HostClient(baseURL: URL(string: "http://127.0.0.1:49962")!, transport: Phase2Host()), storage: Phase2Storage())
        await model.refresh()
        let session = try XCTUnwrap(model.makeOwnerPairingClaimsSession())
        XCTAssertEqual(session.scope, model.pairingOfferScope)
        XCTAssertTrue(session.editor.isOwnerLoopback)
        XCTAssertNil(session.editor.list, "nothing is read before the sheet opens")
        session.close()
        let demo = DexterAppModel(client: HostClient(baseURL: URL(string: "http://127.0.0.1:49963")!, transport: Phase2Host()), storage: Phase2Storage())
        demo.useFixture()
        XCTAssertNil(demo.makeOwnerPairingClaimsSession(), "the demo never decides device requests")
    }

    func testUnconfiguredChannelShowsTheReasonAndNeverDecides() async throws {
        let transport = ClaimsUITransport([.reply(200, Self.unconfigured)])
        let session = session(transport)
        defer { session.close() }
        await session.editor.reload()
        XCTAssertEqual(session.editor.unavailableReason, .channelUnconfigured)
        XCTAssertFalse(session.editor.canDecide)
        XCTAssertTrue(session.editor.claims.isEmpty)
        XCTAssertEqual(OwnerPairingClaimsPresentation.reasonKey(session.editor.unavailableReason),
                       "Esta base ainda não está preparada para receber outros aparelhos.")
        let sent = await transport.log()
        XCTAssertEqual(sent, ["GET /v1/owner/app-client-pairing/claims"])
    }

    /// The approval's answer is lost; the editor reads once (absent), the owner's Conferir reads again and finds the
    /// original receipt. One POST in total; the outcome is shown only once the receipt proves it.
    func testUnknownDecisionIsSettledOnlyByReading() async throws {
        let transport = ClaimsUITransport([.reply(200, Self.list(items: [Self.claim(offerRequest: "11111111-2222-4333-8444-666666666666")])),
                                           .lost, .reply(404, Self.notFound)])
        let session = session(transport)
        defer { session.close() }
        let editor = session.editor
        await editor.reload()
        let claim = try XCTUnwrap(editor.claims.first)
        XCTAssertEqual(claim.name, "MacBook da Ana")
        await editor.approve(claim)
        XCTAssertEqual(editor.notice, .outcomeUnknown)
        XCTAssertTrue(OwnerPairingClaimsPresentation.noticeKey(.outcomeUnknown).contains("Use Conferir"))
        let pending = try XCTUnwrap(editor.pendingDecision)
        XCTAssertFalse(editor.canDecide, "no other decision while this one is unknown")

        // Conferir: the receipt the host kept for exactly this request.
        let receipt = #"{"receipt":{"version":1,"hostId":"host_unit","clientRequestId":"\#(pending.clientRequestId)","requestHash":"\#(try XCTUnwrap(pending.requestHash))","operation":"approve","previousRevision":2,"revision":3,"outcome":"approved","claim":{"claimId":"\#(claim.claimId)","offerId":"\#(claim.offerId)","kind":"pair","role":"client-mac","scopes":\#(Self.scopesJSON(claim.scopes)),"targetDeviceId":null,"clientFingerprint":"\#(Self.fingerprint)","name":"MacBook da Ana","claimPin":"\#(claim.claimPin)"},"binding":{"deviceId":"dev_synthetic","role":"client-mac","scopes":\#(Self.scopesJSON(claim.scopes)),"fingerprint":"\#(Self.fingerprint)","generation":1,"revision":1},"grantsCreated":0,"createdAt":1800000100000},"claim":null}"#
        await transport.enqueue([.reply(200, Data(receipt.utf8)), .reply(200, Self.list(revision: 3, items: []))])
        await editor.settlePending()
        XCTAssertEqual(editor.notice, .decided(.approved))
        XCTAssertFalse(OwnerPairingClaimsPresentation.nothingDecided(editor, previousReceiptRequestID: nil), "a proven outcome is not 'nothing decided'")
        XCTAssertNil(editor.pendingDecision)
        XCTAssertEqual(editor.lastDecision?.receipt.grantsCreated, 0)
        XCTAssertEqual(editor.lastDecision?.receipt.binding?.scopes, claim.scopes, "approving never adds a permission")
        XCTAssertTrue(editor.claims.isEmpty)
        XCTAssertTrue(OwnerPairingClaimsPresentation.noticeKey(.decided(.approved)).contains("Nenhum bot ganhou permissão"))
        let log = await transport.log()
        XCTAssertEqual(log.filter { $0.hasPrefix("POST") }.count, 1, "never re-posted")
        XCTAssertEqual(log.filter { $0 == "GET /v1/owner/app-client-pairing/decisions/\(pending.clientRequestId)" }.count, 2)
    }

    /// After a restore or a lost journal the host refuses the old decision (409, new journal pin): the editor drops it,
    /// re-reads, and the words never claim that anything was decided.
    func testJournalPinConflictRereadsAndClaimsNothing() async throws {
        let conflict = Data(#"{"error":"conflict","message":"Owner pairing journal changed."}"#.utf8)
        let transport = ClaimsUITransport([.reply(200, Self.list(items: [Self.claim(offerRequest: nil)])), .reply(409, conflict),
                                           .reply(200, Self.list(pin: "d", revision: 1, items: []))])
        let session = session(transport)
        defer { session.close() }
        let editor = session.editor
        await editor.reload()
        let previous = editor.lastDecision?.receipt.clientRequestId
        await editor.reject(try XCTUnwrap(editor.claims.first))
        // The frozen controller re-reads after the 409, which clears its own conflict notice; the UI rule still knows.
        XCTAssertNil(editor.notice)
        XCTAssertTrue(OwnerPairingClaimsPresentation.nothingDecided(editor, previousReceiptRequestID: previous))
        XCTAssertNil(editor.pendingDecision, "nothing is left to retry")
        XCTAssertEqual(editor.list?.journalPin, String(repeating: "d", count: 64), "the list was re-read with the new pin")
        let words = OwnerPairingClaimsPresentation.noticeKey(.conflict)
        XCTAssertTrue(words.contains("Nada foi decidido"))
        XCTAssertFalse(words.contains("aprovado") || words.contains("recusado"))
        let log = await transport.log()
        XCTAssertEqual(log.filter { $0.hasPrefix("POST") }.count, 1)
        XCTAssertEqual(OwnerPairingOfferPresentation.noticeKey(.conflict),
                       "Esta base mudou desde o pedido. Nada foi criado; confira e faça um novo pedido.")
    }

    func testVerificationCodeOrderingAndWords() {
        XCTAssertEqual(OwnerPairingClaimsPresentation.verificationCode(Self.fingerprint),
                       "0123 4567 89AB CDEF BBBB BBBB BBBB BBBB\nBBBB BBBB BBBB BBBB BBBB BBBB BBBB BBBB")
        XCTAssertEqual(PairingVerificationCode.text(Self.fingerprint.uppercased()), PairingVerificationCode.text(Self.fingerprint),
                       "both devices show the same code whatever the case of the hex")
        XCTAssertEqual(PairingVerificationCode.text("not-a-fingerprint"), "not-a-fingerprint", "never shortened or invented")
        func decode(_ json: String) throws -> OwnerPairingClaim { try JSONDecoder().decode(OwnerPairingClaim.self, from: Data(json.utf8)) }
        let focused = try? decode(Self.claim(offerRequest: "11111111-2222-4333-8444-666666666666"))
        let other = try? decode(Self.claim(offerRequest: nil).replacingOccurrences(of: "ccl_11111111", with: "ccl_22222222")
            .replacingOccurrences(of: "1800000000000", with: "1800000500000"))
        let ordered = OwnerPairingClaimsPresentation.ordered([other, focused].compactMap { $0 }, focusOfferRequestID: "11111111-2222-4333-8444-666666666666")
        XCTAssertEqual(ordered.first?.offerClientRequestId, "11111111-2222-4333-8444-666666666666", "the invitation just used comes first")
        XCTAssertEqual(OwnerPairingClaimsPresentation.ordered([focused, other].compactMap { $0 }, focusOfferRequestID: nil).first?.claimId,
                       other?.claimId, "otherwise newest first")
        XCTAssertEqual(OwnerPairingClaimsPresentation.kindKey(.rotate), "Quer trocar a chave de um aparelho já conectado")
        XCTAssertEqual(OwnerPairingClaimsPresentation.outcomeKey(.notApplied), "O pedido não estava mais esperando; nada mudou.")
    }

    private static func scopesJSON(_ scopes: [String]) -> String { "[" + scopes.map { "\"\($0)\"" }.joined(separator: ",") + "]" }
}

private actor ClaimsUITransport: HTTPTransport {
    enum Step: Sendable { case reply(Int, Data); case lost }
    private var steps: [Step]
    private var entries: [String] = []
    init(_ steps: [Step]) { self.steps = steps }
    func enqueue(_ more: [Step]) { steps += more }
    func log() -> [String] { entries }
    func send(_ request: URLRequest) async throws -> TransportResponse {
        entries.append("\(request.httpMethod ?? "GET") \(request.url?.path ?? "")")
        guard !steps.isEmpty else { throw URLError(.badServerResponse) }
        switch steps.removeFirst() {
        case .reply(let status, let data): return TransportResponse(statusCode: status, data: data)
        case .lost: throw URLError(.networkConnectionLost)
        }
    }
}
#endif
