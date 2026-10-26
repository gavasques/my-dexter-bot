#if os(macOS)
import DexterClientIdentity
@testable import DexterAppCore
import DexterHostClient
import Foundation
import XCTest

/// Owner claims controller. Unit cases use a scripted transport; the live case drives the real SDK over loopback HTTP into
/// a real TypeScript host whose "other device" is a synthetic LAB client identity (scripts/swift-live.sh). No Keychain/TCC.
@MainActor
final class OwnerPairingClaimsEditorTests: XCTestCase {
    private static let claim = #"{"claimId":"ccl_11111111-2222-4333-8444-555555555555","offerId":"cof_11111111-2222-4333-8444-555555555555","kind":"pair","role":"client-ios","scopes":["approvals.decide","approvals.read","chat.read","chat.write","devices.manage","devices.read","grants.manage","grants.read"],"targetDeviceId":null,"approvedDeviceId":null,"clientFingerprint":"\#(String(repeating: "b", count: 64))","name":"iPhone","status":"pending","createdAt":1800000000000,"expiresAt":1800000600000,"decidedAt":null,"claimPin":"\#(String(repeating: "a", count: 64))","offerClientRequestId":null,"binding":null}"#
    private static let pending = Data(#"{"version":1,"hostId":"host_unit","revision":2,"journalPin":"\#(String(repeating: "c", count: 64))","availability":"available","reason":null,"items":[\#(claim)],"truncated":false}"#.utf8)
    private static let unconfigured = Data(#"{"version":1,"hostId":"host_unit","revision":1,"journalPin":null,"availability":"unavailable","reason":"app_client_channel_unconfigured","items":[],"truncated":false}"#.utf8)
    private func client(_ transport: ClaimsScriptedTransport) -> HostClient { HostClient(baseURL: URL(string: "http://127.0.0.1:4999")!, transport: transport) }

    func testUnconfiguredChannelOffersNoDecision() async throws {
        let transport = ClaimsScriptedTransport([.success(200, Self.unconfigured)])
        let editor = OwnerPairingClaimsEditor(client: client(transport))
        await editor.reload()
        XCTAssertEqual(editor.unavailableReason, .channelUnconfigured); XCTAssertFalse(editor.canDecide); XCTAssertTrue(editor.claims.isEmpty)
        let sent = await transport.sent()
        XCTAssertEqual(sent.count, 1)
    }

    func testLostAckIsReadNeverRepostedAndHumanRetryIsTheSameDecision() async throws {
        let transport = ClaimsScriptedTransport([.success(200, Self.pending), .failure(URLError(.networkConnectionLost)), .success(404, Data(#"{"error":"not_found"}"#.utf8))])
        let editor = OwnerPairingClaimsEditor(client: client(transport))
        await editor.reload()
        let claim = try XCTUnwrap(editor.claims.first)
        await editor.approve(claim)
        XCTAssertEqual(editor.notice, .outcomeUnknown)
        let pending = try XCTUnwrap(editor.pendingDecision)
        XCTAssertEqual(pending.expectedRevision, 2); XCTAssertEqual(pending.expectedClaimPin, claim.claimPin); XCTAssertEqual(pending.decision, .approve)
        var sent = await transport.sent()
        XCTAssertEqual(sent.map { "\($0.httpMethod!) \($0.url!.path)" }, ["GET /v1/owner/app-client-pairing/claims",
            "POST /v1/owner/app-client-pairing/claims/\(claim.claimId)/decision", "GET /v1/owner/app-client-pairing/decisions/\(pending.clientRequestId)"])
        XCTAssertFalse(editor.canDecide, "a pending decision blocks another one")
        await editor.reject(claim)
        sent = await transport.sent()
        XCTAssertEqual(sent.filter { $0.httpMethod == "POST" }.count, 1, "no second decision while one is unknown")
        await transport.enqueue([.failure(URLError(.timedOut)), .success(404, Data(#"{"error":"not_found"}"#.utf8))])
        await editor.retryPendingDecision()
        sent = await transport.sent()
        let posts = sent.filter { $0.httpMethod == "POST" }
        XCTAssertEqual(posts.count, 2)
        let bodies = try posts.map { try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap($0.httpBody)) as? NSDictionary) }
        XCTAssertEqual(bodies[0], bodies[1], "the human retry re-sends the exact same decision")
        editor.abandonPendingDecision(); XCTAssertNil(editor.pendingDecision)
    }

    /// Real SDK → loopback HTTP → real TypeScript host. Invitation (owner API) → synthetic device claims over mTLS →
    /// owner approves with a lost ACK → restart → reject a second device → host switch.
    func testLiveOwnerClaimReviewAgainstRealHost() async throws {
        guard let infoPath = ProcessInfo.processInfo.environment["DEXTER_OWNER_CLAIMS_LIVE"] else { throw XCTSkip("no live synthetic host") }
        struct Last: Decodable { let claimId: String; let fingerprint: String }
        struct Info: Decodable { let url: String; let pid: Int32; let generation: Int; let hostId: String; let claims: Int; let last: Last?; let invitationPath: String }
        func info() throws -> Info { try JSONDecoder().decode(Info.self, from: Data(contentsOf: URL(fileURLWithPath: infoPath))) }
        func wait(_ ready: (Info) -> Bool) async throws -> Info {
            for _ in 0..<200 { if let current = try? info(), ready(current) { return current }; try await Task.sleep(nanoseconds: 50_000_000) }
            throw XCTSkip("live host did not answer")
        }
        let first = try info()
        let base = try XCTUnwrap(URL(string: first.url)); XCTAssertNotEqual(base.port, 4317); XCTAssertNotEqual(base.port, 4318)
        let client = HostClient(baseURL: base)
        defer { client.close() }
        func invite(_ role: ClientRole, manage: Bool) async throws -> (OwnerPairingOfferEditor, Info) {
            let offers = OwnerPairingOfferEditor(client: client)
            await offers.reload()
            offers.role = role
            if manage { offers.selection.set(PairingScopeCatalog.outputsManage, on: true) }
            await offers.create()
            XCTAssertEqual(offers.notice, .created)
            let before = try info().claims
            try XCTUnwrap(offers.invitationText).write(toFile: first.invitationPath, atomically: true, encoding: .utf8)
            kill(first.pid, SIGUSR1)
            return (offers, try await wait { $0.claims == before + 1 })
        }
        let (offers, claimed) = try await invite(.clientMac, manage: true)
        let review = OwnerPairingClaimsEditor(client: client)
        await review.reload()
        let claim = try XCTUnwrap(review.claims.first)
        XCTAssertEqual(claim.claimId, claimed.last?.claimId); XCTAssertEqual(claim.clientFingerprint, claimed.last?.fingerprint)
        XCTAssertEqual(claim.role, .clientMac); XCTAssertEqual(claim.scopes, (OwnerPairingScopes.historical + ["outputs.manage"]).sorted())
        XCTAssertEqual(claim.offerClientRequestId, offers.record?.receipt.clientRequestId)

        // Lost ACK: the host applies the approval, the response is dropped; the controller READS the receipt; one POST only.
        let lossy = ClaimsLossyTransport()
        let lossyClient = HostClient(baseURL: base, transport: lossy)
        defer { lossyClient.close() }
        let approving = OwnerPairingClaimsEditor(client: lossyClient)
        await approving.reload()
        await approving.approve(try XCTUnwrap(approving.claims.first))
        XCTAssertEqual(approving.notice, .decided(.approved))
        let posts = await lossy.posts()
        XCTAssertEqual(posts, 1, "never re-posted automatically")
        let decision = try XCTUnwrap(approving.lastDecision)
        XCTAssertEqual(decision.receipt.binding?.scopes, claim.scopes, "no scope added"); XCTAssertEqual(decision.receipt.grantsCreated, 0)
        XCTAssertFalse(decision.receipt.binding?.scopes.contains("outputs.read") ?? true)
        XCTAssertTrue(approving.claims.isEmpty)

        // Host restart: same receipt by GET; the claim stays approved; nothing re-issued.
        kill(first.pid, SIGHUP)
        _ = try await wait { $0.generation == first.generation + 1 }
        let again = try await client.ownerPairingDecision(clientRequestID: decision.receipt.clientRequestId)
        XCTAssertEqual(again?.receipt, decision.receipt); XCTAssertEqual(again?.claim?.status, .approved)
        let pinAfterRestart = try await client.ownerPairingClaims().journalPin
        XCTAssertEqual(pinAfterRestart, approving.list?.journalPin, "a restart keeps the journal continuity")

        // Journal loss (same base, same authority): a request formed before is refused, never a new offer or code.
        let beforeLoss = try await client.ownerPairingStatus()
        let formed = CreateOwnerPairingOfferInput(status: beforeLoss, role: .clientIOS, scopes: OwnerPairingScopes.historical, ttlSeconds: 300)
        let made = try await client.createOwnerPairingOffer(formed)
        XCTAssertNotNil(made.invitation)
        let lossGeneration = try info().generation
        kill(first.pid, SIGWINCH)
        _ = try await wait { $0.generation == lossGeneration + 1 }
        let afterLoss = try await client.ownerPairingStatus()
        XCTAssertNotEqual(afterLoss.journalPin, beforeLoss.journalPin); XCTAssertEqual(afterLoss.revision, 1)
        do { _ = try await client.createOwnerPairingOffer(formed); XCTFail("the old request must not create anything") }
        catch { XCTAssertEqual(error as? HostClientError, .conflict) }
        let unconfirmed = try await client.ownerPairingRecord(clientRequestID: formed.clientRequestId)
        XCTAssertNil(unconfirmed, "no receipt here: unconfirmed, never re-issued")

        // A second device is rejected by the owner.
        _ = try await invite(.clientIOS, manage: false)
        await review.reload()
        await review.reject(try XCTUnwrap(review.claims.first))
        XCTAssertEqual(review.notice, .decided(.rejected)); XCTAssertEqual(review.lastDecision?.claim?.status, .rejected)

        // Owner host switch: the review resets and the old decision is refused by the new base.
        let staleList = try XCTUnwrap(review.list)
        let staleClaim = try XCTUnwrap(review.lastDecision?.claim)
        let switchGeneration = try info().generation
        kill(first.pid, SIGUSR2)
        let switched = try await wait { $0.generation == switchGeneration + 1 }
        XCTAssertNotEqual(switched.hostId, first.hostId)
        await review.reload()
        XCTAssertEqual(review.notice, .hostChanged); XCTAssertNil(review.list); XCTAssertFalse(review.canDecide)
        do { _ = try await client.decideOwnerPairingClaim(DecideOwnerPairingClaimInput(list: staleList, claim: staleClaim, decision: .approve)); XCTFail() }
        catch { XCTAssertEqual(error as? HostClientError, .conflict) }
    }
}

private actor ClaimsScriptedTransport: HTTPTransport {
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
private actor ClaimsLossyTransport: HTTPTransport {
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
