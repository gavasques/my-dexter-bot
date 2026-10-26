#if os(macOS)
import CryptoKit
import DexterClientIdentity
import DexterHostClient
import Foundation
import XCTest
@testable import DexterAppCore

@MainActor final class McpRegistrationClientR4Tests: XCTestCase {
    private func fixture(_ wire: McpR4Transport, port: Int) async throws -> (DexterAppModel, HostClient, McpRegistrationSession) {
        let client = HostClient(baseURL: URL(string: "http://127.0.0.1:\(port)")!, transport: wire)
        let pairing = PairedHostOnboarding(journal: UnavailableClientClaimJournal(), storage: EphemeralPairedHostStateStorage(), identityStorage: { _ in McpR4ForbiddenIdentityStorage() })
        let model = DexterAppModel(client: client, storage: McpR4StateStorage(), pairing: pairing)
        await model.refresh(); XCTAssertTrue(model.isOnline)
        return (model, client, try await model.makeMcpRegistrationSession(client: client))
    }
    private func draft() throws -> McpHttpDraft {
        try McpHttpDraft(name: "Synthetic", url: "https://example.test/mcp", authentication: .oauth, serverID: "http-r4")
    }
    private func held(_ wire: McpR4Transport) async throws {
        for _ in 0..<150 { if await wire.isHeld() { return }; try await Task.sleep(for: .milliseconds(2)) }
        XCTFail("Synthetic receipt response was not held")
    }
    func testSuccessOneEffectAndExplicitExactReplayPreserveOriginalBytesWithoutGrantOrAuthentication() async throws {
        let wire = McpR4Transport(), (model, client, session) = try await fixture(wire, port: 49901)
        try session.begin(httpDraft: draft()); let original = try XCTUnwrap(session.request)
        await session.submit(); XCTAssertEqual(session.state, .registered); XCTAssertNotNil(session.registration)
        XCTAssertEqual(session.originalReceipt, session.registration?.receipt)
        let reopened = try await model.makeMcpRegistrationSession(client: client); XCTAssertTrue(reopened === session)
        await reopened.submit() // Already sent: a read, never another POST.
        _ = try await client.registerMcpServer(original, namespace: session.namespace) // Explicit low-level exact replay.
        let count = await wire.effects(); XCTAssertEqual(count, 1)
        let posts = await wire.postBodies(); XCTAssertEqual(posts, [original.bodyData, original.bodyData])
        let body = try JSONDecoder().decode(JSONValue.self, from: original.bodyData)
        guard case .object(let b) = body, case .object(let d) = b["definition"] else { return XCTFail("Missing strict request") }
        XCTAssertEqual(Set(b.keys), ["requestId", "expectedInstancePin", "definition"]); XCTAssertNil(d["source"])
        XCTAssertNil(b["origin"]); XCTAssertNil(b["authority"])
        let changed = try McpHttpDraft(name: "Changed", url: "https://example.test/mcp", authentication: .oauth, serverID: "http-r4")
        let changedRequest = try McpRegistrationRequest(httpDraft: changed, requestID: original.requestID)
        do { _ = try await client.registerMcpServer(changedRequest, namespace: session.namespace); XCTFail("Changed input must conflict") }
        catch let error as HostClientError { XCTAssertEqual(error, .conflict) }
        let calls = await wire.mcpCalls()
        XCTAssertTrue(calls.allSatisfy { $0.contains("/v1/mcp/registrations") })
        let finalCount = await wire.effects(); XCTAssertEqual(finalCount, 1)
        client.close(); model.closeThreadPresentation()
    }
    func testCommittedLostACKReadsOriginalOnceAndNeverRepostsAfterReadFailureOrReopen() async throws {
        let wire = McpR4Transport(), (model, client, session) = try await fixture(wire, port: 49902)
        await wire.loseNextACK(); try session.begin(httpDraft: draft()); let original = try XCTUnwrap(session.request)
        await session.submit(); XCTAssertEqual(session.state, .registered)
        let calls = await wire.mcpCalls(); XCTAssertEqual(calls, ["POST /v1/mcp/registrations", "GET /v1/mcp/registrations/" + original.requestID])
        await wire.failNextRead(); await session.reconcile()
        XCTAssertEqual(session.state, .unknown); XCTAssertNotNil(session.originalReceipt)
        let reopened = try await model.makeMcpRegistrationSession(client: client); XCTAssertTrue(reopened === session)
        await reopened.submit(); XCTAssertEqual(reopened.state, .registered); XCTAssertEqual(reopened.request, original)
        let effects = await wire.effects(), posts = await wire.postBodies(); XCTAssertEqual(effects, 1); XCTAssertEqual(posts, [original.bodyData])
        client.close(); model.closeThreadPresentation()
    }
    func testRemovedReplacedAndMissingReceiptDoNotClaimCurrentAccessOrStartAnotherEffect() async throws {
        let wire = McpR4Transport(), (model, client, session) = try await fixture(wire, port: 49903)
        try session.begin(httpDraft: draft()); await session.submit()
        let original = try XCTUnwrap(session.request), receipt = try XCTUnwrap(session.originalReceipt)
        await wire.setAssociation("removed"); await session.reconcile()
        XCTAssertEqual(session.state, .removed); XCTAssertEqual(session.registration?.receipt, receipt)
        await wire.setAssociation("replaced"); await session.submit()
        XCTAssertEqual(session.state, .replaced); XCTAssertEqual(session.registration?.receipt, receipt)
        await wire.hideReceipt(); await session.reconcile(); XCTAssertEqual(session.state, .unknown)
        do { try session.begin(httpDraft: draft()); XCTFail("Unknown intention must not be replaced with a new ID") }
        catch let error as HostClientError { XCTAssertEqual(error, .conflict) }
        XCTAssertEqual(session.request, original); await session.submit()
        let posts = await wire.postBodies(); XCTAssertEqual(posts, [original.bodyData])
        let calls = await wire.mcpCalls(); XCTAssertTrue(calls.allSatisfy { $0.contains("/registrations") })
        client.close(); model.closeThreadPresentation()
    }
    func testHeldMutationAndHeldReceiptRejectRebindingTwoBasesWithIdenticalIdentityAndRevision() async throws {
        for hold in ["POST", "GET"] {
            let a = McpR4Transport(), b = McpR4Transport()
            let (modelA, clientA, old) = try await fixture(a, port: hold == "POST" ? 49904 : 49906)
            let (modelB, clientB, new) = try await fixture(b, port: hold == "POST" ? 49905 : 49907)
            XCTAssertEqual(modelA.bots, modelB.bots); XCTAssertEqual(old.namespace.installationID, new.namespace.installationID)
            XCTAssertNotEqual(old.namespace.baseURL, new.namespace.baseURL)
            try old.begin(httpDraft: draft()); let original = try XCTUnwrap(old.request)
            await a.holdNext(hold)
            let task = Task { await old.submit() }; try await held(a)
            modelA.hostAddress = modelB.hostAddress; modelA.configureHost()
            await a.release(); await task.value
            XCTAssertEqual(old.state, .unknown); XCTAssertEqual(old.request, original); XCTAssertFalse(old.scopeMatches)
            XCTAssertNil(old.registration); await old.submit(); await old.reconcile()
            let callsA = await a.mcpCalls(), callsB = await b.mcpCalls()
            XCTAssertEqual(callsA.count, hold == "POST" ? 1 : 2); XCTAssertEqual(callsB, [])
            XCTAssertFalse(old.busy); clientA.close(); clientB.close(); modelA.closeThreadPresentation(); modelB.closeThreadPresentation()
        }
    }
    func testNativeCanonicalInputVectorAndTamperedReceiptNeverBecomeSuccess() async throws {
        // Fixed Node/R1 canonical JSON vector, including UTF16 ordering and ECMAScript integer-property order.
        let original: JSONValue = .object(["id": .string("http-vector"), "name": .string("Vector😀\u{2028}é"),
            "transport": .object(["type": .string("streamable_http"), "url": .string("https://example.test/mcp"),
                "headers": .object(["10": .object(["kind": .string("secret"), "key": .string("ten")]), "2": .object(["kind": .string("secret"), "key": .string("two")])])]),
            "runsOn": .string("any"), "auth": .string("broker")])
        let pinned = try McpRegistrationRequest(definition: original, requestID: "mac:vector")
        XCTAssertEqual(pinned.inputHash, "c0d34b2f8deb140d3b42c19433e63f9a0e781f73a67a7e851284245a8ac0627d")
        let wire = McpR4Transport(), (model, client, session) = try await fixture(wire, port: 49910)
        await wire.tamperReceipts(); try session.begin(httpDraft: draft()); await session.submit()
        XCTAssertEqual(session.state, .unknown); XCTAssertEqual(session.lastFailure, .contractMismatch)
        XCTAssertNil(session.registration); XCTAssertNil(session.originalReceipt)
        let count = await wire.effects(), posts = await wire.postBodies(); XCTAssertEqual(count, 1); XCTAssertEqual(posts.count, 1)
        await session.submit(); let noReplay = await wire.postBodies(); XCTAssertEqual(noReplay.count, 1)
        client.close(); model.closeThreadPresentation()
    }
    func testOwnerChangeSecretDefinitionAndLegacyHostStayExplicitWithoutFallback() async throws {
        let wire = McpR4Transport(), (model, client, session) = try await fixture(wire, port: 49908)
        let draft = try draft()
        XCTAssertThrowsError(try session.begin(definition: draft.definition)) // source is not admissible authority.
        var forged = try XCTUnwrap({ if case .object(let d) = draft.definition { return d }; return nil }())
        forged.removeValue(forKey: "source"); forged["origin"] = .object(["kind": .string("owner_local")])
        XCTAssertThrowsError(try session.begin(definition: .object(forged)))
        forged.removeValue(forKey: "origin")
        forged["transport"] = .object(["type": .string("streamable_http"), "url": .string("https://user:synthetic-secret@example.test/mcp"), "headers": .object([:])])
        XCTAssertThrowsError(try session.begin(definition: .object(forged)))
        forged["transport"] = .object(["type": .string("streamable_http"), "url": .string("https://example.test/mcp"), "headers": .object(["authorization": .object(["kind": .string("literal"), "value": .string("synthetic-secret")])])])
        XCTAssertThrowsError(try session.begin(definition: .object(forged)))
        let zero = await wire.mcpCalls(); XCTAssertEqual(zero, [])
        try session.begin(httpDraft: draft); await wire.setOwner("owner-other")
        await session.submit(); XCTAssertTrue(session.invalidated); XCTAssertFalse(session.mutationSent)
        let afterOwner = await wire.mcpCalls(); XCTAssertEqual(afterOwner, [])
        client.close(); model.closeThreadPresentation()
        let legacy = McpR4Transport(), (legacyModel, legacyClient, legacySession) = try await fixture(legacy, port: 49909)
        await legacy.setLegacy(); try legacySession.begin(httpDraft: draft); await legacySession.submit()
        XCTAssertEqual(legacySession.state, .legacyUnavailable); XCTAssertTrue(legacySession.requiresReconciliation)
        let original = try XCTUnwrap(legacySession.request); await legacySession.submit()
        let legacyCalls = await legacy.mcpCalls()
        XCTAssertEqual(legacyCalls, ["POST /v1/mcp/registrations", "GET /v1/mcp/registrations/" + original.requestID, "GET /v1/mcp/registrations/" + original.requestID])
        let effects = await legacy.effects(); XCTAssertEqual(effects, 0)
        legacyClient.close(); legacyModel.closeThreadPresentation()
    }
}
@MainActor private final class McpR4StateStorage: DexterAppStateStorage {
    var data: Data?
    func readData() -> Data? { data }
    func writeData(_ value: Data) { data = value }
    func removeData() { data = nil }
}
private actor McpR4ForbiddenIdentityStorage: ClientIdentityStorage {
    func load(_ scope: ClientIdentityScope) async throws -> ClientNativeIdentity? { throw ClientIdentityFailure.forbidden }
    func provision(_ scope: ClientIdentityScope) async throws -> ClientNativeIdentity { throw ClientIdentityFailure.forbidden }
}
/// Stateful synthetic HTTP peer. No sockets/processes/auth/network; applies one effect before an optional lost ACK.
private actor McpR4Transport: HTTPTransport {
    private var calls: [String] = [], bodies: [Data] = [], receipts: [String: [String: Any]] = [:], originals: [String: Data] = [:]
    private var effectCount = 0, owner = "owner-r4", association = "registered", hidden = false, legacy = false, loseACK = false, readFailure = false
    private var tampered = false
    private var holdMethod: String?, heldResponse: CheckedContinuation<Void, Never>?
    func mcpCalls() -> [String] { calls.filter { $0.contains("/v1/mcp/") } }
    func postBodies() -> [Data] { bodies }
    func effects() -> Int { effectCount }
    func tamperReceipts() { tampered = true }
    func loseNextACK() { loseACK = true }
    func failNextRead() { readFailure = true }
    func setAssociation(_ value: String) { association = value }
    func hideReceipt() { hidden = true }
    func setLegacy() { legacy = true }
    func setOwner(_ value: String) { owner = value }
    func holdNext(_ method: String) { holdMethod = method }
    func isHeld() -> Bool { heldResponse != nil }
    func release() { heldResponse?.resume(); heldResponse = nil }
    func send(_ request: URLRequest) async throws -> TransportResponse {
        let path = request.url!.path, method = request.httpMethod ?? "GET"
        calls.append(method + " " + path)
        let data: Data
        var status = 200, lose = false
        switch path {
        case "/health": data = try encode(["protocolVersion": 1, "mode": "local-development", "engineRouting": "synthetic", "remotePairing": "not_implemented", "hostId": "host-r4", "state": ["hostId": "host-r4", "ownerId": owner]])
        case "/v1/bots": data = try encode(["items": [["id": "bot-r4", "name": "Same synthetic bot", "profileId": "profile-r4", "ownerId": "owner-r4", "engine": "claude", "revision": 0, "createdAt": 1]]])
        case "/v1/actions", "/v1/events", "/v1/teams", "/v1/live-voice/settings": data = try encode(["items": [], "nextCursor": 0])
        case "/v1/mcp/registrations" where method == "POST":
            let body = try XCTUnwrap(request.httpBody); bodies.append(body)
            if legacy { return .init(statusCode: 404, data: Data()) }
            let input = try JSONSerialization.jsonObject(with: body) as! [String: Any], id = input["requestId"] as! String
            if let previous = originals[id], previous != body { return .init(statusCode: 409, data: Data()) }
            if receipts[id] == nil { receipts[id] = try receipt(input); originals[id] = body; effectCount += 1 }
            var projected = receipts[id]!; if tampered { projected["originHash"] = String(repeating: "a", count: 64) }
            data = try encode(["receipt": projected]); status = 201
            lose = loseACK; loseACK = false
        default:
            guard method == "GET", path.hasPrefix("/v1/mcp/registrations/") else { throw HostClientError.notFound }
            if legacy { return .init(statusCode: 404, data: Data()) }
            if readFailure { readFailure = false; throw URLError(.networkConnectionLost) }
            let id = String(path.dropFirst("/v1/mcp/registrations/".count))
            if var receipt = receipts[id], !hidden { if tampered { receipt["originHash"] = String(repeating: "a", count: 64) }; data = try encode(["registration": ["receipt": receipt, "instanceState": association]]) }
            else { data = try encode(["registration": NSNull()]) }
        }
        if path.hasPrefix("/v1/mcp/registrations"), holdMethod == method { holdMethod = nil; await withCheckedContinuation { heldResponse = $0 } }
        if lose { throw URLError(.networkConnectionLost) }
        return .init(statusCode: status, data: data)
    }
    private func encode(_ value: [String: Any]) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes]) }
    private func hash(_ value: [String: Any]) throws -> String { SHA256.hash(data: try encode(value)).map { String(format: "%02x", $0) }.joined() }
    private func receipt(_ input: [String: Any]) throws -> [String: Any] {
        let definition = input["definition"] as! [String: Any], instance = definition["id"] as! String
        var normalized = definition; normalized["source"] = ["format": "manual", "name": instance]
        let idHash = try hash(["requestId": input["requestId"]!]), inputHash = try hash(definition), pin = try hash(normalized)
        let origin = try hash(["version": 1, "installationId": "host-r4", "ownerId": owner, "origin": ["kind": "owner_local"]])
        let generation = "12345678-1234-1234-1234-123456789abc"
        let instancePin = SHA256.hash(data: Data("{\"definitionHash\":\"\(pin)\",\"generation\":\"\(generation)\"}".utf8)).map { String(format: "%02x", $0) }.joined()
        return ["version": 1, "operation": "mcp.register", "receiptId": "abcdef12-1234-1234-1234-123456789abc", "requestIdHash": idHash,
            "requestKeyHash": try hash(["operation": "mcp.register", "originHash": origin, "requestIdHash": idHash]),
            "requestHash": try hash(["version": 1, "operation": "mcp.register", "expectedInstancePin": NSNull(), "definitionPin": pin, "inputHash": inputHash]),
            "inputHash": inputHash, "originHash": origin, "instanceId": instance, "generation": generation, "definitionPin": pin, "instancePin": instancePin, "registeredAt": 1]
    }
}
#endif
