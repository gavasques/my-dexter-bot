import XCTest
import Foundation
@testable import DexterClientIdentity

actor TestJournal: ClientClaimJournal {
    var entries: [Data:ClientClaimJournalEntry] = [:]
    var failACK = false
    func loadOnly(scope: ClientIdentityScope) -> ClientClaimJournalEntry? { entries[scope.tag] }
    func reserve(_ reservation: ClientClaimReservation) throws {
        guard entries[reservation.scope.tag] == nil else { throw ClientIdentityFailure.outcomeUnknown }
        entries[reservation.scope.tag] = try ClientClaimJournalEntry(reservation:reservation,claimID:nil)
    }
    func saveAcknowledgement(_ reservation: ClientClaimReservation, claimID: String) throws {
        guard !failACK else { throw ClientIdentityFailure.unavailable }
        guard let entry = entries[reservation.scope.tag], entry.claimID == nil, entry.reservation.matches(reservation) else { throw ClientIdentityFailure.conflict }
        entries[reservation.scope.tag] = try ClientClaimJournalEntry(reservation:reservation,claimID:claimID)
    }
    func failAcknowledgements() { failACK = true }
}

@MainActor final class JournalTests: XCTestCase {
    func testFreshSessionsAndDifferentOffersCannotRepeatUnknownClaim() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try ClientTLSFixture(identity:identity,mode:"delay"); defer { fixture.close() }
        let scope = try ClientIdentityScope(installationID:"host_fixture",localBindingID:String(repeating:"c",count:32),role:.clientIOS,hostFingerprint:fixture.fingerprint), journal = TestJournal()
        let bundle = try ClientPairingBundle(host:fixture.host(),installationID:scope.installationID,offerID:"first",role:scope.role,expiresAt:Date().addingTimeInterval(300),code:String(repeating:"x",count:32))
        let session = try ClientPairingSession(bundle:bundle,scope:scope,identity:identity,journal:journal)
        do { _ = try await session.begin(name:"Phone"); XCTFail("bad ACK") } catch { XCTAssertEqual(error as? ClientIdentityFailure,.outcomeUnknown) }
        await session.close().wait()
        let loaded = await journal.loadOnly(scope:scope)
        let entry = try XCTUnwrap(loaded); XCTAssertNil(entry.claimID); XCTAssertEqual(entry.reservation.clientFingerprint,identity.fingerprint)
        for offer in ["first","other"] {
            let freshBundle = try ClientPairingBundle(host:fixture.host(),installationID:scope.installationID,offerID:offer,role:scope.role,expiresAt:Date().addingTimeInterval(300),code:String(repeating:"z",count:32))
            let fresh = try ClientPairingSession(bundle:freshBundle,scope:scope,identity:identity,journal:journal)
            do { _ = try await fresh.begin(name:"Phone"); XCTFail("repeated claim after restart") } catch { XCTAssertEqual(error as? ClientIdentityFailure,.outcomeUnknown) }
            do { _ = try await fresh.status(); XCTFail("unknown acquired claimID") } catch { XCTAssertEqual(error as? ClientIdentityFailure,.outcomeUnknown) }
            await fresh.close().wait()
        }
        XCTAssertEqual(try fixture.requests(),1)
    }
    func testACKMustPersistBeforeSuccessAndFreshStatusUsesSameFingerprint() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try ClientTLSFixture(identity:identity); defer { fixture.close() }
        let scope = try ClientIdentityScope(installationID:"host_fixture",localBindingID:String(repeating:"d",count:32),role:.clientIOS,hostFingerprint:fixture.fingerprint), journal = TestJournal()
        await journal.failAcknowledgements()
        let bundle = try ClientPairingBundle(host:fixture.host(),installationID:scope.installationID,offerID:"first",role:scope.role,expiresAt:Date().addingTimeInterval(300),code:String(repeating:"x",count:32))
        let session = try ClientPairingSession(bundle:bundle,scope:scope,identity:identity,journal:journal)
        do { _ = try await session.begin(name:"Phone"); XCTFail("ACK storage failure succeeded") } catch { XCTAssertEqual(error as? ClientIdentityFailure,.outcomeUnknown) }
        let fresh = try ClientPairingSession(bundle:bundle,scope:scope,identity:identity,journal:journal)
        do { _ = try await fresh.begin(name:"Phone"); XCTFail("ACK failure retried") } catch { XCTAssertEqual(error as? ClientIdentityFailure,.outcomeUnknown) }
        XCTAssertEqual(try fixture.requests(),1); await session.close().wait(); await fresh.close().wait()
    }
    func testExpiryBeforeReservationDoesNotHandoff() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try ClientTLSFixture(identity:identity); defer { fixture.close() }
        let scope = try ClientIdentityScope(installationID:"host_fixture",localBindingID:String(repeating:"e",count:32),role:.clientIOS,hostFingerprint:fixture.fingerprint), journal = TestJournal()
        let bundle = try ClientPairingBundle(host:fixture.host(),installationID:scope.installationID,offerID:"expired",role:scope.role,expiresAt:Date().addingTimeInterval(-1),code:String(repeating:"x",count:32),now:Date().addingTimeInterval(-2))
        let session = try ClientPairingSession(bundle:bundle,scope:scope,identity:identity,journal:journal)
        do { _ = try await session.begin(name:"Phone"); XCTFail("expired offer sent") } catch { XCTAssertEqual(error as? ClientIdentityFailure,.expired) }
        let entry = await journal.loadOnly(scope:scope); XCTAssertNil(entry); XCTAssertEqual(try fixture.requests(),0); await session.close().wait()
    }
    func testSavedAcknowledgementStatusSurvivesExpiredOfferAndFreshSession() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try ClientTLSFixture(identity:identity); defer { fixture.close() }
        let scope = try ClientIdentityScope(installationID:"host_fixture",localBindingID:String(repeating:"f",count:32),role:.clientIOS,hostFingerprint:fixture.fingerprint), journal = TestJournal()
        let reservation = try ClientClaimReservation(scope:scope,host:fixture.host(),offerID:"saved",clientFingerprint:identity.fingerprint)
        try await journal.reserve(reservation); try await journal.saveAcknowledgement(reservation,claimID:"claim_fixture")
        let expiredBundle = try ClientPairingBundle(host:fixture.host(),installationID:scope.installationID,offerID:"saved",role:scope.role,expiresAt:Date().addingTimeInterval(-1),code:String(repeating:"x",count:32),now:Date().addingTimeInterval(-2))
        let storage = MemoryStorage(); await storage.install(scope,identity:identity)
        let fresh = try await ClientConnectionFactory.pairing(bundle:expiredBundle,lifecycle:ClientIdentityLifecycle(scope:scope,storage:storage),journal:journal)
        guard case .approved(let binding) = try await fresh.status() else { return XCTFail("saved status lost after offer expiry") }
        XCTAssertEqual(binding.clientFingerprint,identity.fingerprint)
        do { _ = try await fresh.begin(name:"Phone"); XCTFail("saved ACK recreated claim") } catch { XCTAssertEqual(error as? ClientIdentityFailure,.conflict) }
        let counts = await storage.counts(); XCTAssertEqual(counts,[1,0]); XCTAssertEqual(try fixture.requests(),1); await fresh.close().wait()
    }
    func testHostPinChangesKeyAddressAndCannotReuseExistingIdentity() async throws {
        let first = try ClientNativeIdentity.ephemeralFixture(), storage = MemoryStorage()
        let a = try ClientIdentityScope(installationID:"host_fixture",localBindingID:String(repeating:"a",count:32),role:.clientIOS,hostFingerprint:String(repeating:"a",count:64))
        let b = try ClientIdentityScope(installationID:a.installationID,localBindingID:a.localBindingID,role:a.role,hostFingerprint:String(repeating:"b",count:64))
        XCTAssertNotEqual(a.tag,b.tag); XCTAssertNotEqual(a.certificateLabel,b.certificateLabel)
        await storage.install(a,identity:first)
        do { _ = try await ClientIdentityLifecycle(scope:b,storage:storage).loadOnly(); XCTFail("changed pin reused old key") } catch { XCTAssertEqual(error as? ClientIdentityFailure,.missing) }
        let counts = await storage.counts(); XCTAssertEqual(counts,[1,0])
    }

}
