import Foundation
import XCTest
@testable import DexterHostClient
@testable import DexterClientIdentity

private actor R8ClaimJournal: ClientClaimJournal {
    var entry: ClientClaimJournalEntry?
    func loadOnly(scope:ClientIdentityScope) async throws -> ClientClaimJournalEntry? { entry }
    func reserve(_ reservation:ClientClaimReservation) async throws {
        guard entry == nil else { throw ClientIdentityFailure.conflict }; entry = try .init(reservation:reservation,claimID:nil)
    }
    func saveAcknowledgement(_ reservation:ClientClaimReservation,claimID:String) async throws {
        guard entry?.reservation.matches(reservation) == true else { throw ClientIdentityFailure.conflict }
        entry = try .init(reservation:reservation,claimID:claimID)
    }
}

@MainActor final class McpPrivateInputRemoteR8Tests: XCTestCase {
    func testRealProductPairedTLSLargeFormAndHistoryThroughActualSDK() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let node = env["DEXTER_TEST_NODE"], let source = env["DEXTER_R8_SOURCE"] else { throw XCTSkip("Requires isolated R8 source build and explicit Node executable") }
        let process = Process(), output = Pipe()
        process.executableURL = URL(fileURLWithPath:node)
        process.arguments = [source + "/tests/fixtures/r8-private-input-sdk-host.mjs"]
        process.environment = ["DEXTER_R8_SOURCE":source,"PATH":"/usr/bin:/bin"]
        process.standardOutput = output; process.standardError = FileHandle.nullDevice
        try process.run()
        defer { if process.isRunning { process.terminate(); process.waitUntilExit() } }
        var line = Data()
        while line.count < 32_768 {
            guard let byte = try output.fileHandleForReading.read(upToCount:1), !byte.isEmpty else { throw ClientIdentityFailure.unavailable }
            if byte.first == 10 { break }; line.append(byte)
        }
        let info = try XCTUnwrap(JSONSerialization.jsonObject(with:line) as? [String:Any]), raw = try XCTUnwrap(info["bundle"] as? [String:Any])
        let url = try XCTUnwrap(URL(string:try XCTUnwrap(raw["hostUrl"] as? String)))
        let der = try XCTUnwrap(Data(base64Encoded:try XCTUnwrap(raw["hostCertificateDER"] as? String)))
        let host = try PinnedClientHost(url:url,certificateDER:der,fingerprint:try XCTUnwrap(raw["hostFingerprint"] as? String))
        let installation = try XCTUnwrap(raw["installationId"] as? String)
        let bundle = try ClientPairingBundle(host:host,installationID:installation,offerID:try XCTUnwrap(raw["offerId"] as? String),role:.clientMac,
            expiresAt:Date(timeIntervalSince1970:(try XCTUnwrap(raw["expiresAt"] as? Double))/1000),code:try XCTUnwrap(raw["code"] as? String))
        let identity = try ClientNativeIdentity.ephemeralFixture()
        let scope = try ClientIdentityScope(installationID:installation,localBindingID:String(repeating:"e",count:32),role:.clientMac,hostFingerprint:host.fingerprint)
        let pairing = try ClientPairingSession(bundle:bundle,scope:scope,identity:identity,journal:R8ClaimJournal())
        _ = try await pairing.begin(name:"R8 actual SDK synthetic")
        var approved: PairedHostBinding?
        for _ in 0..<100 {
            if case .approved(let binding) = try await pairing.status() { approved = binding; break }
            try await Task.sleep(for:.milliseconds(20))
        }
        let binding = try XCTUnwrap(approved)
        let native = try NativeHostTransport(identity:identity,binding:binding)
        let transport = PairedHTTPTransport(binding:binding,sender:NativePairedSender(native:native))
        let client = HostClient(baseURL:url,accessPolicy:.pairedHost(binding),transport:transport)
        defer { client.close() }
        let health = try await client.health(); XCTAssertEqual(health.installationId,installation)
        let active = try await client.mcpPrivateInputPage()
        XCTAssertEqual(active.activeRequestCount,2); XCTAssertEqual(active.retainedRequestCount,302)
        XCTAssertEqual(active.summaries.count,2); XCTAssertEqual(active.unverifiedRequestCount,2); XCTAssertTrue(active.legacyRequests.isEmpty)
        var cursor: String?, ids = Set<String>(), pageCount = 0
        repeat {
            let page = try await client.mcpPrivateInputPage(history:true,after:cursor)
            XCTAssertLessThanOrEqual(page.summaries.count,100)
            for item in page.summaries { XCTAssertTrue(ids.insert(item.id).inserted); XCTAssertEqual(item.detailState,"not_loaded") }
            cursor = page.nextCursor; pageCount += 1; XCTAssertLessThanOrEqual(pageCount,4)
        } while cursor != nil
        XCTAssertEqual(ids.count,302); XCTAssertEqual(pageCount,4)
        let input = try await client.mcpPrivateInput(id:try XCTUnwrap(info["inputId"] as? String))
        XCTAssertEqual(input.requests.count,8); XCTAssertGreaterThan(try JSONEncoder().encode(input).count,262_144)
        XCTAssertEqual(input.forms?.count,8)
        let contents = Dictionary(uniqueKeysWithValues:try XCTUnwrap(input.forms).map { form in
            (form.key,Dictionary(uniqueKeysWithValues:form.fields.map { ($0.name,JSONValue.string(String(repeating:"\0",count:$0.name == "v0" ? 10_000 : $0.name == "v1" ? 850 : 0))) }))
        })
        let answer = try XCTUnwrap(RespondMcpPrivateInputInput(input:input,hostID:installation,answer:.accept(contents)))
        XCTAssertGreaterThan(try JSONEncoder().encode(answer).count,262_144)
        let receipt = try await client.respondMcpPrivateInput(id:input.id,answer)
        XCTAssertEqual(receipt.state,.answered); XCTAssertEqual(receipt.clientRequestId,answer.clientRequestId)
        XCTAssertGreaterThan(try JSONEncoder().encode(receipt).count,262_144)
        let reconciled = try await client.mcpPrivateInput(id:input.id)
        XCTAssertEqual(reconciled,receipt)
        let replay = try await client.respondMcpPrivateInput(id:input.id,answer)
        XCTAssertEqual(replay,receipt)
        await client.close().value
    }

    func testPageNeverTreatsSummaryAsHydratedAndRejectsCounterOrCursorForgery() throws {
        let page = #"{"version":2,"view":"active","summaries":[],"nextCursor":null,"retainedRequestCount":300,"activeRequestCount":0,"scannedRequestCount":0,"invalidRequestCount":0,"invalidCountScope":"page_envelopes","quarantinedRequestCount":0,"omittedRequestCount":300,"unverifiedRequestCount":0,"incomplete":false}"#
        let good = try JSONDecoder().decode(McpPrivateInputPage.self,from:Data(page.utf8))
        XCTAssertTrue(good.summaries.isEmpty); XCTAssertTrue(good.legacyRequests.isEmpty); XCTAssertFalse(good.incomplete)
        for invalid in [page.replacingOccurrences(of:"\"omittedRequestCount\":300",with:"\"omittedRequestCount\":0"),page.replacingOccurrences(of:"\"nextCursor\":null",with:"\"nextCursor\":\"../escape\""),page.replacingOccurrences(of:"page_envelopes",with:"all_valid_forms")] {
            XCTAssertThrowsError(try JSONDecoder().decode(McpPrivateInputPage.self,from:Data(invalid.utf8)))
        }
    }
}
