#if os(macOS)
import Foundation
import XCTest
@testable import DexterAppCore
import DexterClientIdentity
@testable import DexterHostClient

/// "Convidar outro aparelho" in the app layer (ux-main-opus55-pairing-offer): the window session over the real
/// `OwnerPairingOfferEditor`, the model factory and the plain words. Scripted transports only: no TLS, Keychain, account,
/// process, provider or 4317/4318. The controller's own flow (create/receipt/cancel) is proven by its lane's tests.
@MainActor final class UXPairingOfferTests: XCTestCase {
    private static let historical = ["approvals.decide", "approvals.read", "chat.read", "chat.write", "devices.manage", "devices.read", "grants.manage", "grants.read"]
    private static let unavailable = Data(#"{"version":1,"hostId":"host_unit","revision":1,"availability":"unavailable","reason":"app_client_channel_unconfigured","channel":{"status":"unconfigured","installationId":null,"hostUrl":null,"hostFingerprint":null,"certificateNotAfter":null},"ttl":null,"roles":["client-ios","client-mac"],"scopes":{"historical":["approvals.decide","approvals.read","chat.read","chat.write","devices.manage","devices.read","grants.manage","grants.read"],"optIn":["connections.manage","connections.read","mcp.manage","mcp.read","outputs.manage","outputs.read"]},"limits":{"invitationDeliveries":3,"invitationBytes":8192}}"#.utf8)

    func testOnlyThisMacsOwnerBaseGetsASessionWithItsOwnClient() async throws {
        let wire = Phase2Host()
        let model = DexterAppModel(client: HostClient(baseURL: URL(string: "http://127.0.0.1:49951")!, transport: wire), storage: Phase2Storage())
        await model.refresh()
        XCTAssertTrue(model.canEditBotProfiles)
        let session = try XCTUnwrap(model.makeOwnerPairingOfferSession())
        XCTAssertEqual(session.scope, model.pairingOfferScope)
        XCTAssertTrue(session.editor.isOwnerLoopback)
        XCTAssertNil(session.editor.role, "no default device kind")
        XCTAssertEqual(session.editor.draftScopes, Self.historical, "the eight historical scopes, named; outputs off")
        session.close()

        let demo = DexterAppModel(client: HostClient(baseURL: URL(string: "http://127.0.0.1:49952")!, transport: Phase2Host()), storage: Phase2Storage())
        demo.useFixture()
        XCTAssertNil(demo.makeOwnerPairingOfferSession(), "the demo never invites")
    }

    func testUnconfiguredChannelNeverEnablesCreateAndSendsNothing() async throws {
        let transport = PairingScriptedTransport([.success(200, Self.unavailable)])
        let session = OwnerPairingOfferSession(client: HostClient(baseURL: URL(string: "http://127.0.0.1:49953")!, transport: transport), scope: "s")
        defer { session.close() }
        let editor = session.editor
        await editor.reload()
        XCTAssertEqual(editor.status?.availability, .unavailable)
        XCTAssertEqual(editor.unavailableReason, .channelUnconfigured)
        editor.role = .clientIOS
        editor.selection.selectAllOutputs()
        XCTAssertFalse(editor.canCreate, "create is enabled only when the base says available")
        await editor.create()
        let sent = await transport.sent()
        XCTAssertEqual(sent.map { $0.httpMethod ?? "GET" }, ["GET"], "one status read; no POST")
        XCTAssertNil(editor.invitationText); XCTAssertNil(editor.pendingCreate)
        XCTAssertEqual(OwnerPairingOfferPresentation.reasonKey(editor.unavailableReason), "Esta base ainda não está preparada para receber outros aparelhos.")
    }

    func testClosingTheSessionClosesItsOwnClient() async throws {
        let transport = PairingScriptedTransport([.success(200, Self.unavailable), .success(200, Self.unavailable)])
        let client = HostClient(baseURL: URL(string: "http://127.0.0.1:49954")!, transport: transport)
        let session = OwnerPairingOfferSession(client: client, scope: "s")
        await session.editor.reload()
        session.close()
        XCTAssertNil(session.editor.invitationText)
        do { _ = try await client.ownerPairingStatus(); XCTFail("the session's client is closed with it") } catch {}
        let count = await transport.sent().count
        XCTAssertEqual(count, 1)
    }

    func testOutputScopesNeedAnExplicitGestureAndManageDoesNotIncludeRead() {
        var selection = PairingScopeSelection()
        XCTAssertEqual(selection.scopes, Self.historical)
        selection.set(PairingScopeCatalog.outputsManage, on: true)
        XCTAssertTrue(selection.managesWithoutReading)
        XCTAssertEqual(selection.scopes, (Self.historical + ["outputs.manage"]).sorted())
        selection.set("devices.manage", on: false)
        XCTAssertEqual(selection.scopes, (Self.historical + ["outputs.manage"]).sorted(), "the historical eight cannot be removed here")
        selection.selectAllOutputs()
        XCTAssertEqual(selection.scopes, (Self.historical + ["outputs.manage", "outputs.read"]).sorted())
        XCTAssertTrue(OwnerPairingScopes.isValid(selection.scopes))
    }

    func testPlainWords() {
        let ttl = OwnerPairingTTL(minSeconds: 60, maxSeconds: 600, defaultSeconds: 600)
        XCTAssertEqual(OwnerPairingOfferPresentation.lifetimeOptions(ttl), [300, 600])
        XCTAssertEqual(OwnerPairingOfferPresentation.lifetimeOptions(OwnerPairingTTL(minSeconds: 60, maxSeconds: 3600, defaultSeconds: 420)), [300, 420, 600, 900, 1800, 3600])
        XCTAssertEqual(OwnerPairingOfferPresentation.roleKey(.clientIOS), "iPhone")
        XCTAssertEqual(OwnerPairingOfferPresentation.roleKey(.clientMac), "Mac")
        for reason: OwnerPairingUnavailableReason in [.channelUnconfigured, .listenerNotListening, .certificateNotValid, .offerTTLTooShort, .hostClosing] {
            XCTAssertFalse(OwnerPairingOfferPresentation.reasonKey(reason).isEmpty)
        }
        XCTAssertTrue(OwnerPairingOfferPresentation.noticeKey(.outcomeUnknown).contains("Conferir"))
        XCTAssertTrue(OwnerPairingOfferPresentation.invitationUnavailableKey(.notRetained).contains("Cancele-o e crie outro"))
        XCTAssertTrue(OwnerPairingOfferPresentation.offerStateKey(.claimed).contains("aprovar"))
    }
}

private actor PairingScriptedTransport: HTTPTransport {
    enum Step: Sendable { case success(Int, Data) }
    private var steps: [Step]
    private var captured: [URLRequest] = []
    init(_ steps: [Step]) { self.steps = steps }
    func send(_ request: URLRequest) async throws -> TransportResponse {
        captured.append(request)
        guard !steps.isEmpty else { throw URLError(.badServerResponse) }
        switch steps.removeFirst() { case .success(let status, let data): return TransportResponse(statusCode: status, data: data) }
    }
    func sent() -> [URLRequest] { captured }
}
#endif
