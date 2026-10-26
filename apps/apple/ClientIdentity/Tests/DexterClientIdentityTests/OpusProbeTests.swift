import XCTest
import Foundation
import Security
@testable import DexterClientIdentity

/// Opus R2 reviewer probes. Memory-only journal: proves library call ordering, not SDK durability.
actor ProbeJournal: ClientClaimJournal {
    var entries: [Data:ClientClaimJournalEntry] = [:]
    var failReserve = false
    var log: [String] = []
    func loadOnly(scope: ClientIdentityScope) -> ClientClaimJournalEntry? { log.append("load"); return entries[scope.tag] }
    func reserve(_ reservation: ClientClaimReservation) throws {
        log.append("reserve"); if failReserve { throw ClientIdentityFailure.unavailable }
        guard entries[reservation.scope.tag] == nil else { throw ClientIdentityFailure.conflict }
        entries[reservation.scope.tag] = try ClientClaimJournalEntry(reservation:reservation,claimID:nil)
    }
    func saveAcknowledgement(_ reservation: ClientClaimReservation, claimID: String) throws {
        log.append("ack:"+claimID)
        guard let entry = entries[reservation.scope.tag], entry.claimID == nil, entry.reservation.matches(reservation) else { throw ClientIdentityFailure.conflict }
        entries[reservation.scope.tag] = try ClientClaimJournalEntry(reservation:reservation,claimID:claimID)
    }
    func put(_ entry: ClientClaimJournalEntry) { entries[entry.reservation.scope.tag] = entry }
    func setFailReserve() { failReserve = true }
    func events() -> [String] { log }
}

@MainActor final class OpusProbeTests: XCTestCase {
    func scope(_ fixture: ClientTLSFixture, _ c: Character) throws -> ClientIdentityScope {
        try ClientIdentityScope(installationID:"host_fixture",localBindingID:String(repeating:c,count:32),role:.clientIOS,hostFingerprint:fixture.fingerprint)
    }
    func bundle(_ fixture: ClientTLSFixture, offer: String = "offer") throws -> ClientPairingBundle {
        try ClientPairingBundle(host:fixture.host(),installationID:"host_fixture",offerID:offer,role:.clientIOS,expiresAt:Date().addingTimeInterval(300),code:String(repeating:"q",count:32))
    }

    // P1: reservation must be durable BEFORE any network handoff.
    func testOpusReserveFailureNeverHandsOff() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try ClientTLSFixture(identity:identity); defer { fixture.close() }
        let journal = ProbeJournal(); await journal.setFailReserve()
        let session = try ClientPairingSession(bundle:bundle(fixture),scope:scope(fixture,"1"),identity:identity,journal:journal)
        do { _ = try await session.begin(name:"Phone"); XCTFail("claim without durable reservation") } catch { XCTAssertEqual(error as? ClientIdentityFailure,.unavailable) }
        let events = await journal.events(); XCTAssertEqual(events,["load","reserve"])
        try await Task.sleep(for:.milliseconds(300))
        XCTAssertEqual(try fixture.requests(),0,"network handoff happened before/without reservation")
        await session.close().wait()
    }
    // P2: ACK persisted before begin returns; order load -> reserve -> (network) -> ack.
    func testOpusAckPersistedBeforeReturnAndConcurrentBeginsSingleClaim() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try ClientTLSFixture(identity:identity); defer { fixture.close() }
        let journal = ProbeJournal(), s = try scope(fixture,"2")
        let a = try ClientPairingSession(bundle:bundle(fixture),scope:s,identity:identity,journal:journal)
        let b = try ClientPairingSession(bundle:bundle(fixture,offer:"offer_b"),scope:s,identity:identity,journal:journal)
        async let ra: String? = try? a.begin(name:"Phone"); async let rb: String? = try? b.begin(name:"Phone"); async let rc: String? = try? a.begin(name:"Phone")
        let results = await [ra,rb,rc].compactMap { $0 }
        XCTAssertEqual(results,["claim_fixture"],"exactly one concurrent begin may claim")
        XCTAssertEqual(try fixture.requests(),1)
        let loaded = await journal.loadOnly(scope:s); XCTAssertEqual(loaded?.claimID,"claim_fixture")
        let events = await journal.events(); XCTAssertEqual(events.filter { $0.hasPrefix("ack:") },["ack:claim_fixture"])
        XCTAssertLessThan(try XCTUnwrap(events.firstIndex(of:"reserve")),try XCTUnwrap(events.firstIndex(of:"ack:claim_fixture")))
        await a.close().wait(); await b.close().wait()
    }
    // P3: status/restore require the loaded entry to match identity/host/claim exactly; zero HTTP otherwise.
    func testOpusStatusAndRestoreRequireExactEntryMatchBeforeNetwork() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), other = try ClientNativeIdentity.ephemeralFixture()
        let fixture = try ClientTLSFixture(identity:identity); defer { fixture.close() }
        let s = try scope(fixture,"3"), host = try fixture.host(), journal = ProbeJournal()
        // Foreign client fingerprint with a saved claim ID.
        await journal.put(try ClientClaimJournalEntry(reservation:ClientClaimReservation(scope:s,host:host,offerID:"offer",clientFingerprint:other.fingerprint),claimID:"claim_fixture"))
        let session = try ClientPairingSession(bundle:bundle(fixture),scope:s,identity:identity,journal:journal)
        do { _ = try await session.status(); XCTFail("foreign fingerprint entry used") } catch { XCTAssertEqual(error as? ClientIdentityFailure,.conflict) }
        // Same pin, different URL.
        let moved = try PinnedClientHost(url:URL(string:"https://127.0.0.1:1")!,certificateDER:fixture.der,fingerprint:fixture.fingerprint)
        await journal.put(try ClientClaimJournalEntry(reservation:ClientClaimReservation(scope:s,host:moved,offerID:"offer",clientFingerprint:identity.fingerprint),claimID:"claim_fixture"))
        do { _ = try await session.status(); XCTFail("moved host entry used") } catch { XCTAssertEqual(error as? ClientIdentityFailure,.conflict) }
        // Restore: claimID mismatch, then unknown entry, then missing entry.
        let storage = MemoryStorage(); await storage.install(s,identity:identity)
        let lifecycle = ClientIdentityLifecycle(scope:s,storage:storage)
        let pending = try PendingClientPairing(scope:s,host:host,claimID:"claim_b")
        await journal.put(try ClientClaimJournalEntry(reservation:ClientClaimReservation(scope:s,host:host,offerID:"offer",clientFingerprint:identity.fingerprint),claimID:"claim_a"))
        do { _ = try await ClientConnectionFactory.restore(pending:pending,lifecycle:lifecycle,journal:journal); XCTFail("mismatched claim restored") } catch { XCTAssertEqual(error as? ClientIdentityFailure,.conflict) }
        await journal.put(try ClientClaimJournalEntry(reservation:ClientClaimReservation(scope:s,host:host,offerID:"offer",clientFingerprint:identity.fingerprint),claimID:nil))
        do { _ = try await ClientConnectionFactory.restore(pending:pending,lifecycle:lifecycle,journal:journal); XCTFail("unknown restored") } catch { XCTAssertEqual(error as? ClientIdentityFailure,.outcomeUnknown) }
        do { _ = try await session.status(); XCTFail("unknown status sent") } catch { XCTAssertEqual(error as? ClientIdentityFailure,.outcomeUnknown) }
        do { _ = try await session.begin(name:"Phone"); XCTFail("unknown re-claimed") } catch { XCTAssertEqual(error as? ClientIdentityFailure,.outcomeUnknown) }
        let counts = await storage.counts(); XCTAssertEqual(counts[1],0,"restore must never provision")
        XCTAssertEqual(try fixture.requests(),0); await session.close().wait()
    }
    // P4: send-time revalidation of the CLIENT certificate independently of the host certificate.
    func testOpusClientCertificateExpiredAtSendWhileHostValid() async throws {
        let made = Date().addingTimeInterval(-364.5*86400)
        let identity = try ClientNativeIdentity.ephemeralFixture(now:made), fixture = try ClientTLSFixture(identity:identity); defer { fixture.close() }
        let later = Date().addingTimeInterval(0.6*86400)
        XCTAssertNoThrow(try CertificateProfile.validate(fixture.der,usage:.server,now:later),"host must still be valid")
        let expired = NativeHostTransport(identity:identity,host:try fixture.host(),probe:ClientTransportProbe(now:{ later },event:{ _ in },receiveCompletion:{ $0() }))
        do { _ = try await expired.send(.json(route:.pairStatus,value:["claimId":"claim"]),timeoutSeconds:3); XCTFail("expired client cert sent") } catch { XCTAssertEqual(error as? ClientIdentityFailure,.expired) }
        XCTAssertEqual(try fixture.requests(),0); await expired.close().wait()
        let control = NativeHostTransport(identity:identity,host:try fixture.host(),probe:ClientTransportProbe(now:{ Date() },event:{ _ in },receiveCompletion:{ $0() }))
        let ok = try await control.send(.json(route:.pairStatus,value:["claimId":"claim"]),timeoutSeconds:3); XCTAssertEqual(ok.statusCode,200)
        XCTAssertEqual(try fixture.requests(),1); await control.close().wait()
    }
    // P5: canonical wire edge cases (no network).
    func testOpusCanonicalWireEdgeCases() throws {
        let id = try ClientResourceID("thread")
        XCTAssertThrowsError(try ClientRequest(route:.appendMessage(id),body:Data(#"{"clientMessageId":"m","content":"a\ud800b"}"#.utf8)))
        XCTAssertThrowsError(try ClientRequest(route:.pairStatus,body:Data(#"{"claimId":"a"} {"claimId":"b"}"#.utf8)))
        XCTAssertThrowsError(try ClientRequest(route:.pairStatus,body:Data([0x7b,0x22,0x63,0x6c,0x61,0x69,0x6d,0x49,0x64,0x22,0x3a,0x22,0xff,0x22,0x7d])))
        let utf32 = "{\"claimId\":\"good\"}".data(using:.utf32LittleEndian)!, bom = Data([0xEF,0xBB,0xBF])+Data(#"{"claimId":"good"}"#.utf8)
        for input in [utf32,bom] { XCTAssertEqual(try ClientRequest(route:.pairStatus,body:input).body,Data(#"{"claimId":"good"}"#.utf8)) }
        let grant = try ClientRequest(route:.putGrant,body:Data(#"{"botId":"bot","tool":"mac.file.append","destination":"d","policy":"allow","policy":"deny","expiresAt":null,"expectedRevision":1.0}"#.utf8))
        let text = String(decoding:grant.body,as:UTF8.self)
        XCTAssertEqual(text.components(separatedBy:"\"policy\"").count,2); XCTAssertTrue(text.contains(#""expectedRevision":1"#)); XCTAssertFalse(text.contains("1.0"))
        // Pure UTF-8 input under cap whose canonical escaping ("/" -> "\/") exceeds the cap.
        let slashes = Data(("{\"clientMessageId\":\"m\",\"content\":\""+String(repeating:"/",count:32768)+"\"}").utf8)
        XCTAssertLessThan(slashes.count,65536)
        XCTAssertThrowsError(try ClientRequest(route:.appendMessage(id),body:slashes),"post-canonical cap must hold for UTF-8 input")
    }
    // P6 (software export-flag placement) was retired with the software policy: persisted software keys cannot satisfy it
    // (identity-policy-r1 evidence) and its probe exported an in-memory private key. Secure Enclave gates live in IdentityTests.

}
