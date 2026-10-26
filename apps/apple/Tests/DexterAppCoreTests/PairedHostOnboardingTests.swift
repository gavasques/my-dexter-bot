import Foundation
import CoreImage
import XCTest
@testable import DexterAppCore
@testable import DexterClientIdentity

@MainActor final class PairMetadataMemory: PairedHostStateStorage {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("dexter-journal-"+UUID().uuidString)
    var journal: FileClientClaimJournal { .init(directory:directory) }
    deinit { if FileManager.default.fileExists(atPath:directory.path) { try? FileManager.default.removeItem(at:directory) } }
    var bytes: Data?
    var writes = 0
    func read() -> DexterStoredState { bytes.map(DexterStoredState.data) ?? .missing }
    func write(_ data: Data) { writes += 1; bytes = data }
}
actor PairIdentityMemory: ClientIdentityStorage {
    var identities: [Data:ClientNativeIdentity] = [:]
    var loads = 0, provisions = 0
    let preferred: ClientNativeIdentity?
    init(preferred: ClientNativeIdentity? = nil) { self.preferred = preferred }
    func load(_ scope: ClientIdentityScope) throws -> ClientNativeIdentity? { loads += 1; return identities[scope.tag] }
    func provision(_ scope: ClientIdentityScope) throws -> ClientNativeIdentity { provisions += 1; guard identities[scope.tag] == nil else { throw ClientIdentityFailure.conflict }; let identity = try preferred ?? ClientNativeIdentity.ephemeralFixture(); identities[scope.tag] = identity; return identity }
    func counts() -> [Int] { [loads,provisions] }
}
@MainActor final class PairedHostOnboardingTests: XCTestCase {
    /// The eight scopes every historical offer carried; outputs.* are only ever added by an explicit owner offer.
    static let historicalScopes = ["approvals.decide","approvals.read","chat.read","chat.write","devices.manage","devices.read","grants.manage","grants.read"]
    func offer(_ fixture: IntegrationTLSFixture, role: String = "client-mac", scopes: [String] = ["chat.read"], installation: String = "host_fixture") throws -> Data {
        try JSONSerialization.data(withJSONObject:["protocol":"dexter-app-client-v1","installationId":installation,"hostUrl":fixture.url.absoluteString,"hostCertificateDER":fixture.der.base64EncodedString(),"hostFingerprint":fixture.fingerprint,"offerId":"offer_fixture","kind":"pair","role":role,"scopes":scopes,"deviceId":NSNull(),"expiresAt":Int64(Date().addingTimeInterval(300).timeIntervalSince1970*1000),"code":String(repeating:"x",count:43)])
    }
    func testQRReviewIsCodeFreeReadOnlyBoundedAndRejectsExpiredOrWrongRole() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try IntegrationTLSFixture(identity: identity)
        defer { fixture.close() }
        let data = try offer(fixture, role: "client-ios", scopes: Self.historicalScopes)
        XCTAssertLessThanOrEqual(data.count, PairingInvitationPreview.maximumQRBytes)
        let review = try PairingInvitationPreview.inspect(data, platform: .clientIOS)
        XCTAssertEqual(review.hostURL, fixture.url); XCTAssertEqual(review.scopes.map(\.rawValue), Self.historicalScopes)
        XCTAssertFalse(String(reflecting: review).contains(String(repeating: "x", count: 43)))
        XCTAssertThrowsError(try PairingInvitationPreview.inspect(data, platform: .clientMac))
        XCTAssertThrowsError(try PairingInvitationPreview.inspect(Data(repeating: 32, count: PairingInvitationPreview.maximumBytes + 1), platform: .clientIOS))
        var expired = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        expired["expiresAt"] = Int64(Date().addingTimeInterval(-1).timeIntervalSince1970 * 1_000)
        XCTAssertThrowsError(try PairingInvitationPreview.inspect(JSONSerialization.data(withJSONObject: expired), platform: .clientIOS)) {
            XCTAssertEqual($0 as? ClientIdentityFailure, .expired)
        }
        XCTAssertEqual(try fixture.requests(), 0)
    }
    func testQRRoundTripsExactExistingInvitationBytesAndRefusesOverflow() throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try IntegrationTLSFixture(identity: identity)
        defer { fixture.close() }
        var data = try offer(fixture, role: "client-ios", scopes: Self.historicalScopes)
        data.append(10) // The owner-issued invitation also includes its trailing newline.
        let image = try XCTUnwrap(PairingInvitationQR.image(for: data))
        let context = CIContext(options: [.cacheIntermediates: false])
        let detector = try XCTUnwrap(CIDetector(ofType: CIDetectorTypeQRCode, context: context, options: [CIDetectorAccuracy: CIDetectorAccuracyHigh]))
        let enlarged = CIImage(cgImage: image).transformed(by: CGAffineTransform(scaleX: 5, y: 5))
        let result = detector.features(in: enlarged).compactMap { ($0 as? CIQRCodeFeature)?.messageString }
        XCTAssertEqual(result, [String(decoding: data, as: UTF8.self)])
        XCTAssertNil(PairingInvitationQR.image(for: Data(repeating: 65, count: PairingInvitationPreview.maximumQRBytes + 1)))
        XCTAssertNil(PairingInvitationQR.image(for: Data()))
        XCTAssertEqual(try fixture.requests(), 0)
    }
    func testExplicitProvisionAndRestartLoadOnlyReuseExactPublicNamespace() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try IntegrationTLSFixture(identity:identity); defer { fixture.close() }
        let metadata = PairMetadataMemory(), keys = PairIdentityMemory(), controller = PairedHostOnboarding(journal:metadata.journal,storage:metadata,identityStorage:{_ in keys})
        try controller.importBundle(offer(fixture)); XCTAssertEqual(controller.state,.readyToProvision)
        let initial = try XCTUnwrap(controller.publicReference); let before = await keys.counts(); XCTAssertEqual(before,[0,0])
        await controller.provisionIdentity(); XCTAssertEqual(controller.state,.identityReady)
        let fingerprint = try XCTUnwrap(controller.publicReference?.clientFingerprint), bytes = try XCTUnwrap(metadata.bytes)
        XCTAssertFalse(String(decoding:bytes,as:UTF8.self).contains(String(repeating:"x",count:43))); XCTAssertFalse(String(decoding:bytes,as:UTF8.self).contains("privateKey")); XCTAssertFalse(String(decoding:bytes,as:UTF8.self).contains("token"))
        let restarted = PairedHostOnboarding(journal:metadata.journal,storage:metadata,identityStorage:{_ in keys}); XCTAssertEqual(restarted.state,.offline)
        await restarted.restoreOrCheckApproval(); XCTAssertEqual(restarted.state,.identityReady)
        XCTAssertEqual(restarted.publicReference?.localBindingID,initial.localBindingID); XCTAssertEqual(restarted.publicReference?.clientFingerprint,fingerprint)
        try restarted.importBundle(offer(fixture)); XCTAssertEqual(restarted.publicReference?.localBindingID,initial.localBindingID)
        let after = await keys.counts(); XCTAssertEqual(after[1],1); XCTAssertEqual(try fixture.requests(),0)
    }
    func testMissingIdentityNeverProvisionedAndMetadataDoesNotBecomeAuthority() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try IntegrationTLSFixture(identity:identity); defer { fixture.close() }
        let metadata = PairMetadataMemory(), keys = PairIdentityMemory(), controller = PairedHostOnboarding(journal:metadata.journal,storage:metadata,identityStorage:{_ in keys})
        try controller.importBundle(offer(fixture)); await controller.restoreOrCheckApproval(); XCTAssertEqual(controller.state,.identityMissing)
        XCTAssertNil(controller.binding); XCTAssertNil(controller.activeClient); let counts = await keys.counts(); XCTAssertEqual(counts,[1,0]); XCTAssertEqual(try fixture.requests(),0)
    }
    func testRoleScopeAndMalformedOffersRejectBeforeIdentityOrMetadataWrites() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try IntegrationTLSFixture(identity:identity); defer { fixture.close() }
        let metadata = PairMetadataMemory(), keys = PairIdentityMemory(), controller = PairedHostOnboarding(journal:metadata.journal,storage:metadata,identityStorage:{_ in keys})
        for data in [try offer(fixture,role:"agent-mac"),try offer(fixture,role:"client-ios"),try offer(fixture,scopes:["chat.read","chat.read"]),try offer(fixture,scopes:["mac.cua"]),Data(repeating:32,count:32769)] { XCTAssertThrowsError(try controller.importBundle(data)) }
        XCTAssertEqual(metadata.writes,0); let counts = await keys.counts(); XCTAssertEqual(counts,[0,0]); XCTAssertEqual(controller.state,.disconnected)
    }
    func testUnknownClaimSurvivesDetachRestartAndBlocksDuplicateBegin() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try IntegrationTLSFixture(identity:identity); defer { fixture.close() }
        let metadata = PairMetadataMemory(), keys = PairIdentityMemory(), controller = PairedHostOnboarding(journal:metadata.journal,storage:metadata,identityStorage:{_ in keys})
        try controller.importBundle(offer(fixture)); var snapshot = try PairedStateCodec.decode(XCTUnwrap(metadata.bytes)); snapshot.selected?.claimOutcomeUnknown = true; metadata.bytes = try PairedStateCodec.encode(snapshot)
        let unknown = PairedHostOnboarding(journal:metadata.journal,storage:metadata,identityStorage:{_ in keys}); await unknown.restoreOrCheckApproval(); XCTAssertEqual(unknown.state,.outcomeUnknown)
        XCTAssertThrowsError(try unknown.importBundle(offer(fixture))); try unknown.detach(); XCTAssertEqual(unknown.state,.disconnected)
        let restarted = PairedHostOnboarding(journal:metadata.journal,storage:metadata,identityStorage:{_ in keys}); XCTAssertThrowsError(try restarted.importBundle(offer(fixture))); let counts = await keys.counts(); XCTAssertEqual(counts,[0,0]); XCTAssertEqual(try fixture.requests(),0)
    }
    func testPendingTurnIDsCannotCrossInstallDeviceThreadOrDigest() throws {
        let controller = PairedHostOnboarding(journal:FileClientClaimJournal(directory:FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)),storage:PairMetadataMemory(),identityStorage:{_ in PairIdentityMemory()})
        let first = PairedPendingTurn(installationID:"host_a",deviceID:"device_a",threadID:"thread",clientRequestID:"request",contentDigest:String(repeating:"a",count:64))
        try controller.recordPending(first); try controller.recordPending(first)
        XCTAssertEqual(controller.pending(installation:"host_a",device:"device_a",thread:"thread"),first)
        XCTAssertNil(controller.pending(installation:"host_b",device:"device_a",thread:"thread")); XCTAssertNil(controller.pending(installation:"host_a",device:"device_b",thread:"thread"))
        XCTAssertThrowsError(try controller.recordPending(.init(installationID:"host_a",deviceID:"device_a",threadID:"thread",clientRequestID:"other",contentDigest:String(repeating:"b",count:64))))
        try controller.clearPending(first); XCTAssertNil(controller.pending(installation:"host_a",device:"device_a",thread:"thread"))
    }
}
extension PairedHostOnboardingTests {
    func testSyntheticPinnedPairingRestoreAndExplicitSelfRevokeThroughSDK() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try IntegrationTLSFixture(identity:identity,mode:"paired-mock"); defer { fixture.close() }
        let metadata = PairMetadataMemory(), keys = PairIdentityMemory(preferred:identity), first = PairedHostOnboarding(journal:metadata.journal,storage:metadata,identityStorage:{_ in keys})
        try first.importBundle(offer(fixture,scopes:Self.historicalScopes)); await first.provisionIdentity()
        let localID = first.publicReference?.localBindingID
        await first.claim(name:"Synthetic Mac"); XCTAssertEqual(first.state,.pendingApproval); XCTAssertEqual(first.publicReference?.claimID,"claim_fixture"); XCTAssertEqual(first.publicReference?.claimOutcomeUnknown,false)
        first.disconnect()
        let restored = PairedHostOnboarding(journal:metadata.journal,storage:metadata,identityStorage:{_ in keys}); await restored.restoreOrCheckApproval()
        XCTAssertEqual(restored.state,.paired); XCTAssertEqual(restored.binding?.deviceID,"device_fixture"); XCTAssertEqual(restored.publicReference?.localBindingID,localID)
        let retained = try XCTUnwrap(restored.activeClient); await restored.revokeThisClient(); XCTAssertEqual(restored.state,.revoked); XCTAssertNil(restored.activeClient)
        do { _ = try await retained.health(); XCTFail("retained admitted after revoke") } catch { XCTAssertTrue(error is CancellationError) }
        let counts = await keys.counts(); XCTAssertEqual(counts[1],1); XCTAssertEqual(try fixture.requests(),4)
        let text = String(decoding:try XCTUnwrap(metadata.bytes),as:UTF8.self); XCTAssertFalse(text.contains(String(repeating:"x",count:43)))
    }
}

extension PairedHostOnboardingTests {
    func testDurableACKRecoversInterruptedPreferencesWithoutSecondClaim() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try IntegrationTLSFixture(identity:identity,mode:"paired-mock"); defer { fixture.close() }
        let metadata = PairMetadataMemory(), keys = PairIdentityMemory(preferred:identity), first = PairedHostOnboarding(journal:metadata.journal,storage:metadata,identityStorage:{_ in keys})
        try first.importBundle(offer(fixture,scopes:Self.historicalScopes)); await first.provisionIdentity(); await first.claim(name:"Synthetic")
        XCTAssertEqual(first.state,.pendingApproval)
        var interrupted = try PairedStateCodec.decode(XCTUnwrap(metadata.bytes)); interrupted.selected?.claimID = nil; interrupted.selected?.claimOutcomeUnknown = true; metadata.bytes = try PairedStateCodec.encode(interrupted); first.disconnect()
        let recovered = PairedHostOnboarding(journal:metadata.journal,storage:metadata,identityStorage:{_ in keys}); await recovered.restoreOrCheckApproval()
        XCTAssertEqual(recovered.state,.paired); XCTAssertEqual(recovered.publicReference?.claimID,"claim_fixture"); XCTAssertEqual(recovered.publicReference?.claimOutcomeUnknown,false)
        XCTAssertEqual(try fixture.requests(),3,"claim once, status, health; no claim retry")
        recovered.disconnect(); let counts = await keys.counts(); XCTAssertEqual(counts[1],1)
    }
    func testChangedTrustedPinSelectsMissingIdentityWithoutProvision() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), firstFixture = try IntegrationTLSFixture(identity:identity), secondFixture = try IntegrationTLSFixture(identity:identity); defer { firstFixture.close(); secondFixture.close() }
        XCTAssertNotEqual(firstFixture.fingerprint,secondFixture.fingerprint)
        let metadata = PairMetadataMemory(), keys = PairIdentityMemory(), controller = PairedHostOnboarding(journal:metadata.journal,storage:metadata,identityStorage:{_ in keys})
        try controller.importBundle(offer(firstFixture)); await controller.provisionIdentity(); let old = try XCTUnwrap(controller.publicReference).scope()
        try controller.importBundle(offer(secondFixture)); let new = try XCTUnwrap(controller.publicReference).scope(); XCTAssertNotEqual(old.tag,new.tag)
        await controller.restoreOrCheckApproval(); XCTAssertEqual(controller.state,.identityMissing); let counts = await keys.counts(); XCTAssertEqual(counts[1],1)
        XCTAssertEqual(try firstFixture.requests(),0); XCTAssertEqual(try secondFixture.requests(),0)
    }
}


extension PairedHostOnboardingTests {
    func testUncertainArchiveBlocksWipedPreferencesNewBindingAndNewPinBeforeProvisionOrHTTP() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), first = try IntegrationTLSFixture(identity:identity), changedPin = try IntegrationTLSFixture(identity:identity); defer { first.close(); changedPin.close() }
        let metadata = PairMetadataMemory(), keys = PairIdentityMemory()
        let originalScope = try ClientIdentityScope(installationID:"host_fixture",localBindingID:String(repeating:"a",count:32),role:.clientMac,hostFingerprint:first.fingerprint)
        try await metadata.journal.reserve(.init(scope:originalScope,host:first.host(),offerID:"old_offer",clientFingerprint:identity.fingerprint))
        XCTAssertNil(metadata.bytes,"no preferences identify the prior scope")
        for fixture in [first,changedPin] {
            let controller = PairedHostOnboarding(journal:metadata.journal,storage:metadata,identityStorage:{_ in keys})
            XCTAssertThrowsError(try controller.importBundle(offer(fixture))) { XCTAssertEqual($0 as? ClientIdentityFailure,.outcomeUnknown) }
            XCTAssertNil(controller.publicReference); XCTAssertEqual(metadata.writes,0); await controller.provisionIdentity(); await controller.claim(name:"Synthetic")
        }
        let counts = await keys.counts(); XCTAssertEqual(counts,[0,0]); XCTAssertEqual(try first.requests(),0); XCTAssertEqual(try changedPin.requests(),0)
        let entry = try await metadata.journal.loadOnly(scope:originalScope); XCTAssertNil(try XCTUnwrap(entry).claimID)
    }
}
