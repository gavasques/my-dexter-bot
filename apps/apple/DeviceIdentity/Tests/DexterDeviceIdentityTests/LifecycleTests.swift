import XCTest
import Foundation
import Security
@testable import DexterDeviceIdentity

private actor FixtureStorage: IdentityStorage {
    let scope: IdentityScope
    var saved: NativeIdentity?
    var failure: IdentityFailure?
    var provisions = 0
    init(scope:IdentityScope) { self.scope = scope }
    func load(_ scope:IdentityScope) throws -> NativeIdentity? { guard scope == self.scope else { throw IdentityFailure.conflict }; if let failure { throw failure }; return saved }
    func provision(_ scope:IdentityScope) throws -> NativeIdentity {
        guard scope == self.scope, saved == nil else { throw IdentityFailure.conflict }
        if let failure { throw failure }
        provisions += 1; let value = try NativeIdentity.ephemeralFixture(); saved = value; return value
    }
    func setFailure(_ value:IdentityFailure?) { failure = value }
}
@MainActor final class LifecycleTests: XCTestCase {
    func testLoadMissingNeverCreatesAndExplicitProvisionIsStableAcrossLifecycleRestart() async throws {
        let scope = try IdentityScope(installationID:"synthetic-installation"), store = FixtureStorage(scope:scope)
        let first = IdentityLifecycle(scope:scope,storage:store)
        do { _ = try await first.loadOnly(); XCTFail("missing load accepted") } catch { XCTAssertEqual(error as? IdentityFailure,.missing) }
        let initialCount = await store.provisions; XCTAssertEqual(initialCount,0)
        let initial = try await first.provisionExplicitly()
        let second = IdentityLifecycle(scope:scope,storage:store)
        let loaded = try await second.loadOnly(); XCTAssertEqual(loaded.certificateDER,initial.certificateDER); XCTAssertEqual(loaded.fingerprint,initial.fingerprint)
        do { _ = try await second.provisionExplicitly(); XCTFail("duplicate provision accepted") } catch { XCTAssertEqual(error as? IdentityFailure,.conflict) }
        let count = await store.provisions; XCTAssertEqual(count,1)
        XCTAssertEqual(initial.policy,"ephemeral_fixture_only"); XCTAssertFalse(String(describing:initial).contains("PRIVATE"))
    }
    func testLockedAndIncompleteFailWithoutRegenerationAndScopeMismatchRefuses() async throws {
        let scope = try IdentityScope(installationID:"synthetic-installation"), store = FixtureStorage(scope:scope)
        let lifecycle = IdentityLifecycle(scope:scope,storage:store)
        for failure in [IdentityFailure.locked,.conflict,.unavailable] {
            await store.setFailure(failure)
            do { _ = try await lifecycle.loadOnly(); XCTFail("failed storage accepted") } catch { XCTAssertEqual(error as? IdentityFailure,failure) }
            do { _ = try await lifecycle.provisionExplicitly(); XCTFail("failed storage provisioned") } catch { XCTAssertEqual(error as? IdentityFailure,failure) }
        }
        let count = await store.provisions; XCTAssertEqual(count,0)
        let foreign = IdentityLifecycle(scope:try IdentityScope(installationID:"another-installation"),storage:store)
        do { _ = try await foreign.loadOnly(); XCTFail("scope mismatch accepted") } catch { XCTAssertEqual(error as? IdentityFailure,.conflict) }
    }
    func testConcurrentProvisionHasOneWinnerAndNeverRotatesTheWinner() async throws {
        let scope = try IdentityScope(installationID:"synthetic-installation"), store = FixtureStorage(scope:scope)
        let lifecycle = IdentityLifecycle(scope:scope,storage:store)
        let successes = await withTaskGroup(of:Bool.self,returning:Int.self) { group in
            for _ in 0..<8 { group.addTask { do { _ = try await lifecycle.provisionExplicitly(); return true } catch { return false } } }
            var count = 0; for await result in group { if result { count += 1 } }; return count
        }
        XCTAssertEqual(successes,1); let count = await store.provisions; XCTAssertEqual(count,1)
        _ = try await lifecycle.loadOnly()
    }
    func testNamespaceIsFixedAndLabOnlyRemovalRefusesProductionBeforeAnyKeychainCall() async throws {
        let one = try IdentityScope(installationID:"synthetic-installation"), same = try IdentityScope(installationID:"synthetic-installation")
        let two = try IdentityScope(installationID:"other-installation"), lab = try IdentityScope(installationID:"synthetic-installation",laboratoryID:String(repeating:"a",count:32))
        XCTAssertEqual(one,same); XCTAssertNotEqual(one.tag,two.tag); XCTAssertNotEqual(one.tag,lab.tag)
        XCTAssertTrue(String(decoding:one.tag,as:UTF8.self).hasPrefix("com.dexter.device-identity.v1."))
        XCTAssertThrowsError(try IdentityScope(installationID:"../foreign")); XCTAssertThrowsError(try IdentityScope(installationID:"ok",laboratoryID:"not-random-lab"))
        do { try await KeychainIdentityStorage(scope:one).removeLaboratoryItems(); XCTFail("production cleanup allowed") } catch { XCTAssertEqual(error as? IdentityFailure,.invalidInput) }
    }
    func testCertificatePublicInteropAndMismatchedPrivateKeyRefused() throws {
        let identity = try NativeIdentity.ephemeralFixture()
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("dexter-identity-public-"+UUID().uuidString)
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:false,attributes:[.posixPermissions:0o700]); defer { try? FileManager.default.removeItem(at:root) }
        let pem = root.appendingPathComponent("certificate.pem"); try Data(identity.certificatePEM.utf8).write(to:pem)
        let process = Process(); process.executableURL = URL(fileURLWithPath:"/usr/bin/openssl"); process.arguments = ["x509","-in",pem.path,"-noout","-text"]
        process.environment = [:]; let diagnostic = Pipe(); process.standardOutput = diagnostic; process.standardError = diagnostic
        try process.run(); process.waitUntilExit(); let publicDiagnostic = String(decoding:diagnostic.fileHandleForReading.readDataToEndOfFile(),as:UTF8.self); XCTAssertEqual(process.terminationStatus,0,publicDiagnostic); XCTAssertTrue(publicDiagnostic.contains("CA:FALSE")); XCTAssertTrue(publicDiagnostic.contains("TLS Web Client Authentication")); XCTAssertTrue(publicDiagnostic.contains("ecdsa-with-SHA256"))
        if let node = ProcessInfo.processInfo.environment["DEXTER_TEST_NODE"] {
            let check = Process(); check.executableURL = URL(fileURLWithPath:node); check.environment = [:]
            check.arguments = ["--input-type=module","-e","import crypto from 'node:crypto';const c=new crypto.X509Certificate(Buffer.from(process.argv[1],'base64'));if(!c.verify(c.publicKey)||c.ca||!c.keyUsage.includes('1.3.6.1.5.5.7.3.2'))process.exit(2)",identity.certificateDER.base64EncodedString()]
            check.standardOutput = FileHandle.nullDevice; check.standardError = FileHandle.nullDevice; try check.run(); check.waitUntilExit(); XCTAssertEqual(check.terminationStatus,0)
        }
        var error:Unmanaged<CFError>?
        let other = SecKeyCreateRandomKey([kSecAttrKeyType:kSecAttrKeyTypeECSECPrimeRandom,kSecAttrKeySizeInBits:256] as CFDictionary,&error)!
        XCTAssertThrowsError(try NativeIdentity(key:other,certificate:identity.certificate,policy:"fixture"))
    }
    func testRoutesAndTrustRejectUnpinnedOrArbitraryHostConfiguration() throws {
        let identity = try NativeIdentity.ephemeralFixture()
        let pin = identity.fingerprint
        for text in ["http://127.0.0.1","https://user:pass@host/","https://host/path","https://host/?token=1","https://host/#x","https://host:0"] {
            XCTAssertThrowsError(try PinnedHost(url:URL(string:text)!,certificateDER:identity.certificateDER,fingerprint:pin))
        }
        XCTAssertThrowsError(try PinnedHost(url:URL(string:"https://127.0.0.1")!,certificateDER:identity.certificateDER,fingerprint:String(repeating:"0",count:64)))
        XCTAssertEqual(Set(DeviceRoute.allCases.map(\.rawValue)),Set(["/v1/pair/claim","/v1/pair/status","/v1/device/poll","/v1/device/receipt"]))
        XCTAssertNil(DeviceRoute(rawValue:"/admin"))
    }
}
