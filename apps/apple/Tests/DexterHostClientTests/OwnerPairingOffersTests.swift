import CryptoKit
import DexterClientIdentity
@testable import DexterHostClient
import Foundation
import XCTest

/// Owner pairing offer SDK against a scripted transport (no network, no Keychain, no real host). The synthetic code below
/// is a fixed lab string, never a real pairing secret.
final class OwnerPairingOffersTests: XCTestCase {
    static let host = "host_vector"
    static let offerID = "cof_11111111-2222-4333-8444-555555555555"
    static let code = "LABcodeLABcodeLABcodeLABcodeLABcodeLABcode1"
    static let scopes = ["approvals.decide", "approvals.read", "chat.read", "chat.write", "devices.manage", "devices.read", "grants.manage", "grants.read", "outputs.manage"]

    static func statusJSON(availability: String = "available", reason: String? = nil, revision: Int = 7, channel: String = "listening") -> Data {
        let reasonJSON = reason.map { "\"\($0)\"" } ?? "null"
        let channelJSON = channel == "unconfigured"
            ? #"{"status":"unconfigured","installationId":null,"hostUrl":null,"hostFingerprint":null,"certificateNotAfter":null}"#
            : #"{"status":"\#(channel)","installationId":"\#(host)","hostUrl":"https://127.0.0.1:9443","hostFingerprint":"\#(String(repeating: "a", count: 64))","certificateNotAfter":1900000000000}"#
        let ttl = channel == "unconfigured" ? "null" : #"{"minSeconds":60,"maxSeconds":600,"defaultSeconds":600}"#
        let pin = channel == "unconfigured" ? "null" : #""\#(String(repeating: "c", count: 64))""#
        return Data(#"{"version":1,"hostId":"\#(host)","revision":\#(revision),"journalPin":\#(pin),"availability":"\#(availability)","reason":\#(reasonJSON),"channel":\#(channelJSON),"ttl":\#(ttl),"roles":["client-ios","client-mac"],"scopes":{"historical":["approvals.decide","approvals.read","chat.read","chat.write","devices.manage","devices.read","grants.manage","grants.read"],"optIn":["connections.manage","connections.read","mcp.manage","mcp.read","outputs.manage","outputs.read"]},"limits":{"invitationDeliveries":3,"invitationBytes":8192}}"#.utf8)
    }
    static func status(revision: Int = 7) throws -> OwnerPairingStatus { try JSONDecoder().decode(OwnerPairingStatus.self, from: statusJSON(revision: revision)) }
    static func invitationText(role: String = "client-mac", scopes: [String] = scopes, code: String = code) -> String {
        let list = scopes.map { "\"\($0)\"" }.joined(separator: ",")
        return #"{"protocol":"dexter-app-client-v1","installationId":"\#(host)","hostUrl":"https://127.0.0.1:9443","hostCertificateDER":"AAAA","hostFingerprint":"\#(String(repeating: "a", count: 64))","offerId":"\#(offerID)","kind":"pair","role":"\#(role)","scopes":[\#(list)],"deviceId":null,"expiresAt":1800000600000,"code":"\#(code)"}"# + "\n"
    }
    static func sha(_ text: String) -> String { SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined() }
    static func receiptJSON(_ input: CreateOwnerPairingOfferInput, outcome: String = "created", text: String? = nil, requestHash: String? = nil) -> String {
        let pinned = text ?? invitationText(role: input.role.rawValue, scopes: input.scopes)
        let list = input.scopes.map { "\"\($0)\"" }.joined(separator: ",")
        let offer = outcome == "created"
            ? #"{"offerId":"\#(offerID)","kind":"pair","role":"\#(input.role.rawValue)","scopes":[\#(list)],"expiresAt":1800000600000,"installationId":"\#(host)","hostUrl":"https://127.0.0.1:9443","hostFingerprint":"\#(String(repeating: "a", count: 64))"}"#
            : "null"
        let pin = outcome == "created" ? "\"\(sha(pinned))\"" : "null"
        return #"{"version":1,"hostId":"\#(host)","clientRequestId":"\#(input.clientRequestId)","requestHash":"\#(requestHash ?? input.requestHash!)","operation":"create","previousRevision":\#(input.expectedRevision),"revision":\#(input.expectedRevision + 1),"outcome":"\#(outcome)","offer":\#(offer),"invitationSha256":\#(pin),"grantsCreated":0,"createdAt":1800000000000}"#
    }
    static func resultJSON(_ input: CreateOwnerPairingOfferInput, text: String? = nil, invitationText override: String? = nil, requestHash: String? = nil) -> Data {
        let pinned = text ?? invitationText(role: input.role.rawValue, scopes: input.scopes)
        let delivered = override ?? pinned
        let escaped = String(data: try! JSONSerialization.data(withJSONObject: [delivered], options: [.withoutEscapingSlashes]), encoding: .utf8)!.dropFirst().dropLast()
        return Data(#"{"record":{"receipt":\#(receiptJSON(input, text: pinned, requestHash: requestHash)),"live":{"offerState":"open","invitation":"retained"}},"invitation":{"text":\#(escaped),"sha256":"\#(sha(delivered))","deliveriesRemaining":2}}"#.utf8)
    }
    static func client(_ transport: OwnerPairingScriptedTransport) -> HostClient { HostClient(baseURL: URL(string: "http://127.0.0.1:4999")!, transport: transport) }

    func testRequestHashMatchesTheHostCanonicalVector() throws {
        // Vectors computed with the host's canonical JSON (packages/cli/src/owner-pairing-offer.ts).
        let create = CreateOwnerPairingOfferInput(status: try Self.status(), role: .clientMac, scopes: Self.scopes, ttlSeconds: 600,
                                                  clientRequestId: "0b5c7a52-3f7e-4d4b-9a51-6c1d2e3f4a5b")
        XCTAssertEqual(create.expectedJournalPin, String(repeating: "c", count: 64), "the status's journal pin is captured")
        XCTAssertEqual(create.requestHash, "c64f2fdeaace6d9153dec648fa0d60de086b2e061e28c7af80dd0e8b31da25aa")
        let cancel = CancelOwnerPairingOfferInput(status: try Self.status(revision: 8), offerID: Self.offerID, clientRequestId: "0b5c7a52-3f7e-4d4b-9a51-6c1d2e3f4a5c")
        XCTAssertEqual(cancel.requestHash, "a534e9a01deeaff28fbb08ee8225a8b65038756c8e3666fb7d215ebcf1c62198")
        let body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(cancel)) as? [String: Any]
        XCTAssertEqual(Set(body.map { Array($0.keys) } ?? []), ["expectedHostId", "expectedRevision", "expectedJournalPin", "clientRequestId"], "offer id travels in the path only")
    }

    func testOnlyOwnerLoopbackAndNothingIsSentOtherwise() async throws {
        let transport = OwnerPairingScriptedTransport([])
        let unpaired = HostClient(baseURL: URL(string: "https://base.example")!, accessPolicy: .unpairedHost, transport: transport)
        XCTAssertFalse(unpaired.ownerPairingReady)
        do { _ = try await unpaired.ownerPairingStatus(); XCTFail() } catch { XCTAssertEqual(error as? HostClientError, .forbidden) }
        let input = CreateOwnerPairingOfferInput(status: try Self.status(), role: .clientIOS, scopes: OwnerPairingScopes.historical, ttlSeconds: 600)
        do { _ = try await unpaired.createOwnerPairingOffer(input); XCTFail() } catch { XCTAssertEqual(error as? HostClientError, .forbidden) }
        let sent = await transport.sent()
        XCTAssertTrue(sent.isEmpty)
    }

    func testStatusIsReadLiveWithoutRedirectsAndValidated() async throws {
        let transport = OwnerPairingScriptedTransport([.success(200, Self.statusJSON(availability: "unavailable", reason: "app_client_channel_unconfigured", revision: 1, channel: "unconfigured")),
                                                      .success(200, Self.statusJSON(availability: "available", reason: nil, channel: "unconfigured"))])
        let client = Self.client(transport)
        let status = try await client.ownerPairingStatus()
        XCTAssertEqual(status.reason, .channelUnconfigured); XCTAssertNil(status.ttl); XCTAssertEqual(status.channel.status, .unconfigured)
        do { _ = try await client.ownerPairingStatus(); XCTFail("available without a listening channel is a contract mismatch") }
        catch { XCTAssertEqual(error as? HostClientError, .contractMismatch) }
        let sent = await transport.sent(), protected = await transport.protectedCount()
        XCTAssertEqual(sent.first?.url?.path, "/v1/owner/app-client-pairing/status")
        XCTAssertEqual(sent.first?.cachePolicy, .reloadIgnoringLocalCacheData)
        XCTAssertEqual(protected, 2, "every pairing request uses the no-redirect transport")
    }

    func testCreateSendsTheClosedBodyAndVerifiesReceiptAndInvitationPin() async throws {
        let input = CreateOwnerPairingOfferInput(status: try Self.status(), role: .clientMac, scopes: Self.scopes, ttlSeconds: 300)
        let transport = OwnerPairingScriptedTransport([.success(201, Self.resultJSON(input))])
        let result = try await Self.client(transport).createOwnerPairingOffer(input)
        XCTAssertEqual(result.record.receipt.outcome, .created); XCTAssertEqual(result.invitation?.deliveriesRemaining, 2)
        XCTAssertEqual(result.invitation?.text, Self.invitationText(scopes: Self.scopes))
        let requests = await transport.sent()
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.httpMethod, "POST"); XCTAssertEqual(request.url?.path, "/v1/owner/app-client-pairing/offers")
        let body = try XCTUnwrap(try JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
        XCTAssertEqual(Set(body.keys), ["expectedHostId", "expectedRevision", "expectedJournalPin", "clientRequestId", "role", "scopes", "ttlSeconds"], "no owner/grant/capability field")
        XCTAssertEqual(body["role"] as? String, "client-mac"); XCTAssertEqual(body["scopes"] as? [String], Self.scopes)
        // The secret never appears in descriptions, debug output or mirrors.
        let invitation = try XCTUnwrap(result.invitation)
        var dumped = ""; dump(result, to: &dumped)
        for rendered in [String(describing: invitation), String(reflecting: invitation), String(describing: result), dumped] {
            XCTAssertFalse(rendered.contains(Self.code), "code leaked into a description")
        }
    }

    func testUnknownOutcomesNeverReportSuccessAndRefusalsHaveNoEffect() async throws {
        let input = CreateOwnerPairingOfferInput(status: try Self.status(), role: .clientMac, scopes: Self.scopes, ttlSeconds: 300)
        let tampered = Self.invitationText(scopes: Self.scopes, code: "OTHERcodeOTHERcodeOTHERcodeOTHERcodeOTHER12")
        let cases: [(OwnerPairingScriptedTransport.Step, HostClientError)] = [
            (.failure(URLError(.networkConnectionLost)), .mutationOutcomeUnknown),
            (.success(503, Data(#"{"error":"outcome_unknown"}"#.utf8)), .mutationOutcomeUnknown),
            (.success(500, Data()), .mutationOutcomeUnknown),
            (.success(201, Data("not json".utf8)), .mutationOutcomeUnknown),
            (.success(201, Self.resultJSON(input, requestHash: String(repeating: "f", count: 64))), .mutationOutcomeUnknown),
            (.success(201, Self.resultJSON(input, invitationText: tampered)), .mutationOutcomeUnknown),
            (.success(409, Data(#"{"error":"conflict"}"#.utf8)), .conflict),
            (.success(400, Data(#"{"error":"invalid_input"}"#.utf8)), .invalidRequest),
            (.success(403, Data(#"{"error":"forbidden"}"#.utf8)), .forbidden),
        ]
        for (step, expected) in cases {
            let transport = OwnerPairingScriptedTransport([step])
            do { _ = try await Self.client(transport).createOwnerPairingOffer(input); XCTFail("\(expected)") }
            catch { XCTAssertEqual(error as? HostClientError, expected) }
        }
        let invalid = CreateOwnerPairingOfferInput(status: try Self.status(), role: .clientMac, scopes: ["chat.write", "chat.read"], ttlSeconds: 300)
        let transport = OwnerPairingScriptedTransport([])
        do { _ = try await Self.client(transport).createOwnerPairingOffer(invalid); XCTFail() } catch { XCTAssertEqual(error as? HostClientError, .invalidRequest) }
        let unknownScope = CreateOwnerPairingOfferInput(status: try Self.status(), role: .clientMac, scopes: ["tools.run"], ttlSeconds: 300)
        do { _ = try await Self.client(transport).createOwnerPairingOffer(unknownScope); XCTFail() } catch { XCTAssertEqual(error as? HostClientError, .invalidRequest) }
        let sent = await transport.sent()
        XCTAssertTrue(sent.isEmpty, "a refused draft sends nothing")
    }

    func testReceiptReadAndPinnedInvitationDelivery() async throws {
        let input = CreateOwnerPairingOfferInput(status: try Self.status(), role: .clientIOS, scopes: OwnerPairingScopes.historical, ttlSeconds: 600)
        let text = Self.invitationText(role: "client-ios", scopes: OwnerPairingScopes.historical)
        let receipt = try JSONDecoder().decode(OwnerPairingReceipt.self, from: Data(Self.receiptJSON(input, text: text).utf8))
        let escaped = String(data: try JSONSerialization.data(withJSONObject: [text], options: [.withoutEscapingSlashes]), encoding: .utf8)!.dropFirst().dropLast()
        let available = Data(#"{"version":1,"hostId":"\#(Self.host)","clientRequestId":"\#(input.clientRequestId)","offerId":"\#(Self.offerID)","availability":"available","invitation":{"text":\#(escaped),"sha256":"\#(Self.sha(text))","deliveriesRemaining":0}}"#.utf8)
        let gone = Data(#"{"version":1,"hostId":"\#(Self.host)","clientRequestId":"\#(input.clientRequestId)","offerId":"\#(Self.offerID)","availability":"unavailable","reason":"not_retained"}"#.utf8)
        let swapped = Self.invitationText(role: "client-ios", scopes: OwnerPairingScopes.historical, code: "SWAPcodeSWAPcodeSWAPcodeSWAPcodeSWAPcode123")
        let swappedEscaped = String(data: try JSONSerialization.data(withJSONObject: [swapped], options: [.withoutEscapingSlashes]), encoding: .utf8)!.dropFirst().dropLast()
        let forged = Data(#"{"version":1,"hostId":"\#(Self.host)","clientRequestId":"\#(input.clientRequestId)","offerId":"\#(Self.offerID)","availability":"available","invitation":{"text":\#(swappedEscaped),"sha256":"\#(Self.sha(swapped))","deliveriesRemaining":0}}"#.utf8)
        let transport = OwnerPairingScriptedTransport([.success(404, Data(#"{"error":"not_found"}"#.utf8)), .success(200, available), .success(200, gone), .success(200, forged)])
        let client = Self.client(transport)
        let absent = try await client.ownerPairingRecord(clientRequestID: input.clientRequestId)
        XCTAssertNil(absent, "absent receipt is unconfirmed, never an error that implies no effect")
        guard case .available(let offerID, let invitation) = try await client.ownerPairingInvitation(for: receipt) else { return XCTFail() }
        XCTAssertEqual(offerID, Self.offerID); XCTAssertEqual(invitation.text, text)
        let second = try await client.ownerPairingInvitation(for: receipt)
        XCTAssertEqual(second, .unavailable(offerID: Self.offerID, reason: .notRetained))
        do { _ = try await client.ownerPairingInvitation(for: receipt); XCTFail("a text that does not match the receipt pin is refused") }
        catch { XCTAssertEqual(error as? HostClientError, .contractMismatch) }
        let sent = await transport.sent()
        XCTAssertEqual(sent[1].url?.query, "requestHash=\(receipt.requestHash)")
        XCTAssertEqual(sent[1].url?.path, "/v1/owner/app-client-pairing/receipts/\(input.clientRequestId)/invitation")
    }
}

actor OwnerPairingScriptedTransport: HTTPTransport {
    enum Step: Sendable { case success(Int, Data); case failure(URLError) }
    private var steps: [Step]
    private var captured: [URLRequest] = []
    private var protected = 0
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
    func sendWithoutRedirects(_ request: URLRequest) async throws -> TransportResponse { protected += 1; return try await send(request) }
    func sent() -> [URLRequest] { captured }
    func protectedCount() -> Int { protected }
}
