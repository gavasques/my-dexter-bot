import XCTest
import Foundation
import Security
import Network
@testable import DexterDeviceIdentity

private actor SpyStorage: IdentityStorage {
    var reads = 0
    var provisions = 0
    func load(_ scope:IdentityScope) throws -> NativeIdentity? { reads += 1; throw IdentityFailure.locked }
    func provision(_ scope:IdentityScope) throws -> NativeIdentity { provisions += 1; throw IdentityFailure.locked }
}
private actor ReplaceableStorage: IdentityStorage {
    var identity: NativeIdentity
    var reads = 0
    var provisions = 0
    init(_ identity:NativeIdentity) { self.identity = identity }
    func replace(_ identity:NativeIdentity) { self.identity = identity }
    func load(_ scope:IdentityScope) -> NativeIdentity? { reads += 1; return identity }
    func provision(_ scope:IdentityScope) throws -> NativeIdentity { provisions += 1; throw IdentityFailure.conflict }
}
private struct RequestHostInfo:Decodable { let port:Int; let certificateDER:String; let fingerprint:String }
@MainActor private final class RequestTLSFixture {
    let root:URL, process:Process, host:PinnedHost
    init(identity:NativeIdentity) throws {
        guard let node = ProcessInfo.processInfo.environment["DEXTER_TEST_NODE"], node.hasPrefix("/"), FileManager.default.isExecutableFile(atPath:node) else { throw XCTSkip("Set DEXTER_TEST_NODE for real ephemeral TLS request binding") }
        root = FileManager.default.temporaryDirectory.appendingPathComponent("dexter-request-binding-"+UUID().uuidString)
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:false,attributes:[.posixPermissions:0o700])
        let pipe = Pipe(); process = Process(); process.executableURL = URL(fileURLWithPath:node)
        let source = URL(fileURLWithPath:#filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Fixtures/request-binding-host.mjs")
        process.arguments = [source.path,root.path,identity.fingerprint,"normal"]; process.environment = [:]
        process.standardOutput = pipe; process.standardError = FileHandle.nullDevice
        do {
            try process.run(); var line = Data()
            while line.count <= 32768 {
                guard let byte = try pipe.fileHandleForReading.read(upToCount:1), !byte.isEmpty else { throw IdentityFailure.unavailable }
                if byte.first == 10 { break }; line.append(byte)
            }
            let info = try JSONDecoder().decode(RequestHostInfo.self,from:line)
            host = try PinnedHost(url:URL(string:"https://127.0.0.1:\(info.port)")!,certificateDER:Data(base64Encoded:info.certificateDER)!,fingerprint:info.fingerprint)
        } catch { if process.isRunning { process.terminate(); process.waitUntilExit() }; try? FileManager.default.removeItem(at:root); throw error }
    }
    func close() { if process.isRunning { process.terminate(); process.waitUntilExit() }; try? FileManager.default.removeItem(at:root) }
    func connections() throws -> String { try String(contentsOf:root.appendingPathComponent("connections.txt"),encoding:.utf8) }
    func requests() throws -> String { try String(contentsOf:root.appendingPathComponent("requests.txt"),encoding:.utf8) }
}
@MainActor final class RequestTests:XCTestCase {
    func testExpectedClientFingerprintRejectsIdentitySwapBeforeTLSAndUsesSameIdentityAcrossRequests() async throws {
        let identity = try NativeIdentity.ephemeralFixture(), replacement = try NativeIdentity.ephemeralFixture()
        let store = ReplaceableStorage(identity), scope = try IdentityScope(installationID:"synthetic-binding"), lifecycle = IdentityLifecycle(scope:scope,storage:store)
        let loaded = try await lifecycle.loadOnly(), fixture = try RequestTLSFixture(identity:identity); defer { fixture.close() }
        let request = try PreparedDeviceRequest(route:DeviceRoute.poll.rawValue,bodyBase64:Data("{}".utf8).base64EncodedString(),hostURL:fixture.host.url.absoluteString,
            hostCertificateDER:fixture.host.certificateDER.base64EncodedString(),hostFingerprint:fixture.host.fingerprint,timeoutSeconds:5,expectedClientFingerprint:loaded.fingerprint)
        await store.replace(replacement)
        do { _ = try await request.perform(lifecycle:lifecycle); XCTFail("identity swap reached transport") } catch { XCTAssertEqual(error as? IdentityFailure,.conflict) }
        XCTAssertEqual(try fixture.requests(),"0","changed identity must send no HTTP")
        XCTAssertEqual(try fixture.connections(),"0","changed identity must open no TCP/TLS connection")
        await store.replace(identity)
        for count in 1...2 {
            let output = try await request.perform(lifecycle:lifecycle), result = try JSONSerialization.jsonObject(with:output) as! [String:Any]
            XCTAssertEqual(result["tls"] as? String,"TLSv1.3"); XCTAssertEqual(result["requests"] as? Int,count)
        }
        XCTAssertEqual(try fixture.connections(),"2","the same identity must use two fresh connections")
        let reads = await store.reads, provisions = await store.provisions
        XCTAssertEqual(reads,4); XCTAssertEqual(provisions,0); XCTAssertEqual(loaded.fingerprint,identity.fingerprint)
    }

    func testMalformedFullRequestNeverAccessesIdentityStorage() async throws {
        let identity = try NativeIdentity.ephemeralFixture(), scope = try IdentityScope(installationID:"synthetic"), store = SpyStorage()
        let lifecycle = IdentityLifecycle(scope:scope,storage:store)
        struct Input { var route:String? = DeviceRoute.poll.rawValue; var body:String? = Data("{}".utf8).base64EncodedString(); var url:String? = "https://127.0.0.1"; var cert:String?; var pin:String?; var timeout:Double? = 1; var expected:String? }
        let base = Input(cert:identity.certificateDER.base64EncodedString(),pin:identity.fingerprint,expected:identity.fingerprint)
        var cases:[Input] = []
        var c = base; c.route = nil; cases.append(c); c = base; c.route = "/admin"; cases.append(c)
        c = base; c.body = "%%%"; cases.append(c); c = base; c.body = Data("[]".utf8).base64EncodedString(); cases.append(c)
        c = base; c.body = Data("invalid".utf8).base64EncodedString(); cases.append(c)
        c = base; c.body = Data(repeating:65,count:65537).base64EncodedString(); cases.append(c)
        c = base; c.url = nil; cases.append(c); c = base; c.url = "http://127.0.0.1"; cases.append(c)
        c = base; c.cert = "%%%"; cases.append(c); c = base; c.pin = nil; cases.append(c)
        c = base; c.timeout = .nan; cases.append(c); c = base; c.timeout = 121; cases.append(c); c = base; c.timeout = 0; cases.append(c)
        c = base; c.expected = nil; cases.append(c)
        for fingerprint in ["",String(repeating:"a",count:63),String(repeating:"a",count:65),String(repeating:"A",count:64),String(repeating:"g",count:64),identity.fingerprint+"\n"] { c = base; c.expected = fingerprint; cases.append(c) }
        for input in cases {
            do { _ = try await PreparedDeviceRequest.execute(lifecycle:lifecycle,route:input.route,bodyBase64:input.body,hostURL:input.url,hostCertificateDER:input.cert,hostFingerprint:input.pin,timeoutSeconds:input.timeout,expectedClientFingerprint:input.expected); XCTFail("malformed request reached storage")
            } catch { XCTAssertEqual(error as? IdentityFailure,.invalidInput) }
        }
        let reads = await store.reads, provisions = await store.provisions; XCTAssertEqual(reads,0); XCTAssertEqual(provisions,0)
        let valid = try PreparedDeviceRequest(route:base.route,bodyBase64:base.body,hostURL:base.url,hostCertificateDER:base.cert,hostFingerprint:base.pin,timeoutSeconds:base.timeout,expectedClientFingerprint:base.expected)
        do { _ = try await valid.perform(lifecycle:lifecycle); XCTFail("locked fixture succeeded") } catch { XCTAssertEqual(error as? IdentityFailure,.locked) }
        let finalReads = await store.reads; XCTAssertEqual(finalReads,1)
    }
    func testStorageMetadataRejectsWeakerOrSynchronizableKeysWithoutKeychain() throws {
        let good:[CFString:Any] = [kSecAttrAccessible:kSecAttrAccessibleWhenUnlockedThisDeviceOnly,kSecAttrSynchronizable:false]
        XCTAssertNoThrow(try KeychainIdentityStorage.checkStorageAttributes(good))
        for attributes in [[kSecAttrAccessible:kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly],[:],
            [kSecAttrAccessible:kSecAttrAccessibleWhenUnlockedThisDeviceOnly,kSecAttrSynchronizable:true],
            [kSecAttrAccessible:kSecAttrAccessibleWhenUnlockedThisDeviceOnly,kSecAttrSynchronizable:"invalid"]] as [[CFString:Any]] {
            XCTAssertThrowsError(try KeychainIdentityStorage.checkStorageAttributes(attributes)) { XCTAssertEqual($0 as? IdentityFailure,.conflict) }
        }
    }
    func testActualPolicyApplicationDisablesResumptionAndTrustFallback() {
        var versions:[tls_protocol_version_t] = [], reuse:[Bool] = [], tickets:[Bool] = [], early:[Bool] = []
        TransportSecurityPolicy.configureProtocol(minimum:{versions.append($0)},maximum:{versions.append($0)},resumption:{reuse.append($0)},tickets:{tickets.append($0)},falseStart:{early.append($0)})
        XCTAssertEqual(versions,[.TLSv13,.TLSv13]); XCTAssertEqual(reuse,[false]); XCTAssertEqual(tickets,[false]); XCTAssertEqual(early,[false])
        var only:[Bool] = [], fetch:[Bool] = []
        XCTAssertTrue(TransportSecurityPolicy.configureTrust(anchorOnly:{ only.append($0); return errSecSuccess },networkFetch:{ fetch.append($0); return errSecSuccess }))
        XCTAssertEqual(only,[true]); XCTAssertEqual(fetch,[false])
        XCTAssertFalse(TransportSecurityPolicy.configureTrust(anchorOnly:{_ in errSecParam},networkFetch:{_ in XCTFail("fetch after failed anchor policy"); return errSecSuccess}))
    }
    func testHostnameSyntaxIsValidatedWithoutDNS() throws {
        let identity = try NativeIdentity.ephemeralFixture()
        for name in ["-bad-..","bad..host","host-","a"+String(repeating:"b",count:63),"[::::]","bad_host"] {
            XCTAssertThrowsError(try PinnedHost(url:URL(string:"https://\(name)")!,certificateDER:identity.certificateDER,fingerprint:identity.fingerprint))
        }
        for name in ["localhost","127.0.0.1","[::1]","host.example"] { XCTAssertNoThrow(try PinnedHost(url:URL(string:"https://\(name)")!,certificateDER:identity.certificateDER,fingerprint:identity.fingerprint)) }
    }
}
