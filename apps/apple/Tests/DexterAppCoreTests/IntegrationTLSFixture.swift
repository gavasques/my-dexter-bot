import XCTest
import Foundation
@testable import DexterClientIdentity

private struct FixtureInfo: Decodable { let port: Int, certificateDER: String, fingerprint: String, missingRejected: Int, requests: Int }
@MainActor final class IntegrationTLSFixture {
    let root: URL, process: Process, url: URL, der: Data, fingerprint: String
    let missingRejected: Int
    init(identity: ClientNativeIdentity, mode: String = "normal") throws {
        guard let node = ProcessInfo.processInfo.environment["DEXTER_TEST_NODE"], node.hasPrefix("/"), FileManager.default.isExecutableFile(atPath:node) else { throw ClientIdentityFailure.invalidInput }
        root = FileManager.default.temporaryDirectory.appendingPathComponent("dexter-client-tls-"+UUID().uuidString)
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:false,attributes:[.posixPermissions:0o700])
        process = Process(); let pipe = Pipe(); process.executableURL = URL(fileURLWithPath:node)
        let script = URL(fileURLWithPath:#filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Fixtures/paired-host.mjs")
        process.arguments = [script.path,root.path,identity.fingerprint,mode]; process.environment = [:]; process.standardOutput = pipe; process.standardError = FileHandle.nullDevice
        do {
            try process.run(); var line = Data()
            while line.count < 32768 { guard let byte = try pipe.fileHandleForReading.read(upToCount:1), !byte.isEmpty else { throw ClientIdentityFailure.unavailable }; if byte.first == 10 { break }; line.append(byte) }
            let info = try JSONDecoder().decode(FixtureInfo.self,from:line); url = URL(string:"https://127.0.0.1:\(info.port)")!; der = Data(base64Encoded:info.certificateDER)!; fingerprint = info.fingerprint; missingRejected = info.missingRejected
            XCTAssertEqual(info.requests,0,"missing identity must send zero HTTP")
        } catch { if process.isRunning { process.terminate(); process.waitUntilExit() }; try? FileManager.default.removeItem(at:root); throw error }
    }
    func host() throws -> PinnedClientHost { try .init(url:url,certificateDER:der,fingerprint:fingerprint) }
    func requests() throws -> Int {
        let text = try String(contentsOf:root.appendingPathComponent("requests.txt"),encoding:.utf8)
        guard let count = Int(text), count >= 0 else { throw ClientIdentityFailure.protocolError }; return count
    }
    func close() { if process.isRunning { process.terminate(); process.waitUntilExit() }; try? FileManager.default.removeItem(at:root) }
}
