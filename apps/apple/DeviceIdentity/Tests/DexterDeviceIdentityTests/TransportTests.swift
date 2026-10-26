import XCTest
import Foundation
@testable import DexterDeviceIdentity

private struct HostInfo:Decodable { let port:Int; let certificateDER:String; let fingerprint:String }
@MainActor private final class TLSFixture {
    let root:URL, process:Process, host:PinnedHost
    init(identity:NativeIdentity,mode:String = "normal") throws {
        guard let node = ProcessInfo.processInfo.environment["DEXTER_TEST_NODE"], node.hasPrefix("/"), FileManager.default.isExecutableFile(atPath:node) else { throw XCTSkip("Set DEXTER_TEST_NODE to an absolute Node24 executable for real TLS interop") }
        root = FileManager.default.temporaryDirectory.appendingPathComponent("dexter-native-tls-"+UUID().uuidString)
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:false,attributes:[.posixPermissions:0o700])
        let pipe = Pipe(); process = Process(); process.executableURL = URL(fileURLWithPath:node)
        let testSource = URL(fileURLWithPath:#filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Fixtures/tls-host.mjs")
        process.arguments = [testSource.path,root.path,identity.fingerprint,mode]; process.environment = [:]
        process.standardOutput = pipe; process.standardError = FileHandle.nullDevice
        do {
        try process.run()
        var line = Data()
        while line.count <= 32768 {
            guard let byte = try pipe.fileHandleForReading.read(upToCount:1), !byte.isEmpty else { throw IdentityFailure.unavailable }
            if byte.first == 10 { break }; line.append(byte)
        }
        let info = try JSONDecoder().decode(HostInfo.self,from:line)
        host = try PinnedHost(url:URL(string:"https://127.0.0.1:\(info.port)")!,certificateDER:Data(base64Encoded:info.certificateDER)!,fingerprint:info.fingerprint)
        } catch { if process.isRunning { process.terminate(); process.waitUntilExit() }; try? FileManager.default.removeItem(at:root); throw error }
    }
    func close() { if process.isRunning { process.terminate(); process.waitUntilExit() }; try? FileManager.default.removeItem(at:root) }
}

@MainActor final class TransportTests:XCTestCase {
    func testRealTLS13ClientIdentityPinsAndTwoFreshNonResumedSessions() async throws {
        let identity = try NativeIdentity.ephemeralFixture(), fixture = try TLSFixture(identity:identity); defer { fixture.close() }
        let transport = NativeDeviceTransport(identity:identity,host:fixture.host)
        for (index,route) in [DeviceRoute.pairStatus,.poll].enumerated() {
            let out = try await transport.post(route:route,body:Data("{\"fixture\":\"good\"}".utf8),timeoutSeconds:5)
            let value = try JSONSerialization.jsonObject(with:out) as! [String:Any]
            XCTAssertEqual(value["tls"] as? String,"TLSv1.3"); XCTAssertEqual(value["pinMatched"] as? Bool,true)
            XCTAssertEqual(value["resumed"] as? Bool,false); XCTAssertEqual(value["requests"] as? Int,index+1)
        }
    }
    func testPinMismatchRedirectBodyBoundsAndWrongJSONFailClosed() async throws {
        let identity = try NativeIdentity.ephemeralFixture(), fixture = try TLSFixture(identity:identity); defer { fixture.close() }
        let foreign = try NativeIdentity.ephemeralFixture()
        let wrong = try PinnedHost(url:fixture.host.url,certificateDER:foreign.certificateDER,fingerprint:foreign.fingerprint)
        do { _ = try await NativeDeviceTransport(identity:identity,host:wrong).post(route:.poll,body:Data("{}".utf8),timeoutSeconds:3); XCTFail("wrong pin accepted") } catch { XCTAssertTrue(error is IdentityFailure) }
        let transport = NativeDeviceTransport(identity:identity,host:fixture.host)
        do { _ = try await transport.post(route:.poll,body:Data("{\"fixture\":\"error\"}".utf8),timeoutSeconds:3); XCTFail("remote refusal accepted") } catch { XCTAssertEqual(error as? RemoteDeviceFailure,.forbidden); XCTAssertFalse(String(describing:error).contains("synthetic-peer-message")) }
        for mode in ["redirect","large","badjson"] {
            do { _ = try await transport.post(route:.poll,body:Data("{\"fixture\":\"\(mode)\"}".utf8),timeoutSeconds:3); XCTFail("unsafe response accepted") } catch { XCTAssertEqual(error as? IdentityFailure,.protocolError) }
        }
        let final = try await transport.post(route:.poll,body:Data("{}".utf8),timeoutSeconds:3)
        let count = try JSONSerialization.jsonObject(with:final) as! [String:Any]
        XCTAssertEqual(count["requests"] as? Int,5,"wrong pin sends no HTTP; four refused responses each occur once; no redirect follow")
    }
    func testWrongSANAndPinnedCAInsteadOfExactLeafSendNoHTTP() async throws {
        let identity = try NativeIdentity.ephemeralFixture()
        for mode in ["wrong-san","ca-pin"] {
            let fixture = try TLSFixture(identity:identity,mode:mode); defer { fixture.close() }
            do { _ = try await NativeDeviceTransport(identity:identity,host:fixture.host).post(route:.poll,body:Data("{}".utf8),timeoutSeconds:3); XCTFail("non-exact/SAN peer accepted") }
            catch { XCTAssertEqual(error as? IdentityFailure,.pinMismatch,mode) }
            XCTAssertEqual(try String(contentsOf:fixture.root.appendingPathComponent("requests.txt"),encoding:.utf8),"0")
        }
    }
    func testTLS12OnlyPeerCannotReceiveRequest() async throws {
        let identity = try NativeIdentity.ephemeralFixture(), fixture = try TLSFixture(identity:identity,mode:"tls12"); defer { fixture.close() }
        do { _ = try await NativeDeviceTransport(identity:identity,host:fixture.host).post(route:.poll,body:Data("{}".utf8),timeoutSeconds:3); XCTFail("TLS1.2 accepted") }
        catch { XCTAssertEqual(error as? IdentityFailure,.unavailable) }
        XCTAssertEqual(try String(contentsOf:fixture.root.appendingPathComponent("requests.txt"),encoding:.utf8),"0")
    }
    func testPinnedRealTLSBareLFHiddenHeaderIsRejectedWithoutRetry() async throws {
        let identity = try NativeIdentity.ephemeralFixture(), fixture = try TLSFixture(identity:identity); defer { fixture.close() }
        do { _ = try await NativeDeviceTransport(identity:identity,host:fixture.host).post(route:.poll,body:Data("{\"fixture\":\"barelf\"}".utf8),timeoutSeconds:3); XCTFail("hidden header accepted") }
        catch { XCTAssertEqual(error as? IdentityFailure,.protocolError) }
        XCTAssertEqual(try String(contentsOf:fixture.root.appendingPathComponent("requests.txt"),encoding:.utf8),"1")
    }
    func testDeadlineCancellationAndPrecancelNeverRetryOrExposeLateResponse() async throws {
        let identity = try NativeIdentity.ephemeralFixture(), fixture = try TLSFixture(identity:identity); defer { fixture.close() }
        let transport = NativeDeviceTransport(identity:identity,host:fixture.host)
        do { _ = try await transport.post(route:.poll,body:Data("{\"fixture\":\"delay\"}".utf8),timeoutSeconds:0.1); XCTFail("late result accepted") } catch { XCTAssertEqual(error as? IdentityFailure,.timeout) }
        let task = Task { try await transport.post(route:.poll,body:Data("{\"fixture\":\"delay\"}".utf8),timeoutSeconds:5) }
        try await Task.sleep(for:.milliseconds(100)); task.cancel()
        do { _ = try await task.value; XCTFail("cancelled response accepted") } catch { XCTAssertEqual(error as? IdentityFailure,.cancelled) }
        let early = Task { try await transport.post(route:.poll,body:Data("{}".utf8),timeoutSeconds:5) }; early.cancel()
        do { _ = try await early.value; XCTFail("precancelled request sent") } catch { XCTAssertEqual(error as? IdentityFailure,.cancelled) }
        try await Task.sleep(for:.milliseconds(1100))
        let out = try await transport.post(route:.poll,body:Data("{}".utf8),timeoutSeconds:5)
        let value = try JSONSerialization.jsonObject(with:out) as! [String:Any]
        XCTAssertEqual(value["requests"] as? Int,3,"timeout and cancel each sent once; precancel sent none")
    }
}
