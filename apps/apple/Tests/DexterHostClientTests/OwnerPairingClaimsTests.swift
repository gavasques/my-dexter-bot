import DexterClientIdentity
@testable import DexterHostClient
import Foundation
import XCTest

/// Owner claims SDK against a scripted transport (no network, Keychain or real host).
final class OwnerPairingClaimsTests: XCTestCase {
    static let host = "host_vector"
    static let claimID = "ccl_11111111-2222-4333-8444-555555555555"
    static let offerID = "cof_11111111-2222-4333-8444-555555555555"
    static let historical = OwnerPairingScopes.historical
    static func claimJSON(status: String = "pending", scopes: [String] = historical, approvedDeviceId: String? = nil, binding: String = "null") -> String {
        let list = scopes.map { "\"\($0)\"" }.joined(separator: ",")
        let approved = approvedDeviceId.map { "\"\($0)\"" } ?? "null"
        return #"{"claimId":"\#(claimID)","offerId":"\#(offerID)","kind":"pair","role":"client-mac","scopes":[\#(list)],"targetDeviceId":null,"approvedDeviceId":\#(approved),"clientFingerprint":"\#(String(repeating: "b", count: 64))","name":"Mac sintético","status":"\#(status)","createdAt":1800000000000,"expiresAt":1800000600000,"decidedAt":null,"claimPin":"\#(String(repeating: "a", count: 64))","offerClientRequestId":null,"binding":\#(binding)}"#
    }
    static func listJSON(revision: Int = 3, items: [String] = [claimJSON()]) -> Data {
        Data(#"{"version":1,"hostId":"\#(host)","revision":\#(revision),"journalPin":"\#(String(repeating: "c", count: 64))","availability":"available","reason":null,"items":[\#(items.joined(separator: ","))],"truncated":false}"#.utf8)
    }
    static func list() throws -> OwnerPairingClaimsList { try JSONDecoder().decode(OwnerPairingClaimsList.self, from: listJSON()) }
    static func receiptJSON(_ input: DecideOwnerPairingClaimInput, outcome: String = "approved", bindingScopes: [String] = historical, requestHash: String? = nil) -> String {
        let list = historical.map { "\"\($0)\"" }.joined(separator: ","), bound = bindingScopes.map { "\"\($0)\"" }.joined(separator: ",")
        let binding = outcome == "approved" ? #"{"deviceId":"dev_synthetic","role":"client-mac","scopes":[\#(bound)],"fingerprint":"\#(String(repeating: "b", count: 64))","generation":1,"revision":1}"# : "null"
        return #"{"version":1,"hostId":"\#(host)","clientRequestId":"\#(input.clientRequestId)","requestHash":"\#(requestHash ?? input.requestHash!)","operation":"\#(input.decision.rawValue)","previousRevision":\#(input.expectedRevision),"revision":\#(input.expectedRevision + 1),"outcome":"\#(outcome)","claim":{"claimId":"\#(claimID)","offerId":"\#(offerID)","kind":"pair","role":"client-mac","scopes":[\#(list)],"targetDeviceId":null,"clientFingerprint":"\#(String(repeating: "b", count: 64))","name":"Mac sintético","claimPin":"\#(String(repeating: "a", count: 64))"},"binding":\#(binding),"grantsCreated":0,"createdAt":1800000000000}"#
    }
    static func client(_ transport: OwnerPairingScriptedTransport) -> HostClient { HostClient(baseURL: URL(string: "http://127.0.0.1:4999")!, transport: transport) }

    func testDecisionHashMatchesTheHostCanonicalVectorAndPathCarriesTheClaim() throws {
        let list = try Self.list(), claim = try XCTUnwrap(list.items.first)
        let input = DecideOwnerPairingClaimInput(list: list, claim: claim, decision: .approve, clientRequestId: "0b5c7a52-3f7e-4d4b-9a51-6c1d2e3f4a5d")
        XCTAssertEqual(input.expectedJournalPin, String(repeating: "c", count: 64))
        XCTAssertEqual(input.requestHash, "6e143373ccf9d8a9ccbf8c605971d7077ffd658e8f89a788a1261dbb22521442")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(input)) as? [String: Any])
        XCTAssertEqual(Set(body.keys), ["expectedHostId", "expectedRevision", "expectedJournalPin", "clientRequestId", "decision", "expectedClaimPin", "expectedClientFingerprint"],
                       "no owner/grant/scope/authority field; the claim id travels in the path")
    }

    func testOnlyOwnerLoopbackAndNothingIsSentOtherwise() async throws {
        let transport = OwnerPairingScriptedTransport([])
        let unpaired = HostClient(baseURL: URL(string: "https://base.example")!, accessPolicy: .unpairedHost, transport: transport)
        do { _ = try await unpaired.ownerPairingClaims(); XCTFail() } catch { XCTAssertEqual(error as? HostClientError, .forbidden) }
        let list = try Self.list(), input = DecideOwnerPairingClaimInput(list: list, claim: list.items[0], decision: .approve)
        do { _ = try await unpaired.decideOwnerPairingClaim(input); XCTFail() } catch { XCTAssertEqual(error as? HostClientError, .forbidden) }
        let sent = await transport.sent()
        XCTAssertTrue(sent.isEmpty)
    }

    func testListIsValidatedAndReadWithoutRedirects() async throws {
        let unavailable = Data(#"{"version":1,"hostId":"\#(Self.host)","revision":1,"journalPin":null,"availability":"unavailable","reason":"app_client_channel_unconfigured","items":[],"truncated":false}"#.utf8)
        let lying = Data(#"{"version":1,"hostId":"\#(Self.host)","revision":1,"journalPin":null,"availability":"unavailable","reason":"host_closing","items":[\#(Self.claimJSON())],"truncated":false}"#.utf8)
        let decided = Self.listJSON(items: [Self.claimJSON(status: "rejected")])
        let transport = OwnerPairingScriptedTransport([.success(200, unavailable), .success(200, lying), .success(200, decided)])
        let client = Self.client(transport)
        let value = try await client.ownerPairingClaims()
        XCTAssertEqual(value.reason, .channelUnconfigured); XCTAssertTrue(value.items.isEmpty)
        for _ in 0..<2 {
            do { _ = try await client.ownerPairingClaims(); XCTFail() } catch { XCTAssertEqual(error as? HostClientError, .contractMismatch) }
        }
        let protected = await transport.protectedCount()
        XCTAssertEqual(protected, 3)
    }

    func testDecisionVerifiesReceiptAndNeverAcceptsAScopeChange() async throws {
        let list = try Self.list(), input = DecideOwnerPairingClaimInput(list: list, claim: list.items[0], decision: .approve)
        let approvedClaim = Self.claimJSON(status: "approved", approvedDeviceId: "dev_synthetic")
        let good = Data(#"{"receipt":\#(Self.receiptJSON(input)),"claim":\#(approvedClaim)}"#.utf8)
        let transport = OwnerPairingScriptedTransport([.success(201, good)])
        let record = try await Self.client(transport).decideOwnerPairingClaim(input)
        XCTAssertEqual(record.receipt.outcome, .approved); XCTAssertEqual(record.receipt.binding?.scopes, Self.historical); XCTAssertEqual(record.receipt.grantsCreated, 0)
        let requests = await transport.sent()
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.httpMethod, "POST"); XCTAssertEqual(request.url?.path, "/v1/owner/app-client-pairing/claims/\(Self.claimID)/decision")
        let elevated = Data(#"{"receipt":\#(Self.receiptJSON(input, bindingScopes: (Self.historical + ["outputs.read"]).sorted())),"claim":\#(approvedClaim)}"#.utf8)
        let cases: [(OwnerPairingScriptedTransport.Step, HostClientError)] = [
            (.failure(URLError(.networkConnectionLost)), .mutationOutcomeUnknown),
            (.success(503, Data(#"{"error":"outcome_unknown"}"#.utf8)), .mutationOutcomeUnknown),
            (.success(201, elevated), .mutationOutcomeUnknown),
            (.success(201, Data(#"{"receipt":\#(Self.receiptJSON(input, requestHash: String(repeating: "f", count: 64))),"claim":null}"#.utf8)), .mutationOutcomeUnknown),
            (.success(409, Data(#"{"error":"conflict"}"#.utf8)), .conflict),
            (.success(400, Data(#"{"error":"invalid_input"}"#.utf8)), .invalidRequest),
            (.success(403, Data(#"{"error":"forbidden"}"#.utf8)), .forbidden),
        ]
        for (step, expected) in cases {
            do { _ = try await Self.client(OwnerPairingScriptedTransport([step])).decideOwnerPairingClaim(input); XCTFail("\(expected)") }
            catch { XCTAssertEqual(error as? HostClientError, expected) }
        }
    }

    func testDecisionReceiptReadIsUnconfirmedWhenAbsent() async throws {
        let list = try Self.list(), input = DecideOwnerPairingClaimInput(list: list, claim: list.items[0], decision: .reject)
        let found = Data(#"{"receipt":\#(Self.receiptJSON(input, outcome: "rejected")),"claim":\#(Self.claimJSON(status: "rejected"))}"#.utf8)
        let transport = OwnerPairingScriptedTransport([.success(404, Data(#"{"error":"not_found"}"#.utf8)), .success(200, found)])
        let client = Self.client(transport)
        let absent = try await client.ownerPairingDecision(clientRequestID: input.clientRequestId)
        XCTAssertNil(absent)
        let record = try await client.ownerPairingDecision(clientRequestID: input.clientRequestId)
        XCTAssertTrue(record?.receipt.matches(input) == true); XCTAssertEqual(record?.claim?.status, .rejected)
        let sent = await transport.sent()
        XCTAssertEqual(sent.first?.url?.path, "/v1/owner/app-client-pairing/decisions/\(input.clientRequestId)")
    }
}
