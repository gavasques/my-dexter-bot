import Foundation
import XCTest
@testable import DexterAppCore
@testable import DexterHostClient
@testable import DexterClientIdentity

/// Private loopback host with a pinned client certificate; `requests()` counts authenticated HTTP only.
@MainActor final class SdkLowR4StatusFixture {
    let root: URL, process: Process, url: URL, der: Data, fingerprint: String
    init(identity: ClientNativeIdentity, mode: String = "client-mac") throws {
        guard let node = ProcessInfo.processInfo.environment["DEXTER_TEST_NODE"], node.hasPrefix("/") else { throw ClientIdentityFailure.invalidInput }
        root = FileManager.default.temporaryDirectory.appendingPathComponent("sdk-low-r4-tls-"+UUID().uuidString)
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:false,attributes:[.posixPermissions:0o700])
        process = Process(); let pipe = Pipe(); process.executableURL = URL(fileURLWithPath:node)
        let script = URL(fileURLWithPath:#filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Fixtures/status-focused.mjs")
        process.arguments = [script.path,root.path,identity.fingerprint,mode]; process.environment = [:]; process.standardOutput = pipe; process.standardError = FileHandle.nullDevice
        do {
            try process.run(); var line = Data()
            while line.count < 32768 { guard let byte = try pipe.fileHandleForReading.read(upToCount:1), !byte.isEmpty else { throw ClientIdentityFailure.unavailable }; if byte.first == 10 { break }; line.append(byte) }
            let info = try XCTUnwrap(JSONSerialization.jsonObject(with:line) as? [String:Any])
            url = URL(string:"https://127.0.0.1:\(try XCTUnwrap(info["port"] as? Int))")!; der = Data(base64Encoded:try XCTUnwrap(info["certificateDER"] as? String))!; fingerprint = try XCTUnwrap(info["fingerprint"] as? String)
        } catch { if process.isRunning { process.terminate(); process.waitUntilExit() }; try? FileManager.default.removeItem(at:root); throw error }
    }
    func host() throws -> PinnedClientHost { try .init(url:url,certificateDER:der,fingerprint:fingerprint) }
    func requests() throws -> Int {
        for _ in 0..<50 { if let text = try? String(contentsOf:root.appendingPathComponent("requests.txt"),encoding:.utf8), let n = Int(text) { return n }; usleep(10_000) }
        throw ClientIdentityFailure.protocolError
    }
    func close() { if process.isRunning { process.terminate(); process.waitUntilExit() }; XCTAssertFalse(process.isRunning); try? FileManager.default.removeItem(at:root) }
}

/// Wraps the real archive to model a reserve that fails either before or after becoming durable.
/// `unreadableAfterFailure` also makes every later read ambiguous (lock busy), so the claim path must fail closed.
final class SdkLowR4FaultJournal: PairedClientClaimJournal, @unchecked Sendable {
    enum Mode: Sendable { case persistedThenFail, failBeforePersist, unreadableAfterFailure }
    private let file: FileClientClaimJournal, mode: Mode, lock = NSLock()
    private var failedReserve = false
    init(file: FileClientClaimJournal, mode: Mode) { self.file = file; self.mode = mode }
    func assertNoUnknownClaim(installationID: String, role: ClientRole) throws { try file.assertNoUnknownClaim(installationID:installationID,role:role) }
    func loadOnly(scope: ClientIdentityScope) async throws -> ClientClaimJournalEntry? {
        if mode == .unreadableAfterFailure, lock.withLock({ failedReserve }) { throw ClaimJournalAdmissionError.busy }
        return try await file.loadOnly(scope:scope)
    }
    func reserve(_ reservation: ClientClaimReservation) async throws {
        lock.withLock { failedReserve = true }
        switch mode {
        case .persistedThenFail: try await file.reserve(reservation); throw ClientIdentityFailure.unavailable
        case .failBeforePersist, .unreadableAfterFailure: throw ClientIdentityFailure.unavailable
        }
    }
    func saveAcknowledgement(_ reservation: ClientClaimReservation, claimID: String) async throws { try await file.saveAcknowledgement(reservation,claimID:claimID) }
    func statusAndResolve(_ session: ClientPairingSession) async throws -> ClientPairingStatus { try await file.statusAndResolve(session) }
    func mayDiscardReference(_ reference: PairedHostReference) throws -> Bool { try file.mayDiscardReference(reference) }
}

@MainActor final class SdkLowR4Tests: XCTestCase {
    func temp() -> URL { FileManager.default.temporaryDirectory.appendingPathComponent("sdk-low-r4-journal-"+UUID().uuidString) }
    func binding(_ n: Int) -> String { String(format:"%032x",n) }
    func offer(_ fixture: SdkLowR4StatusFixture, installation: String, offerID: String = "offer_low_r4") throws -> Data {
        try JSONSerialization.data(withJSONObject:["protocol":"dexter-app-client-v1","installationId":installation,"hostUrl":fixture.url.absoluteString,"hostCertificateDER":fixture.der.base64EncodedString(),"hostFingerprint":fixture.fingerprint,"offerId":offerID,"kind":"pair","role":"client-mac","scopes":["chat.read"],"deviceId":NSNull(),"expiresAt":Int64(Date().addingTimeInterval(300).timeIntervalSince1970*1000),"code":String(repeating:"x",count:43)])
    }
    func selectedSnapshot(_ host: PinnedClientHost, installation: String, binding n: Int, clientFingerprint: String, unknown: Bool) throws -> PairedHostSnapshot {
        var snap = PairedHostSnapshot()
        snap.selected = PairedHostReference(scope:try .init(installationID:installation,localBindingID:binding(n),role:.clientMac,hostFingerprint:host.fingerprint),host:host,scopes:[.chatRead])
        snap.selected?.clientFingerprint = clientFingerprint; snap.selected?.claimOutcomeUnknown = unknown
        return snap
    }

    // MARK: N1 — a refused import must surface its own state, not the label of the previous, disconnected host.

    func testN1_ImportRefusedByPreferencesUnknownSurfacesOutcomeUnknownThroughAppModel() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try SdkLowR4StatusFixture(identity:identity); defer { fixture.close() }
        let metadata = PairMetadataMemory(), host = try fixture.host()
        metadata.bytes = try PairedStateCodec.encode(selectedSnapshot(host,installation:"host_fixture",binding:1,clientFingerprint:identity.fingerprint,unknown:true))
        let onboarding = PairedHostOnboarding(journal:metadata.journal,storage:metadata,identityStorage:{_ in PairIdentityMemory()})
        XCTAssertEqual(onboarding.state,.offline)
        let model = DexterAppModel(storage:PairedAppStateMemory(),pairing:onboarding)
        model.importPairingBundle(try offer(fixture,installation:"host_fixture"))
        XCTAssertEqual(onboarding.state,.outcomeUnknown)
        XCTAssertEqual(model.errorMessage,PairedHostConnectionState.outcomeUnknown.label)
        XCTAssertNotEqual(model.errorMessage,PairedHostConnectionState.offline.label)
        XCTAssertNil(onboarding.activeClient); XCTAssertEqual(metadata.writes,0); XCTAssertEqual(try fixture.requests(),0)
    }

    func testN1_ImportRefusedAtRetainedCapacitySurfacesAdmissionBlockedThroughAppModel() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try SdkLowR4StatusFixture(identity:identity); defer { fixture.close() }
        let metadata = PairMetadataMemory(), host = try fixture.host()
        var snap = try selectedSnapshot(host,installation:"sel",binding:30,clientFingerprint:identity.fingerprint,unknown:false)
        snap.selected?.claimID = "claim_sel"
        for n in 0..<20 {
            var ref = PairedHostReference(scope:try .init(installationID:"u\(n)",localBindingID:binding(n),role:.clientMac,hostFingerprint:host.fingerprint),host:host,scopes:[])
            ref.claimOutcomeUnknown = true; snap.retainedReferences.append(ref)
        }
        metadata.bytes = try PairedStateCodec.encode(snap)
        let onboarding = PairedHostOnboarding(journal:metadata.journal,storage:metadata,identityStorage:{_ in PairIdentityMemory()})
        let model = DexterAppModel(storage:PairedAppStateMemory(),pairing:onboarding)
        model.importPairingBundle(try offer(fixture,installation:"newbie"))
        XCTAssertEqual(onboarding.state,.admissionBlocked)
        XCTAssertEqual(model.errorMessage,PairedHostConnectionState.admissionBlocked.label)
        XCTAssertNotEqual(model.errorMessage,PairedHostConnectionState.offline.label)
        XCTAssertNil(onboarding.activeClient); XCTAssertEqual(metadata.writes,0); XCTAssertEqual(try fixture.requests(),0)
        XCTAssertEqual(onboarding.publicReference?.installationID,"sel","refused import leaves the previous namespace untouched")
    }

    // MARK: N2 — a reserve that throws after becoming durable must not be classified as a pre-wire failure.

    private struct Outcome { let state: PairedHostConnectionState, prefsUnknown: Bool, entry: ClientClaimJournalEntry?, http: Int, reimport: String }
    private func claimWith(journal wrapped: (FileClientClaimJournal) -> any PairedClientClaimJournal, seed: (FileClientClaimJournal, PinnedClientHost, String) async throws -> Void = { _,_,_ in }) async throws -> Outcome {
        let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try SdkLowR4StatusFixture(identity:identity); defer { fixture.close() }
        let metadata = PairMetadataMemory(), keys = PairIdentityMemory(preferred:identity)
        try await seed(metadata.journal,try fixture.host(),identity.fingerprint)
        let controller = PairedHostOnboarding(journal:wrapped(metadata.journal),storage:metadata,identityStorage:{_ in keys})
        let bundle = try offer(fixture,installation:"host_fixture")
        try controller.importBundle(bundle); await controller.provisionIdentity(); XCTAssertEqual(controller.state,.identityReady)
        await controller.claim(name:"Low R4")
        let scope = try XCTUnwrap(controller.publicReference).scope(), entry = try await metadata.journal.loadOnly(scope:scope)
        var reimport = "ok"; do { try PairedHostOnboarding(journal:metadata.journal,storage:PairMetadataMemory(),identityStorage:{_ in keys}).importBundle(bundle) } catch { reimport = "\(error)" }
        // A retry in the same process must neither reserve nor send anything.
        await controller.claim(name:"retry")
        return Outcome(state:controller.state,prefsUnknown:controller.publicReference?.claimOutcomeUnknown ?? false,entry:entry,http:try fixture.requests(),reimport:reimport)
    }

    func testN2_ReserveThatPersistedThenThrewIsOutcomeUnknownAndNeverSent() async throws {
        let outcome = try await claimWith { SdkLowR4FaultJournal(file:$0,mode:.persistedThenFail) }
        XCTAssertEqual(outcome.state,.outcomeUnknown,"durable reservation => not offline")
        XCTAssertTrue(outcome.prefsUnknown)
        XCTAssertNotNil(outcome.entry); XCTAssertNil(outcome.entry?.claimID)
        XCTAssertEqual(outcome.http,0,"reserve never succeeded => nothing reached the wire")
        XCTAssertEqual(outcome.reimport,"outcomeUnknown")
    }

    func testN2_ReserveThatFailedBeforePersistingStaysPrewireWithoutFakeUnknown() async throws {
        let outcome = try await claimWith { SdkLowR4FaultJournal(file:$0,mode:.failBeforePersist) }
        XCTAssertEqual(outcome.state,.offline)
        XCTAssertFalse(outcome.prefsUnknown); XCTAssertNil(outcome.entry); XCTAssertEqual(outcome.http,0); XCTAssertEqual(outcome.reimport,"ok")
    }

    func testN2_AmbiguousReadAfterFailedReserveFailsClosedNotOffline() async throws {
        let outcome = try await claimWith { SdkLowR4FaultJournal(file:$0,mode:.unreadableAfterFailure) }
        XCTAssertEqual(outcome.state,.outcomeUnknown,"unreadable archive after a failed reserve cannot be called offline")
        XCTAssertTrue(outcome.prefsUnknown); XCTAssertEqual(outcome.http,0)
    }

    func testN2_BusyAndCapacityAtReserveAreAdmissionBlockedWithoutFakeUnknownOrWire() async throws {
        // busy: the real archive lock is held by another descriptor of this process at reserve time? Use a wrapper that refuses like busy.
        struct Busy: PairedClientClaimJournal {
            let file: FileClientClaimJournal
            func assertNoUnknownClaim(installationID: String, role: ClientRole) throws { try file.assertNoUnknownClaim(installationID:installationID,role:role) }
            func loadOnly(scope: ClientIdentityScope) async throws -> ClientClaimJournalEntry? { try await file.loadOnly(scope:scope) }
            func reserve(_ reservation: ClientClaimReservation) async throws { throw ClaimJournalAdmissionError.busy }
            func saveAcknowledgement(_ reservation: ClientClaimReservation, claimID: String) async throws { try await file.saveAcknowledgement(reservation,claimID:claimID) }
        }
        let busy = try await claimWith { Busy(file:$0) }
        XCTAssertEqual(busy.state,.admissionBlocked); XCTAssertFalse(busy.prefsUnknown); XCTAssertNil(busy.entry); XCTAssertEqual(busy.http,0); XCTAssertEqual(busy.reimport,"ok")
        // capacity: twenty unresolved foreign holds in the real archive; the real reserve refuses before writing.
        let capacity = try await claimWith(journal:{ $0 },seed:{ journal,host,fingerprint in
            for n in 0..<20 { try await journal.reserve(.init(scope:.init(installationID:"foreign_\(n)",localBindingID:self.binding(n),role:.clientMac,hostFingerprint:host.fingerprint),host:host,offerID:"o\(n)",clientFingerprint:fingerprint)) }
        })
        XCTAssertEqual(capacity.state,.admissionBlocked); XCTAssertFalse(capacity.prefsUnknown); XCTAssertNil(capacity.entry); XCTAssertEqual(capacity.http,0); XCTAssertEqual(capacity.reimport,"ok")
    }

    // MARK: N3 — only an exact, authenticated terminal status reclaims archive capacity.

    func testN3_OnlyExactAuthenticatedTerminalStatusReclaimsCapacity() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), stranger = try ClientNativeIdentity.ephemeralFixture()
        for mode in ["status-pending","foreign-install","identity-mismatch","claim-mismatch","status-rejected"] {
            let fixture = try SdkLowR4StatusFixture(identity:mode == "identity-mismatch" ? stranger : identity,mode:mode == "identity-mismatch" || mode == "claim-mismatch" ? "client-mac" : mode)
            defer { fixture.close() }
            let directory = temp(); defer { try? FileManager.default.removeItem(at:directory) }
            let journal = FileClientClaimJournal(directory:directory), host = try fixture.host()
            var reservations: [ClientClaimReservation] = []
            for n in 0..<20 {
                let r = try ClientClaimReservation(scope:.init(installationID:"host_fixture",localBindingID:binding(100+n),role:.clientMac,hostFingerprint:host.fingerprint),host:host,offerID:"offer_\(n)",clientFingerprint:identity.fingerprint)
                try await journal.reserve(r); try await journal.saveAcknowledgement(r,claimID:"claim_\(n)"); reservations.append(r)
            }
            let target = reservations[0], claim = mode == "claim-mismatch" ? "claim_other" : "claim_0"
            let session = ClientPairingSession(pending:try .init(scope:target.scope,host:target.host,claimID:claim),identity:mode == "identity-mismatch" ? stranger : identity,journal:journal)
            var outcome = "threw"
            do { switch try await journal.statusAndResolve(session) { case .pending: outcome = "pending"; case .rejected: outcome = "rejected"; case .approved: outcome = "approved"; case .expired: outcome = "expired"; case .failed: outcome = "failed" } } catch { outcome = "threw" }
            await session.close().wait()
            let newcomer = try ClientClaimReservation(scope:.init(installationID:"newcomer",localBindingID:binding(9999),role:.clientMac,hostFingerprint:host.fingerprint),host:host,offerID:"offer_new",clientFingerprint:String(repeating:"c",count:64))
            var admitted = true
            do { try await journal.reserve(newcomer) } catch { admitted = false; XCTAssertEqual(error as? ClaimJournalAdmissionError,.capacity,mode) }
            let http = try fixture.requests()
            switch mode {
            case "status-rejected":
                XCTAssertEqual(outcome,"rejected"); XCTAssertTrue(admitted,"authenticated terminal status must resolve the exact record"); XCTAssertEqual(http,1)
                let gone = try await journal.loadOnly(scope:target.scope); XCTAssertNil(gone)
                for other in reservations.dropFirst() { let kept = try await journal.loadOnly(scope:other.scope); XCTAssertNotNil(kept,"other records unchanged") }
            case "status-pending": XCTAssertEqual(outcome,"pending"); XCTAssertFalse(admitted,"pending never prunes"); XCTAssertEqual(http,1)
            case "foreign-install": XCTAssertEqual(outcome,"threw"); XCTAssertFalse(admitted,"foreign approval never prunes")
            default: XCTAssertEqual(outcome,"threw"); XCTAssertFalse(admitted); XCTAssertEqual(http,0,"mismatch refused before any HTTP")
            }
            if mode != "status-rejected" { for r in reservations { let kept = try await journal.loadOnly(scope:r.scope); XCTAssertEqual(kept?.reservation.scope,r.scope,"\(mode): every record unchanged") } }
        }
    }
}
