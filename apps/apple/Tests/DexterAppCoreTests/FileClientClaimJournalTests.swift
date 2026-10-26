import Foundation
import XCTest
import Darwin
@testable import DexterAppCore
@testable import DexterClientIdentity

@MainActor final class FileClientClaimJournalTests: XCTestCase {
    func reservation(_ fixture: IntegrationTLSFixture, offer: String = "offer") throws -> ClientClaimReservation {
        let host = try fixture.host(), scope = try ClientIdentityScope(installationID:"journal_host",localBindingID:String(repeating:"a",count:32),role:.clientMac,hostFingerprint:host.fingerprint)
        return try .init(scope:scope,host:host,offerID:offer,clientFingerprint:String(repeating:"b",count:64))
    }
    func testDurableReservationACKComparisonAndNewPinNamespace() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try IntegrationTLSFixture(identity:identity); defer { fixture.close() }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString); defer { try? FileManager.default.removeItem(at:directory) }
        let journal = FileClientClaimJournal(directory:directory), reserve = try reservation(fixture)
        let missing = try await journal.loadOnly(scope:reserve.scope); XCTAssertNil(missing); XCTAssertFalse(FileManager.default.fileExists(atPath:directory.path))
        try await journal.reserve(reserve)
        let restarted = FileClientClaimJournal(directory:directory), unknown = try await restarted.loadOnly(scope:reserve.scope)
        XCTAssertNil(try XCTUnwrap(unknown).claimID)
        do { try await restarted.reserve(reservation(fixture,offer:"second")); XCTFail("second offer reserved") } catch { XCTAssertEqual(error as? ClientIdentityFailure,.outcomeUnknown) }
        do { try await restarted.saveAcknowledgement(reservation(fixture,offer:"second"),claimID:"claim"); XCTFail("foreign reservation ACK") } catch { XCTAssertEqual(error as? ClientIdentityFailure,.conflict) }
        try await restarted.saveAcknowledgement(reserve,claimID:"claim")
        let acknowledged = try await FileClientClaimJournal(directory:directory).loadOnly(scope:reserve.scope); XCTAssertEqual(acknowledged?.claimID,"claim")
        do { try await journal.saveAcknowledgement(reserve,claimID:"other"); XCTFail("ACK overwritten") } catch { XCTAssertEqual(error as? ClientIdentityFailure,.conflict) }
        let newPin = try ClientIdentityScope(installationID:reserve.scope.installationID,localBindingID:reserve.scope.localBindingID,role:.clientMac,hostFingerprint:String(repeating:"c",count:64))
        let newEntry = try await journal.loadOnly(scope:newPin); XCTAssertNil(newEntry)
        let data = try Data(contentsOf:directory.appendingPathComponent("claims.json")), text = String(decoding:data,as:UTF8.self)
        for forbidden in ["code","privateKey","token","content","name"] { XCTAssertFalse(text.contains("\"\(forbidden)\"")) }
    }
    func testCorruptionClosedFieldsAndSymlinkStayFailClosed() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try IntegrationTLSFixture(identity:identity); defer { fixture.close() }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString); defer { try? FileManager.default.removeItem(at:directory) }
        let journal = FileClientClaimJournal(directory:directory), reserve = try reservation(fixture); try await journal.reserve(reserve)
        let file = directory.appendingPathComponent("claims.json"); let valid = try Data(contentsOf:file)
        var value = try JSONSerialization.jsonObject(with:valid) as! [String:Any]; value["code"] = "forbidden"
        let corrupt = try JSONSerialization.data(withJSONObject:value); try corrupt.write(to:file)
        do { _ = try await journal.loadOnly(scope:reserve.scope); XCTFail("extra field accepted") } catch { XCTAssertEqual(error as? ClientIdentityFailure,.conflict) }
        XCTAssertFalse(FileManager.default.fileExists(atPath:directory.appendingPathComponent("claims.quarantine").path))
        do { try await journal.reserve(reserve); XCTFail("corruption reset") } catch { XCTAssertEqual(error as? ClientIdentityFailure,.conflict) }
        XCTAssertEqual(try Data(contentsOf:file),corrupt); XCTAssertEqual(try Data(contentsOf:directory.appendingPathComponent("claims.quarantine")),corrupt)
        try FileManager.default.removeItem(at:file); try FileManager.default.createSymbolicLink(at:file,withDestinationURL:directory.appendingPathComponent("claims.quarantine"))
        do { _ = try await journal.loadOnly(scope:reserve.scope); XCTFail("symlink admitted") } catch { XCTAssertEqual(error as? ClientIdentityFailure,.conflict) }
    }
    func testConcurrentInstancesOnlyOneCanReserve() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try IntegrationTLSFixture(identity:identity); defer { fixture.close() }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString); defer { try? FileManager.default.removeItem(at:directory) }
        let reserve = try reservation(fixture)
        let results = await withTaskGroup(of:Bool.self) { group in
            for _ in 0..<8 { group.addTask { do { try await FileClientClaimJournal(directory:directory).reserve(reserve); return true } catch { return false } } }
            var values: [Bool] = []; for await value in group { values.append(value) }; return values
        }
        XCTAssertEqual(results.filter {$0}.count,1)
    }
    func testProcessHelper() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let directory = env["DEXTER_JOURNAL_HELPER"], let metadata = env["DEXTER_JOURNAL_METADATA"] else { return }
        let reference = try JSONDecoder().decode(PairedHostReference.self,from:Data(contentsOf:URL(fileURLWithPath:metadata)))
        let reservation = try ClientClaimReservation(scope:reference.scope(),host:reference.host(),offerID:"process_offer",clientFingerprint:String(repeating:"b",count:64))
        do { try await FileClientClaimJournal(directory:URL(fileURLWithPath:directory)).reserve(reservation); FileHandle.standardOutput.write(Data("RESERVED\n".utf8)) }
        catch { FileHandle.standardOutput.write(Data("HELD\n".utf8)); return }
        if env["DEXTER_JOURNAL_KILL"] == "1" { await withCheckedContinuation { (_: CheckedContinuation<Void,Never>) in } }
    }
    private func child(directory: URL, metadata: URL, held: Bool = false) throws -> (Process,Pipe) {
        let process = Process(), pipe = Pipe(); process.executableURL = URL(fileURLWithPath:"/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/Library/Xcode/Agents/xctest"); process.arguments = ["-XCTest", "DexterAppCoreTests.FileClientClaimJournalTests/testProcessHelper", Bundle(for:FileClientClaimJournalTests.self).bundleURL.path]
        var env = ProcessInfo.processInfo.environment; env["DEXTER_JOURNAL_HELPER"] = directory.path; env["DEXTER_JOURNAL_METADATA"] = metadata.path; env["DEXTER_JOURNAL_KILL"] = held ? "1" : "0"; process.environment = env; process.standardOutput = pipe; process.standardError = FileHandle.nullDevice; try process.run(); return (process,pipe)
    }
    func testSIGKILLRestartAndCrossProcessExclusion() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try IntegrationTLSFixture(identity:identity); defer { fixture.close() }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString); try FileManager.default.createDirectory(at:root,withIntermediateDirectories:false,attributes:[.posixPermissions:0o700]); defer { try? FileManager.default.removeItem(at:root) }
        let reserve = try reservation(fixture), metadata = root.appendingPathComponent("metadata.json"), directory = root.appendingPathComponent("archive")
        try JSONEncoder().encode(PairedHostReference(scope:reserve.scope,host:reserve.host,scopes:[])).write(to:metadata)
        let (process,pipe) = try child(directory:directory,metadata:metadata,held:true)
        defer { if process.isRunning { kill(process.processIdentifier,SIGKILL); process.waitUntilExit() } }
        var output = Data()
        while !String(decoding:output,as:UTF8.self).contains("RESERVED\n"), output.count < 32768 { guard let next = try pipe.fileHandleForReading.read(upToCount:1), !next.isEmpty else { XCTFail("helper ended before reservation"); return }; output.append(next) }
        kill(process.processIdentifier,SIGKILL); process.waitUntilExit(); XCTAssertFalse(process.isRunning); XCTAssertEqual(process.terminationReason,.uncaughtSignal)
        let loaded = try await FileClientClaimJournal(directory:directory).loadOnly(scope:reserve.scope); XCTAssertNotNil(loaded); XCTAssertNil(loaded?.claimID)
        let (second,secondPipe) = try child(directory:directory,metadata:metadata); let secondOutput = secondPipe.fileHandleForReading.readDataToEndOfFile(); second.waitUntilExit(); XCTAssertFalse(second.isRunning); XCTAssertTrue(String(decoding:secondOutput,as:UTF8.self).contains("HELD\n"))
        // A new local binding and accepted new host pin cannot bypass the installation+role hold.
        let alternateHost = try IntegrationTLSFixture(identity:identity); defer { alternateHost.close() }
        for (suffix,host) in [("binding",reserve.host),("pin",try alternateHost.host())] {
            let replacement = try ClientIdentityScope(installationID:reserve.scope.installationID,localBindingID:String(repeating:"c",count:32),role:reserve.scope.role,hostFingerprint:host.fingerprint)
            let replacementMetadata = root.appendingPathComponent("replacement-"+suffix+".json")
            try JSONEncoder().encode(PairedHostReference(scope:replacement,host:host,scopes:[])).write(to:replacementMetadata)
            let (changed,changedPipe) = try child(directory:directory,metadata:replacementMetadata)
            let changedOutput = changedPipe.fileHandleForReading.readDataToEndOfFile(); changed.waitUntilExit(); XCTAssertFalse(changed.isRunning)
            XCTAssertTrue(String(decoding:changedOutput,as:UTF8.self).contains("HELD\n"),"installation+role hold must cover new \(suffix)")
            let absent = try await FileClientClaimJournal(directory:directory).loadOnly(scope:replacement); XCTAssertNil(absent)
        }
        XCTAssertEqual(try fixture.requests(),0); XCTAssertEqual(try alternateHost.requests(),0)
        let parallelDirectory = root.appendingPathComponent("parallel"), (one,onePipe) = try child(directory:parallelDirectory,metadata:metadata), (two,twoPipe) = try child(directory:parallelDirectory,metadata:metadata)
        let oneOutput = onePipe.fileHandleForReading.readDataToEndOfFile(), twoOutput = twoPipe.fileHandleForReading.readDataToEndOfFile(); one.waitUntilExit(); two.waitUntilExit(); XCTAssertFalse(one.isRunning); XCTAssertFalse(two.isRunning)
        let results = [oneOutput,twoOutput].map { String(decoding:$0,as:UTF8.self) }; XCTAssertEqual(results.filter {$0.contains("RESERVED\n")}.count,1); XCTAssertEqual(results.filter {$0.contains("HELD\n")}.count,1)
    }
}

import Foundation
import XCTest
import Darwin
@testable import DexterAppCore
@testable import DexterHostClient
@testable import DexterClientIdentity

/// Independent Opus R1 probes. Temp archives, ephemeral identities and owned loopback fixtures only.
private final class DoneFlag: @unchecked Sendable {
    private let lock = NSLock(); private var value = false; private var failure: String?
    func set(_ error: Error?) { lock.lock(); value = true; failure = error.map { "\($0)" }; lock.unlock() }
    func get() -> (Bool,String?) { lock.lock(); defer { lock.unlock() }; return (value,failure) }
}
actor OpusOwnDeviceSender: PairedNativeSending {
    let devices: Data
    private(set) var revokes = 0, renames = 0
    nonisolated let closing = ClientTransportClose(Task {})
    init(devices: Data) { self.devices = devices }
    func send(_ request: ClientRequest) async throws -> ClientTransportResponse {
        switch request.route {
        case .devices: return .init(statusCode:200,data:devices)
        case .renameDevice: renames += 1; throw ClientIdentityFailure.outcomeUnknown
        case .revokeDevice: revokes += 1; return .init(statusCode:200,data:try JSONSerialization.data(withJSONObject:["deviceId":"device","status":"revoked"]))
        default: throw ClientIdentityFailure.unavailable
        }
    }
    func counts() -> [Int] { [renames,revokes] }
    nonisolated func close() -> ClientTransportClose { closing }
}

@MainActor final class OpusIntegrationProbeTests: XCTestCase {
    func tempDirectory() -> URL { FileManager.default.temporaryDirectory.appendingPathComponent("opus-probe-"+UUID().uuidString) }
    func binding(_ n: Int) -> String { String(format:"%032x",n) }
    func reservation(_ host: PinnedClientHost, installation: String, role: ClientRole = .clientMac, local: String, offer: String = "offer") throws -> ClientClaimReservation {
        try .init(scope:.init(installationID:installation,localBindingID:local,role:role,hostFingerprint:host.fingerprint),host:host,offerID:offer,clientFingerprint:String(repeating:"b",count:64))
    }
    func offer(_ fixture: IntegrationTLSFixture, installation: String, scopes: [String] = ["chat.read"]) throws -> Data {
        try JSONSerialization.data(withJSONObject:["protocol":"dexter-app-client-v1","installationId":installation,"hostUrl":fixture.url.absoluteString,"hostCertificateDER":fixture.der.base64EncodedString(),"hostFingerprint":fixture.fingerprint,"offerId":"offer_opus","kind":"pair","role":"client-mac","scopes":scopes,"deviceId":NSNull(),"expiresAt":Int64(Date().addingTimeInterval(300).timeIntervalSince1970*1000),"code":String(repeating:"x",count:43)])
    }
    func listing(_ directory: URL) throws -> [String:Data] {
        var out: [String:Data] = [:]; for name in try FileManager.default.contentsOfDirectory(atPath:directory.path) { out[name] = try Data(contentsOf:directory.appendingPathComponent(name)) }; return out
    }

    /// (a) Real OS-level exclusion against a distinct competing process, then SIGKILL of the holder.
    func testOpusCompetingProcessRefusesBoundedAdmissionUntilSIGKILL() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try IntegrationTLSFixture(identity:identity); defer { fixture.close() }
        let directory = tempDirectory(); defer { try? FileManager.default.removeItem(at:directory) }
        let journal = FileClientClaimJournal(directory:directory), host = try fixture.host()
        try await journal.reserve(reservation(host,installation:"inst_a",local:binding(1)))
        let holder = Process(), out = Pipe(); holder.executableURL = URL(fileURLWithPath:"/usr/bin/python3")
        holder.arguments = ["-I","-c","import fcntl,os,sys,time\nfd=os.open(sys.argv[1],os.O_RDWR)\nfcntl.flock(fd,fcntl.LOCK_EX)\nprint('LOCKED',flush=True)\ntime.sleep(60)",directory.appendingPathComponent("journal.lock").path]
        holder.environment = [:]; holder.standardOutput = out; holder.standardError = FileHandle.nullDevice
        try holder.run(); defer { if holder.isRunning { kill(holder.processIdentifier,SIGKILL); holder.waitUntilExit() } }
        let line = try out.fileHandleForReading.read(upToCount:7); XCTAssertEqual(line.map { String(decoding:$0,as:UTF8.self).trimmingCharacters(in:.whitespacesAndNewlines) },"LOCKED")
        let done = DoneFlag(), other = try reservation(host,installation:"inst_b",local:binding(2))
        let task = Task.detached { do { try await FileClientClaimJournal(directory:directory).reserve(other); done.set(nil) } catch { done.set(error) } }
        try await Task.sleep(nanoseconds:600_000_000)
        XCTAssertTrue(done.get().0,"nonblocking admission must finish while holder remains alive")
        XCTAssertEqual(done.get().1,"busy")
        XCTAssertTrue(holder.isRunning)
        XCTAssertThrowsError(try journal.assertNoUnknownClaim(installationID:"inst_b",role:.clientMac)) { XCTAssertEqual($0 as? ClaimJournalAdmissionError,.busy) }
        kill(holder.processIdentifier,SIGKILL); holder.waitUntilExit()
        XCTAssertFalse(holder.isRunning); XCTAssertEqual(holder.terminationReason,.uncaughtSignal); XCTAssertEqual(holder.terminationStatus,SIGKILL)
        await task.value; try await journal.reserve(other)
        let entry = try await journal.loadOnly(scope:other.scope); XCTAssertNotNil(entry); XCTAssertNil(entry?.claimID)
    }

    /// (a) Hold is exactly installation+role; ACK clears only after durable save; reads never write.
    func testOpusHoldIsInstallationRoleScopedAndACKReleasesWithoutBlockingOthers() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), first = try IntegrationTLSFixture(identity:identity), second = try IntegrationTLSFixture(identity:identity); defer { first.close(); second.close() }
        let directory = tempDirectory(); defer { try? FileManager.default.removeItem(at:directory) }
        let journal = FileClientClaimJournal(directory:directory), a = try reservation(first.host(),installation:"inst_a",local:binding(1))
        try await journal.reserve(a)
        let before = try listing(directory)
        _ = try await journal.loadOnly(scope:a.scope); XCTAssertThrowsError(try journal.assertNoUnknownClaim(installationID:"inst_a",role:.clientMac))
        XCTAssertNoThrow(try journal.assertNoUnknownClaim(installationID:"inst_b",role:.clientMac)); XCTAssertNoThrow(try journal.assertNoUnknownClaim(installationID:"inst_a",role:.clientIOS))
        XCTAssertEqual(try listing(directory),before,"loadOnly/assert must not write")
        for blocked in [try reservation(first.host(),installation:"inst_a",local:binding(2)),try reservation(second.host(),installation:"inst_a",local:binding(3))] {
            do { try await journal.reserve(blocked); XCTFail("changed binding/pin escaped hold") } catch { XCTAssertEqual(error as? ClientIdentityFailure,.outcomeUnknown) }
        }
        try await journal.reserve(reservation(second.host(),installation:"inst_b",local:binding(4)))
        try await journal.reserve(reservation(first.host(),installation:"inst_a",role:.clientIOS,local:binding(5)))
        do { try await journal.saveAcknowledgement(reservation(first.host(),installation:"inst_a",local:binding(1),offer:"other_offer"),claimID:"claim_a"); XCTFail("inexact ACK") } catch { XCTAssertEqual(error as? ClientIdentityFailure,.conflict) }
        XCTAssertThrowsError(try journal.assertNoUnknownClaim(installationID:"inst_a",role:.clientMac))
        try await journal.saveAcknowledgement(a,claimID:"claim_a")
        XCTAssertNoThrow(try journal.assertNoUnknownClaim(installationID:"inst_a",role:.clientMac))
        try await FileClientClaimJournal(directory:directory).reserve(reservation(second.host(),installation:"inst_a",local:binding(6)))
        let final = try await journal.loadOnly(scope:a.scope); XCTAssertEqual(final?.claimID,"claim_a")
    }

    /// (b) Preferences can never construct authority: forged claim/device/owner fields send zero HTTP.
    func testOpusForgedPreferencesNeverReachHostOrBecomeBinding() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try IntegrationTLSFixture(identity:identity,mode:"paired-mock"); defer { fixture.close() }
        let scope = try ClientIdentityScope(installationID:"host_fixture",localBindingID:binding(7),role:.clientMac,hostFingerprint:fixture.fingerprint)
        var forged = PairedHostReference(scope:scope,host:try fixture.host(),scopes:ClientScope.allCases.sorted { $0.rawValue < $1.rawValue })
        forged.claimID = "claim_fixture"; forged.clientFingerprint = identity.fingerprint; forged.ownerID = "owner_fixture"; forged.deviceID = "device_fixture"; forged.pinGeneration = 1; forged.bindingRevision = 1
        var snapshot = PairedHostSnapshot(); snapshot.selected = forged
        for withJournalClaim in [nil,"claim_other"] as [String?] {
            let metadata = PairMetadataMemory(), keys = PairIdentityMemory(preferred:identity); metadata.bytes = try PairedStateCodec.encode(snapshot)
            if let claim = withJournalClaim {
                let r = try ClientClaimReservation(scope:scope,host:fixture.host(),offerID:"offer",clientFingerprint:identity.fingerprint)
                try await metadata.journal.reserve(r); try await metadata.journal.saveAcknowledgement(r,claimID:claim)
            }
            let controller = PairedHostOnboarding(journal:metadata.journal,storage:metadata,identityStorage:{_ in keys})
            XCTAssertNil(controller.binding); XCTAssertNil(controller.activeClient)
            let model = DexterAppModel(storage:PairedAppStateMemory(),pairing:controller); await model.connectPairedHost()
            XCTAssertNotEqual(controller.state,.paired); XCTAssertNil(controller.binding); XCTAssertNil(controller.activeClient); XCTAssertFalse(model.backendLabel.hasPrefix("Host pareado")); XCTAssertFalse(model.canUseHost)
            print("OPUS-EVIDENCE failed-paired-connect canUseHost=\(model.canUseHost) label=\(model.backendLabel)")
            XCTAssertEqual(controller.state, withJournalClaim == nil ? .outcomeUnknown : .invalidMetadata)
            let counts = await keys.counts(); XCTAssertEqual(counts,[0,0]); XCTAssertEqual(try fixture.requests(),0,"forged preferences reached host")
        }
    }

    /// (c) Own-device unknown write blocks self-revoke from Settings AND row; retained client copies stay closed.
    func testOpusOwnUnknownBlocksSelfRevokeBothEntrypointsAndRetainedCopiesStayClosed() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try IntegrationTLSFixture(identity:identity); defer { fixture.close() }
        let scope = try ClientIdentityScope(installationID:"host_fixture",localBindingID:binding(8),role:.clientMac,hostFingerprint:fixture.fingerprint)
        let bundle = try ClientPairingBundle(host:fixture.host(),installationID:scope.installationID,offerID:"offer",role:scope.role,expiresAt:Date().addingTimeInterval(300),code:String(repeating:"x",count:43))
        let paired = try PairedHostBinding(bundle:bundle,scope:scope,identity:identity,claimID:"claim",value:["protocol":"dexter-app-client-v1","status":"approved","deviceId":"device","installationId":"host_fixture","ownerId":"owner","role":"client-mac","scopes":ClientScope.legacyPairing.map(\.rawValue).sorted(),"pinGeneration":1,"bindingRevision":1])
        let own = DeviceView(id:"device",ownerId:"owner",name:"Own",platform:.macos,capabilities:[],lastSeenAt:1,revokedAt:nil,presence:.online,paired:true)
        let sender = OpusOwnDeviceSender(devices:try JSONSerialization.data(withJSONObject:["items":[try JSONSerialization.jsonObject(with:JSONEncoder().encode(own))],"nextCursor":NSNull()]))
        let client = HostClient(baseURL:fixture.url,accessPolicy:.pairedHost(paired),transport:PairedHTTPTransport(binding:paired,sender:sender)), metadata = PairMetadataMemory()
        let onboarding = PairedHostOnboarding(journal:metadata.journal,storage:metadata,identityStorage:{_ in PairIdentityMemory()}), model = DexterAppModel(client:client,storage:PairedAppStateMemory(),pairing:onboarding)
        await model.refreshDevices(); let renamed = await model.renameDevice(id:"device",name:"Ambiguous"); XCTAssertFalse(renamed)
        XCTAssertEqual(model.awaitingDeviceConfirmationIDs,["device"]); XCTAssertEqual(model.deviceError,.deviceMutationOutcomeUnknown)
        await model.revokeThisClient(); XCTAssertTrue(model.canUseHost,"Settings self-revoke ignored own unknown write")
        let row = await model.revokeDevice(id:"device"); XCTAssertFalse(row); XCTAssertTrue(model.canUseHost,"row self-revoke ignored own unknown write")
        XCTAssertEqual(model.awaitingDeviceConfirmationIDs,["device"]); XCTAssertEqual(model.deviceError,.deviceMutationOutcomeUnknown)
        let copy = client; model.disconnectPairedHost(); XCTAssertFalse(model.canUseHost)
        do { _ = try await copy.revokeOwnDevice(); XCTFail("retained copy admitted self revoke") } catch { XCTAssertTrue(error is CancellationError) }
        do { _ = try await copy.renameDevice(id:"device",name:"Late"); XCTFail("retained copy admitted rename") } catch { XCTAssertTrue(error is CancellationError) }
        let counts = await sender.counts(); XCTAssertEqual(counts,[1,0]); XCTAssertEqual(try fixture.requests(),0)
    }

    /// Liveness evidence: the archive never prunes ACKed records and refuses the 21st distinct reservation.
    func testOpusEvidenceArchiveLifetimeCapAfterTwentyAcknowledgedClaims() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try IntegrationTLSFixture(identity:identity); defer { fixture.close() }
        let directory = tempDirectory(); defer { try? FileManager.default.removeItem(at:directory) }
        let journal = FileClientClaimJournal(directory:directory), host = try fixture.host()
        for n in 0..<20 { let r = try reservation(host,installation:"inst_cap",local:binding(100+n)); try await journal.reserve(r); try await journal.saveAcknowledgement(r,claimID:"claim_\(n)") }
        XCTAssertNoThrow(try journal.assertNoUnknownClaim(installationID:"inst_cap",role:.clientMac),"no unknown exists")
        var refused: ClaimJournalAdmissionError?
        do { try await journal.reserve(reservation(host,installation:"inst_other",local:binding(999))) } catch { refused = error as? ClaimJournalAdmissionError }
        print("OPUS-EVIDENCE archive-cap 21st reservation refused=\(String(describing:refused))")
        XCTAssertEqual(refused,.capacity)
    }

    /// Liveness evidence: retained public references are never pruned; snapshot validity caps them at 20.
    func testOpusEvidencePreferencesRetainedReferenceCap() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try IntegrationTLSFixture(identity:identity); defer { fixture.close() }
        let metadata = PairMetadataMemory(), controller = PairedHostOnboarding(journal:metadata.journal,storage:metadata,identityStorage:{_ in PairIdentityMemory()})
        var firstFailure: Int?
        for n in 0..<23 { do { try controller.importBundle(offer(fixture,installation:"inst_\(n)")) } catch { firstFailure = n; break } }
        var detachFailed = false; do { try controller.detach() } catch { detachFailed = true }
        let fresh = PairedHostOnboarding(journal:metadata.journal,storage:metadata,identityStorage:{_ in PairIdentityMemory()})
        var freshImportFailed = false; do { try fresh.importBundle(offer(fixture,installation:"inst_fresh")) } catch { freshImportFailed = true }
        print("OPUS-EVIDENCE prefs-cap firstImportFailure=\(String(describing:firstFailure)) detachFailed=\(detachFailed) relaunchImportFailed=\(freshImportFailed) state=\(fresh.state)")
        XCTAssertNil(firstFailure); XCTAssertFalse(detachFailed); XCTAssertFalse(freshImportFailed); XCTAssertEqual(try fixture.requests(),0)
    }
}

extension OpusIntegrationProbeTests {
    /// Liveness evidence: a pre-wire archive refusal (cap) is persisted as a claim-outcome-unknown hold with zero HTTP.
    func testOpusEvidencePreWireCapRefusalBecomesFalseUnknownHold() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try IntegrationTLSFixture(identity:identity,mode:"paired-mock"), other = try IntegrationTLSFixture(identity:identity); defer { fixture.close(); other.close() }
        let metadata = PairMetadataMemory(), keys = PairIdentityMemory(preferred:identity)
        for n in 0..<20 { let r = try reservation(other.host(),installation:"inst_old",local:binding(300+n)); try await metadata.journal.reserve(r); try await metadata.journal.saveAcknowledgement(r,claimID:"claim_old_\(n)") }
        let controller = PairedHostOnboarding(journal:metadata.journal,storage:metadata,identityStorage:{_ in keys})
        try controller.importBundle(offer(fixture,installation:"host_fixture")); await controller.provisionIdentity(); XCTAssertEqual(controller.state,.identityReady)
        await controller.claim(name:"Synthetic cap")
        let flagged = controller.publicReference?.claimOutcomeUnknown ?? false, requests = try fixture.requests()
        let scope = try XCTUnwrap(controller.publicReference).scope(), entry = try await metadata.journal.loadOnly(scope:scope)
        var reimportBlocked = false; do { try PairedHostOnboarding(journal:metadata.journal,storage:metadata,identityStorage:{_ in keys}).importBundle(offer(fixture,installation:"host_fixture")) } catch { reimportBlocked = true }
        print("OPUS-EVIDENCE cap-claim state=\(controller.state) prefsUnknown=\(flagged) journalEntry=\(entry != nil) requests=\(requests) reimportBlocked=\(reimportBlocked)")
        XCTAssertEqual(requests,0,"no claim reached the wire"); XCTAssertNil(entry,"no reservation exists")
        XCTAssertEqual(controller.state,.admissionBlocked); XCTAssertFalse(flagged); XCTAssertFalse(reimportBlocked)
    }
}

@MainActor final class RejectingPairedStorage: PairedHostStateStorage {
    var bytes: Data?; var fail = false
    func read() -> DexterStoredState { bytes.map(DexterStoredState.data) ?? .missing }
    func write(_ data: Data) throws { if fail { throw ClientIdentityFailure.unavailable }; bytes = data }
}
extension OpusIntegrationProbeTests {
    func testResolvedExactAuthenticatedStatusReclaimsCapacityButACKAloneDoesNot() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try IntegrationTLSFixture(identity:identity,mode:"paired-mock")
        defer { fixture.close() }
        let directory = tempDirectory(); defer { try? FileManager.default.removeItem(at:directory) }
        let journal = FileClientClaimJournal(directory:directory), host = try fixture.host()
        var reservations: [ClientClaimReservation] = []
        for n in 0..<20 {
            let scope = try ClientIdentityScope(installationID:"host_fixture",localBindingID:binding(1000+n),role:.clientMac,hostFingerprint:host.fingerprint)
            let r = try ClientClaimReservation(scope:scope,host:host,offerID:"offer_\(n)",clientFingerprint:identity.fingerprint)
            try await journal.reserve(r); try await journal.saveAcknowledgement(r,claimID:"claim_\(n)"); reservations.append(r)
        }
        let next = try reservation(host,installation:"other_install",local:binding(2000))
        do { try await journal.reserve(next); XCTFail("ACK alone is not resolved authority") } catch { XCTAssertEqual(error as? ClaimJournalAdmissionError,.capacity) }
        let r = reservations[0], session = ClientPairingSession(pending:try .init(scope:r.scope,host:r.host,claimID:"claim_0"),identity:identity,journal:journal)
        let status = try await journal.statusAndResolve(session)
        guard case .approved(let approved) = status else { XCTFail("authenticated approval required"); return }
        XCTAssertEqual(approved.localBindingID,r.scope.localBindingID); XCTAssertEqual(approved.clientFingerprint,identity.fingerprint)
        await session.close().wait()
        var resolved = PairedHostReference(scope:r.scope,host:r.host,scopes:[])
        XCTAssertFalse(try journal.mayDiscardReference(resolved),"must match exact ACK and identity too")
        resolved.claimID = "claim_0"; resolved.clientFingerprint = identity.fingerprint
        XCTAssertTrue(try journal.mayDiscardReference(resolved))
        var mismatched = resolved; mismatched.claimID = "claim_different"
        XCTAssertFalse(try journal.mayDiscardReference(mismatched))
        let metadata = PairMetadataMemory(); var snapshot = PairedHostSnapshot(); snapshot.retainedReferences = [resolved]
        for n in 0..<19 {
            let unused = try reservation(host,installation:"never_claimed_\(n)",local:binding(8000+n))
            snapshot.retainedReferences.append(PairedHostReference(scope:unused.scope,host:host,scopes:[]))
        }
        XCTAssertEqual(snapshot.retainedReferences.count,20)
        metadata.bytes = try PairedStateCodec.encode(snapshot)
        let coordinator = PairedHostOnboarding(journal:journal,storage:metadata,identityStorage:{_ in PairIdentityMemory()})
        try coordinator.importBundle(offer(fixture,installation:"replacement_install"))
        let committed = try PairedStateCodec.decode(XCTUnwrap(metadata.bytes)); XCTAssertTrue(committed.retainedReferences.isEmpty)
        XCTAssertEqual(committed.selected?.installationID,"replacement_install")
        do { try await journal.reserve(next) } catch { XCTFail("resolved authenticated exact ACK must reclaim one slot: \(error)"); return }
        let absent = try await journal.loadOnly(scope:r.scope); XCTAssertNil(absent)
        let retained = try await journal.loadOnly(scope:reservations[1].scope); XCTAssertEqual(retained?.claimID,"claim_1","unverified ACK preserved")
        let held = try await journal.loadOnly(scope:next.scope); XCTAssertNil(try XCTUnwrap(held).claimID)
        XCTAssertThrowsError(try journal.assertNoUnknownClaim(installationID:"other_install",role:.clientMac))
        XCTAssertEqual(try fixture.requests(),1)
    }
    func testFullUnknownPreferencesDetachAndFailedImportKeepPersistedSnapshotAtomic() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try IntegrationTLSFixture(identity:identity)
        defer { fixture.close() }
        let directory = tempDirectory(); defer { try? FileManager.default.removeItem(at:directory) }
        let journal = FileClientClaimJournal(directory:directory), metadata = RejectingPairedStorage()
        var snapshot = PairedHostSnapshot()
        for n in 0..<21 {
            let r = try reservation(fixture.host(),installation:"inst_\(n)",local:binding(4000+n))
            var reference = PairedHostReference(scope:r.scope,host:r.host,scopes:[]); reference.claimOutcomeUnknown = true
            if n < 20 { snapshot.retainedReferences.append(reference) } else { snapshot.selected = reference }
        }
        metadata.bytes = try PairedStateCodec.encode(snapshot)
        let keys = PairIdentityMemory(), controller = PairedHostOnboarding(journal:journal,storage:metadata,identityStorage:{_ in keys})
        try controller.detach(); XCTAssertNil(controller.publicReference); XCTAssertEqual(controller.state,.disconnected)
        let persisted = try PairedStateCodec.decode(XCTUnwrap(metadata.bytes)); XCTAssertEqual(persisted.retainedReferences.count,20); XCTAssertTrue(persisted.selected?.claimOutcomeUnknown ?? false); XCTAssertEqual(persisted.detached,true)
        let before = metadata.bytes
        XCTAssertThrowsError(try controller.importBundle(offer(fixture,installation:"different_install"))) { XCTAssertEqual($0 as? ClaimJournalAdmissionError,.capacity) }
        XCTAssertEqual(metadata.bytes,before); XCTAssertNil(controller.publicReference); XCTAssertEqual(controller.state,.admissionBlocked)
        let relaunched = PairedHostOnboarding(journal:journal,storage:metadata,identityStorage:{_ in keys}); XCTAssertNil(relaunched.publicReference)
        XCTAssertThrowsError(try relaunched.importBundle(offer(fixture,installation:"inst_20")))
        let clean = RejectingPairedStorage(), fresh = PairedHostOnboarding(journal:journal,storage:clean,identityStorage:{_ in keys})
        try fresh.importBundle(offer(fixture,installation:"clean")); let previous = fresh.publicReference, previousBytes = clean.bytes
        clean.fail = true
        XCTAssertThrowsError(try fresh.importBundle(offer(fixture,installation:"changed")))
        XCTAssertEqual(fresh.publicReference,previous); XCTAssertEqual(clean.bytes,previousBytes); XCTAssertEqual(fresh.state,.readyToProvision)
        XCTAssertThrowsError(try fresh.detach()); XCTAssertEqual(fresh.publicReference,previous); XCTAssertEqual(clean.bytes,previousBytes)
        let counts = await keys.counts(); XCTAssertEqual(counts,[0,0]); XCTAssertEqual(try fixture.requests(),0)
    }
    func testSelfRevokeAmbiguousHostFailuresRemainUnknownAndExactRevokeExpectation() async throws {
        for mode in ["paired-mock-503","paired-mock-500"] {
            let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try IntegrationTLSFixture(identity:identity,mode:mode)
            defer { fixture.close() }
            let metadata = PairMetadataMemory(), keys = PairIdentityMemory(preferred:identity)
            let controller = PairedHostOnboarding(journal:metadata.journal,storage:metadata,identityStorage:{_ in keys})
            try controller.importBundle(offer(fixture,installation:"host_fixture",scopes:ClientScope.legacyPairing.map(\.rawValue).sorted()))
            await controller.provisionIdentity(); await controller.claim(name:"Synthetic revoke failure")
            let model = DexterAppModel(storage:PairedAppStateMemory(),pairing:controller)
            await model.connectPairedHost(); XCTAssertEqual(controller.state,.paired)
            await model.revokeThisClient(); XCTAssertEqual(controller.state,.outcomeUnknown); XCTAssertFalse(model.canUseHost)
            XCTAssertEqual(model.awaitingDeviceConfirmationIDs,["device_fixture"])
            XCTAssertEqual(model.deviceError,.deviceMutationOutcomeUnknown)
            XCTAssertNil(controller.binding); XCTAssertNil(controller.activeClient)
        }
    }
}
